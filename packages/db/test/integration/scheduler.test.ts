import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { advisoryLockKey } from "../../src/advisory-lock"
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type SqlConnection,
} from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { createSchedulerLockPool, type SchedulerLockPoolHandle } from "../../src/scheduler-lock"
import { scheduledTaskRuns } from "../../src/schema/scheduled-task-runs"

/**
 * `pg_try_advisory_lock` is the whole of the scheduler's leader election
 * (CLAUDE.md non-negotiable 13, `src/advisory-lock.ts`), and whether it
 * actually excludes a second concurrent holder — rather than merely compiling
 * a call that looks like it would — is a question only a real Postgres session
 * answers. A unit test can inject a `TaskLock` that always says yes or no; it
 * cannot prove the two-connection race the runner depends on in production.
 *
 * A lock name unique to this run, not one of the four real `scheduled_task`
 * values, so a `bin/dev` process pointed at the same shared dev database can
 * never contend with — or be mistaken for — these tests. Rows are still
 * written as `janitor_sweep` (a real enum member is required), but every
 * assertion below filters to the ids these tests themselves created.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and
// `bin/test` names this file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const MARKER = new Date("1999-06-15T00:00:00.000Z")

async function lockPids(sql: SqlConnection, key: number): Promise<number[]> {
  const rows = await sql<{ readonly pid: number }[]>`
    select pid
    from pg_locks
    where locktype = ${"advisory"}
      and granted
      and objsubid = 2
      and classid::text = ${String(0x726f_7574)}
      and objid::text = ${String(key >>> 0)}
      and database = (select oid from pg_database where datname = current_database())
  `
  return rows.map((row) => row.pid)
}

let handle: DatabaseHandle | undefined
let lock: SchedulerLockPoolHandle | undefined
let contenderLock: SchedulerLockPoolHandle | undefined
let db: Database
const runIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 4 })
  lock = createSchedulerLockPool({ url, maxConnections: 4 })
  contenderLock = createSchedulerLockPool({ url, maxConnections: 1 })
  db = handle.db
})

afterAll(async () => {
  if (handle !== undefined && runIds.length > 0) {
    await db.delete(scheduledTaskRuns).where(inArray(scheduledTaskRuns.id, runIds))
  }
  await lock?.close()
  await contenderLock?.close()
  await handle?.close()
})

describe.skipIf(!runnable)("advisory lock contention against a live database", () => {
  test("two concurrent holders of the same key: exactly one acquires, exactly one run row", async () => {
    const lockPool = lock
    const peerLock = contenderLock
    if (handle === undefined || lockPool === undefined || peerLock === undefined)
      throw new Error("unreachable: describe.skipIf gates this")
    const repo = createScheduledTaskRepository(db)
    const key = advisoryLockKey(`test-scheduler-contention-${crypto.randomUUID()}`)

    const runOnce = async (
      sessionLock: SchedulerLockPoolHandle,
    ): Promise<{ acquired: boolean; id?: string }> => {
      const run = await sessionLock.tryRun(key, new AbortController().signal, async () => {
        const id = await repo.begin("janitor_sweep", MARKER)
        // Hold the lock long enough that the other concurrent call is
        // guaranteed to observe it taken, not win a race against an empty gap.
        await new Promise((resolve) => setTimeout(resolve, 100))
        await repo.finish(id, { outcome: "success", itemsProcessed: 1 }, MARKER)
        return id
      })
      return run.acquired ? { acquired: true, id: run.value } : { acquired: false }
    }
    const [a, b] = await Promise.all([runOnce(lockPool), runOnce(peerLock)])
    const winners = [a, b].filter((result) => result.acquired)
    expect(winners).toHaveLength(1)

    const id = winners[0]?.id
    if (id !== undefined) runIds.push(id)

    const ids = winners.map((w) => w.id).filter((value): value is string => value !== undefined)
    const rows = await db.select().from(scheduledTaskRuns).where(inArray(scheduledTaskRuns.id, ids))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe("success")
  })

  test("a released lock lets the very next tick acquire it again", async () => {
    const lockPool = lock
    if (handle === undefined || lockPool === undefined)
      throw new Error("unreachable: describe.skipIf gates this")
    const observer = handle.sql
    const repo = createScheduledTaskRepository(db)
    const key = advisoryLockKey(`test-scheduler-sequential-${crypto.randomUUID()}`)

    const runOnce = async (): Promise<boolean> => {
      const run = await lockPool.tryRun(key, new AbortController().signal, async () => {
        const id = await repo.begin("janitor_sweep", MARKER)
        await repo.finish(id, { outcome: "success", itemsProcessed: 1 }, MARKER)
        runIds.push(id)
      })
      expect(await lockPids(observer, key)).toHaveLength(0)
      return run.acquired
    }

    // Sequential, not concurrent: proves successful session cleanup releases the lock rather than
    // leaving it on the dedicated session until the pool closes.
    expect(await runOnce()).toBe(true)
    expect(await runOnce()).toBe(true)
    expect(await runOnce()).toBe(true)
  })

  test("a failed callback releases the lock before the next tick", async () => {
    const lockPool = lock
    if (handle === undefined || lockPool === undefined)
      throw new Error("unreachable: describe.skipIf gates this")
    const observer = handle.sql
    const key = advisoryLockKey(`test-scheduler-failure-${crypto.randomUUID()}`)
    const failure = new Error("scheduled task failed")

    await expect(
      lockPool.tryRun(key, new AbortController().signal, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await lockPids(observer, key)).toHaveLength(0)
    expect(
      await lockPool.tryRun(key, new AbortController().signal, async () => "next tick"),
    ).toEqual({ acquired: true, value: "next tick" })
    expect(await lockPids(observer, key)).toHaveLength(0)
  })

  test("distinct keys complete concurrently at small dedicated-pool capacity", async () => {
    const lockPool = createSchedulerLockPool({
      url,
      maxConnections: 2,
      closeTimeoutSeconds: 0.1,
    })
    const release = Promise.withResolvers<void>()
    const firstEntered = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const watchdog = Promise.withResolvers<never>()
    // Real-clock deadline makes a cleanup deadlock fail rather than hang the integration suite.
    const timer = setTimeout(
      () => watchdog.reject(new Error("distinct-key session locks did not settle")),
      4_000,
    )
    const first = lockPool.tryRun(
      advisoryLockKey(`test-scheduler-distinct-a-${crypto.randomUUID()}`),
      new AbortController().signal,
      async () => {
        firstEntered.resolve()
        await release.promise
        return true
      },
    )
    const second = lockPool.tryRun(
      advisoryLockKey(`test-scheduler-distinct-b-${crypto.randomUUID()}`),
      new AbortController().signal,
      async () => {
        secondEntered.resolve()
        await release.promise
        return true
      },
    )
    try {
      await Promise.race([
        Promise.all([firstEntered.promise, secondEntered.promise]),
        watchdog.promise,
      ])
      release.resolve()
      const [firstResult, secondResult] = await Promise.race([
        Promise.all([first, second]),
        watchdog.promise,
      ])
      expect(firstResult.acquired).toBe(true)
      expect(secondResult.acquired).toBe(true)
    } finally {
      clearTimeout(timer)
      release.resolve()
      await lockPool.close()
    }
  })
})
