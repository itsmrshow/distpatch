import { beforeAll, describe, expect, test } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import type { DatabaseHandle } from "../../src/client"
import { createUsageRecentRepository } from "../../src/repositories/usage-recent-repository"
import {
  createUsageRecordRepository,
  USAGE_RECORD_MAX_STATEMENT_ROWS,
  type UsageRecordInsert,
} from "../../src/repositories/usage-repository"
import { apiKeys } from "../../src/schema/api-keys"
import { usageRecords } from "../../src/schema/usage-records"
import { usageHistoryFixture } from "./usage-history-fixture"

const url = process.env.DATABASE_URL ?? ""
const fixture = usageHistoryFixture()
let handle: DatabaseHandle
const ids: string[] = []
function event(over: Partial<UsageRecordInsert> = {}): UsageRecordInsert {
  const id = crypto.randomUUID()
  ids.push(id)
  return {
    id,
    correlationId: crypto.randomUUID(),
    model: null,
    upstreamModel: null,
    responseStatus: 401,
    httpStatus: null,
    outcome: "client_error",
    createdAt: new Date("1998-01-01"),
    ...over,
  }
}
beforeAll(async () => {
  if (!url) return
  handle = fixture.get()
})

describe.skipIf(!url)("stable usage event identity", () => {
  test("retry after acknowledged commit loss keeps one row per event, not per correlation", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const first = event()
    const second = event({ correlationId: first.correlationId, attempt: 2, responseStatus: 502 })
    const batch = [first, second]
    const commitThenLoseAck = async () => {
      await repo.insertMany(batch)
      throw new Error("ack lost")
    }
    await expect(commitThenLoseAck()).rejects.toThrow("ack lost")
    expect(await repo.insertMany(batch)).toBe(0)
    const persisted = await handle.db
      .select()
      .from(usageRecords)
      .where(
        inArray(
          usageRecords.id,
          batch.map((row) => row.id),
        ),
      )
    expect(persisted).toHaveLength(2)
    expect(persisted.map((row) => row.responseStatus).sort()).toEqual([401, 502])
    const recent = await createUsageRecentRepository(handle.db).recent({
      requestId: first.correlationId,
      limit: 10,
    })
    expect(recent).toHaveLength(2)
    expect(
      recent.every(
        (row) => row.model === null && row.upstreamModel === null && row.httpStatus === null,
      ),
    ).toBe(true)
  })
  test("a fully populated 2340-row flush persists through PostgreSQL's real bind protocol", async () => {
    // 2340 is the largest accepted USAGE_BATCH_SIZE; it needs a full 2259-row statement and a
    // second one, both inside one transaction.
    expect(2340).toBeGreaterThan(USAGE_RECORD_MAX_STATEMENT_ROWS)
    const rows = Array.from({ length: 2340 }, () => ({
      ...event(),
      clientRequestId: null,
      attempt: 1,
      apiKeyId: null,
      accountId: null,
      poolId: null,
      provider: null,
      sessionKey: null,
      selectedModel: null,
      ingressDialect: null,
      egressMode: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costEstimate: null,
      costBasis: "unknown" as const,
      latencyMs: 0,
      ttfbMs: null,
      routerOverheadMs: 0,
      streamed: false,
      errorClass: null,
    }))
    const repo = createUsageRecordRepository(handle.db)
    expect(await repo.insertMany(rows)).toBe(2340)
    const persisted = await handle.db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(
        inArray(
          usageRecords.id,
          rows.map((row) => row.id),
        ),
      )
    expect(persisted).toHaveLength(2340)
    // Replaying the whole flush (acknowledgment lost) admits nothing twice.
    expect(await repo.insertMany(rows)).toBe(0)
  })
  test("duplicate identity never replaces the original facts", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const original = event({ tokensIn: 7 })
    expect(await repo.insertMany([original])).toBe(1)
    await expect(
      repo.insertMany([{ ...original, tokensIn: 999, responseStatus: 200 }]),
    ).rejects.toThrow("immutable usage identity")
    const [persisted] = await handle.db
      .select()
      .from(usageRecords)
      .where(inArray(usageRecords.id, [original.id]))
    expect(persisted?.tokensIn).toBe(7)
    expect(persisted?.responseStatus).toBe(401)
  })
  test("a replay after subject deletion preserves immutable historical attribution", async () => {
    const [key] = await handle.db
      .insert(apiKeys)
      .values({ name: "usage-retry", value: crypto.randomUUID(), prefix: "fixture" })
      .returning()
    if (!key) throw new Error("missing fixture key")
    try {
      const repo = createUsageRecordRepository(handle.db)
      const row = event({ apiKeyId: key.id })
      expect(await repo.insertMany([row])).toBe(1)
      await handle.db.delete(apiKeys).where(eq(apiKeys.id, key.id))
      expect(await repo.insertMany([row])).toBe(0)
      const [persisted] = await handle.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.id, row.id))
      expect(persisted?.apiKeyId).toBe(key.id)
    } finally {
      await handle.db.delete(apiKeys).where(eq(apiKeys.id, key.id))
    }
  })
  test("primary-key suppression does not swallow real numeric constraint violations", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const valid = event(),
      invalid = event({ tokensIn: 2147483648 })
    await expect(repo.insertMany([valid, invalid])).rejects.toMatchObject({
      cause: { code: "22003" },
    })
    const persisted = await handle.db
      .select()
      .from(usageRecords)
      .where(inArray(usageRecords.id, [valid.id, invalid.id]))
    expect(persisted).toHaveLength(0)
  })
  test("upgrade preserves old model/status facts and makes only new facts nullable", async () => {
    const schema = `usage_upgrade_${crypto.randomUUID().replaceAll("-", "")}`
    await handle.sql.unsafe(`CREATE SCHEMA "${schema}"`)
    try {
      await handle.sql.unsafe(
        `CREATE TABLE "${schema}".usage_records (id uuid PRIMARY KEY, model text NOT NULL, http_status integer)`,
      )
      const id = crypto.randomUUID()
      await handle.sql.unsafe(`INSERT INTO "${schema}".usage_records VALUES ($1, 'legacy', 503)`, [
        id,
      ])
      const migration = await Bun.file(
        new URL("../../migrations/0029_usage_event_status.sql", import.meta.url),
      ).text()
      for (const statement of migration.split("--> statement-breakpoint"))
        await handle.sql.unsafe(
          statement.replaceAll('"usage_records"', `"${schema}"."usage_records"`),
        )
      const [old] = await handle.sql.unsafe<
        { model: string; http_status: number; response_status: number | null }[]
      >(`SELECT model,http_status,response_status FROM "${schema}".usage_records`)
      expect(old).toEqual({ model: "legacy", http_status: 503, response_status: null })
      await handle.sql.unsafe(
        `INSERT INTO "${schema}".usage_records VALUES ($1, NULL, NULL, 401)`,
        [crypto.randomUUID()],
      )
      const [count] = await handle.sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::integer AS count FROM "${schema}".usage_records`,
      )
      expect(count?.count).toBe(2)
    } finally {
      await handle.sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
    }
  })
  test("selected_model persists for virtual requests and stays NULL for fixed ones", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const virtual = event({
      model: "auto-task",
      selectedModel: "alpha",
      upstreamModel: "alpha-wire",
    })
    const fixed = event({ model: "claude-opus-5", upstreamModel: "claude-opus-5" })
    expect(await repo.insertMany([virtual, fixed])).toBe(2)
    const persisted = await handle.db
      .select({
        id: usageRecords.id,
        model: usageRecords.model,
        selectedModel: usageRecords.selectedModel,
        upstreamModel: usageRecords.upstreamModel,
      })
      .from(usageRecords)
      .where(inArray(usageRecords.id, [virtual.id, fixed.id]))
    expect(new Map(persisted.map((row) => [row.id, row]))).toEqual(
      new Map([
        [
          virtual.id,
          {
            id: virtual.id,
            model: "auto-task",
            selectedModel: "alpha",
            upstreamModel: "alpha-wire",
          },
        ],
        [
          fixed.id,
          {
            id: fixed.id,
            model: "claude-opus-5",
            selectedModel: null,
            upstreamModel: "claude-opus-5",
          },
        ],
      ]),
    )
  })
  test("0039 adds selected_model without touching or back-filling existing rows", async () => {
    const schema = `usage_selected_${crypto.randomUUID().replaceAll("-", "")}`
    await handle.sql.unsafe(`CREATE SCHEMA "${schema}"`)
    try {
      await handle.sql.unsafe(
        `CREATE TABLE "${schema}".usage_records (id uuid PRIMARY KEY, model text, upstream_model text)`,
      )
      const id = crypto.randomUUID()
      await handle.sql.unsafe(
        `INSERT INTO "${schema}".usage_records VALUES ($1, 'sonnet', 'glm-4.7')`,
        [id],
      )
      const migration = await Bun.file(
        new URL("../../migrations/0039_selected_model.sql", import.meta.url),
      ).text()
      await handle.sql.unsafe(
        migration.replaceAll('"usage_records"', `"${schema}"."usage_records"`),
      )
      const rows = await handle.sql.unsafe<
        { model: string; upstream_model: string; selected_model: string | null }[]
      >(`SELECT model, upstream_model, selected_model FROM "${schema}".usage_records`)
      expect(rows).toEqual([{ model: "sonnet", upstream_model: "glm-4.7", selected_model: null }])
    } finally {
      await handle.sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
    }
  })
})
