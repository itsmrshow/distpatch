import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import {
  AdvisoryLockSessionLostError,
  advisoryLockKey,
  createCapabilityIntelligenceRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import {
  compileAndPublishCapabilitySnapshot,
  syncCapabilityIntelligence,
} from "../../src/services/capabilities/intelligence/lifecycle"

const configuredUrl = process.env.DATABASE_URL ?? ""
const databaseName = `cap_sync_${crypto.randomUUID().replaceAll("-", "")}`
const bootstrap = {
  schemaVersion: 1 as const,
  revision: "2026-10-21.1",
  profiles: [{ id: "anthropic/claude-sonnet-4-6" }],
}
let admin: DatabaseHandle | undefined
let handle: DatabaseHandle | undefined
let repository: ReturnType<typeof createCapabilityIntelligenceRepository>

function observation(input: {
  key: string
  sourceModelId: string
  canonicalModelId: string | null
  rawValue: number
  observedAt: Date
}) {
  return {
    source: "artificial-analysis",
    sourceModelId: input.sourceModelId,
    canonicalModelId: input.canonicalModelId,
    metric: "intelligence_index",
    rawValue: input.rawValue,
    unit: "index_100",
    benchmark: "artificial_analysis_intelligence_index",
    benchmarkVersion: "sync-test-v1",
    fingerprint: `fp:${input.key}`,
    observedAt: input.observedAt,
    ingestedAt: input.observedAt,
    sourceRef: `https://example.invalid/${input.key}`,
    provenance: { fixture: input.key },
  }
}

function evidenceSource(
  row: ReturnType<typeof observation>,
  fetchEvidence = async () => undefined,
) {
  return {
    id: row.source,
    fetch: async () => {
      await fetchEvidence()
      return {
        observations: [row],
        metadata: {
          source: row.source,
          endpoint: "fixture://capability-sync",
          tier: "fixture",
          pagesFetched: 1,
          recordsRetrieved: 1,
          observationsEmitted: 1,
          matchedModels: row.canonicalModelId === null ? [] : [row.canonicalModelId],
          unresolvedSourceModelIds: row.canonicalModelId === null ? [row.sourceModelId] : [],
          rateLimit: { limit: null, remaining: null, reset: null },
        },
      }
    },
  }
}

describe.skipIf(!configuredUrl)("capability publication sync concurrency in Postgres", () => {
  beforeAll(async () => {
    admin = createDatabase({ url: configuredUrl, maxConnections: 1 })
    await admin.sql.unsafe(`create database "${databaseName}"`)
    const testUrl = new URL(configuredUrl)
    testUrl.pathname = `/${databaseName}`
    await runMigrations({ url: testUrl.toString(), migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: testUrl.toString(), maxConnections: 2 })
    repository = createCapabilityIntelligenceRepository(handle.db, handle.sql)
  })

  beforeEach(async () => {
    if (!handle) throw new Error("database fixture is not initialized")
    await handle.sql`truncate table capability_snapshots, capability_observations, route_model_inventory`
  })

  test("a one-connection pool rejects sync before work and remains usable", async () => {
    const testUrl = new URL(configuredUrl)
    testUrl.pathname = `/${databaseName}`
    const singleHandle = createDatabase({
      url: testUrl.toString(),
      maxConnections: 1,
      closeTimeoutSeconds: 0,
    })
    const singleRepository = createCapabilityIntelligenceRepository(
      singleHandle.db,
      singleHandle.sql,
    )
    const poolBeforeSync = singleHandle.poolStats()
    let fetches = 0
    const sync = syncCapabilityIntelligence({
      repository: singleRepository,
      sources: [
        evidenceSource(
          observation({
            key: `single-pool-${crypto.randomUUID()}`,
            sourceModelId: "claude-sonnet-4-6",
            canonicalModelId: "anthropic/claude-sonnet-4-6",
            rawValue: 63,
            observedAt: new Date("2026-10-21T16:00:00Z"),
          }),
          async () => {
            fetches += 1
          },
        ),
      ],
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )
    const watchdogResult = Promise.withResolvers<{ readonly status: "timeout" }>()
    // This real-clock watchdog only bounds the old deadlock: that sync has no cancellation or
    // settlement signal, so there is no deterministic event to await if the regression returns.
    const watchdog = setTimeout(() => watchdogResult.resolve({ status: "timeout" }), 4_000)
    try {
      const outcome = await Promise.race([sync, watchdogResult.promise])
      if (outcome.status !== "rejected") {
        throw new Error(`Single-connection sync did not reject promptly (${outcome.status})`)
      }
      expect(outcome.error).toBeInstanceOf(Error)
      expect(fetches).toBe(0)
      expect(singleHandle.poolStats()).toEqual(poolBeforeSync)
      await expect(singleHandle.sql`select 1 as ok`).resolves.toEqual([{ ok: 1 }])
    } finally {
      clearTimeout(watchdog)
      await singleHandle.close()
    }
  })

  afterAll(async () => {
    await handle?.close()
    if (!admin) return
    try {
      await admin.sql.unsafe(`drop database if exists "${databaseName}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  test("a later sync cannot publish an older overlapping fetch after newer evidence", async () => {
    const sourceModelId = "claude-sonnet-4-6"
    const observedAt = (hour: number) =>
      new Date(`2026-10-19T${String(hour).padStart(2, "0")}:00:00Z`)
    const a = observation({
      key: `sync-a-${crypto.randomUUID()}`,
      sourceModelId,
      canonicalModelId: "anthropic/claude-sonnet-4-6",
      rawValue: 40,
      observedAt: observedAt(1),
    })
    const b = observation({
      key: `sync-b-${crypto.randomUUID()}`,
      sourceModelId,
      canonicalModelId: "anthropic/claude-sonnet-4-6",
      rawValue: 80,
      observedAt: observedAt(2),
    })
    await repository.recordObservations([
      a,
      b,
      { ...a, observedAt: observedAt(3), ingestedAt: observedAt(3) },
    ])

    const olderStarted = Promise.withResolvers<void>()
    const releaseOlder = Promise.withResolvers<void>()
    const older = syncCapabilityIntelligence({
      repository,
      bootstrap,
      sources: [
        evidenceSource({ ...b, observedAt: observedAt(4), ingestedAt: observedAt(4) }, async () => {
          olderStarted.resolve()
          await releaseOlder.promise
        }),
      ],
    })
    await olderStarted.promise

    let newerFetches = 0
    let newerError: unknown = null
    try {
      await syncCapabilityIntelligence({
        repository,
        bootstrap,
        sources: [
          evidenceSource(
            { ...a, observedAt: observedAt(5), ingestedAt: observedAt(5) },
            async () => {
              newerFetches += 1
            },
          ),
        ],
      })
    } catch (error) {
      newerError = error
    }
    const observationsDuringOverlap = await repository.listObservations()
    const publicationDuringOverlap = await repository.getPublishedSnapshot()

    releaseOlder.resolve()
    await older
    if (newerError instanceof Error && newerError.message.includes("already in progress")) {
      await syncCapabilityIntelligence({
        repository,
        bootstrap,
        sources: [evidenceSource({ ...a, observedAt: observedAt(5), ingestedAt: observedAt(5) })],
      })
    }

    const published = await repository.getPublishedSnapshot()
    const payload = published?.payload as
      | { models?: Record<string, { scores: Record<string, number | null> }> }
      | undefined
    expect(newerError).toBeInstanceOf(Error)
    expect((newerError as Error)?.message).toContain("already in progress")
    expect(newerFetches).toBe(0)
    expect(observationsDuringOverlap).toHaveLength(2)
    expect(
      observationsDuringOverlap.find((row) => row.fingerprint === a.fingerprint)?.observedAt,
    ).toEqual(observedAt(3))
    expect(publicationDuringOverlap).toBeUndefined()
    expect(payload?.models?.["anthropic/claude-sonnet-4-6"]?.scores.general).toBe(0.4)
  })

  test("a sync whose lock session is terminated cannot overwrite a newer sync", async () => {
    const control = admin
    if (!control) throw new Error("database admin fixture is not initialized")
    const sourceId = `session-loss-${crypto.randomUUID()}`
    const routeModelId = `session-loss-route-${crypto.randomUUID()}`
    const testUrl = new URL(configuredUrl)
    testUrl.pathname = `/${databaseName}`
    const olderHandle = createDatabase({
      url: testUrl.toString(),
      maxConnections: 2,
      closeTimeoutSeconds: 0,
    })
    const newerHandle = createDatabase({
      url: testUrl.toString(),
      maxConnections: 2,
      closeTimeoutSeconds: 0,
    })
    const olderRepository = createCapabilityIntelligenceRepository(olderHandle.db, olderHandle.sql)
    const newerRepository = createCapabilityIntelligenceRepository(newerHandle.db, newerHandle.sql)
    const olderDiscoveryStarted = Promise.withResolvers<void>()
    const releaseOlderDiscovery = Promise.withResolvers<void>()
    const source = (semanticModelId: string, pause = false) => ({
      id: sourceId,
      tags: ["local"],
      discover: async () => {
        if (pause) {
          olderDiscoveryStarted.resolve()
          await releaseOlderDiscovery.promise
        }
        return {
          descriptors: [
            {
              routeModelId,
              semanticModelId,
              baseModelId: null,
              derivativeModelId: null,
              capabilities: { textInput: true, textOutput: true },
            },
          ],
          rejected: [],
        }
      },
    })
    const older = syncCapabilityIntelligence({
      repository: olderRepository,
      bootstrap,
      sources: [],
      routeSources: [source("review/older", true)],
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )

    await olderDiscoveryStarted.promise
    try {
      const locks = await control.sql`
        select pid
        from pg_locks
        where locktype = ${"advisory"}
          and granted
          and objsubid = 2
          and classid::text = ${String(0x726f_7574)}
          and objid::text = ${String(advisoryLockKey("capability_intelligence_sync") >>> 0)}
          and database = (
            select oid from pg_database where datname = ${databaseName}
          )
      `
      expect(locks).toHaveLength(1)
      const pidValue = locks[0]?.pid
      if (pidValue === undefined) throw new Error("missing older sync lock backend pid")
      const pid = Number(pidValue)
      if (!Number.isInteger(pid)) throw new Error("invalid older sync lock backend pid")
      const terminated = await control.sql`
        select pg_terminate_backend(${pid}) as terminated
      `
      expect(terminated[0]?.terminated).toBe(true)

      const newer = await syncCapabilityIntelligence({
        repository: newerRepository,
        bootstrap,
        sources: [],
        routeSources: [source("review/newer")],
      })
      const publishedAfterNewer = await repository.getPublishedSnapshot()
      expect(publishedAfterNewer?.revision).toBe(newer.publishedRevision)
      expect(
        (await repository.listRouteModels()).find(
          (row) => row.source === sourceId && row.routeModelId === routeModelId,
        )?.descriptor,
      ).toMatchObject({ semanticModelId: "review/newer" })

      releaseOlderDiscovery.resolve()
      const olderResult = await older
      if (olderResult.status === "fulfilled") {
        throw new Error("older sync unexpectedly completed after losing its lock session")
      }
      expect(olderResult.error).toBeInstanceOf(AdvisoryLockSessionLostError)

      const routesAfterOlder = await repository.listRouteModels()
      expect(
        routesAfterOlder.find((row) => row.source === sourceId && row.routeModelId === routeModelId)
          ?.descriptor,
      ).toMatchObject({ semanticModelId: "review/newer" })
      expect(await repository.getPublishedSnapshot()).toMatchObject({
        revision: newer.publishedRevision,
        publicationState: "published",
      })
      expect(await repository.listSnapshots(1000)).toHaveLength(1)
    } finally {
      releaseOlderDiscovery.resolve()
      await older
      await Promise.all([olderHandle.close(), newerHandle.close()])
    }
  })

  test("an ordinary source failure after lock-session loss is delivered without hanging", async () => {
    const control = admin
    if (!control) throw new Error("database admin fixture is not initialized")
    const testUrl = new URL(configuredUrl)
    testUrl.pathname = `/${databaseName}`
    const lostHandle = createDatabase({
      url: testUrl.toString(),
      maxConnections: 2,
      closeTimeoutSeconds: 0,
    })
    const lostRepository = createCapabilityIntelligenceRepository(lostHandle.db, lostHandle.sql)
    const sourceFailure = new Error("upstream fetch failed after lock-session loss")
    const sync = syncCapabilityIntelligence({
      repository: lostRepository,
      bootstrap,
      sources: [
        {
          id: `session-loss-fetch-${crypto.randomUUID()}`,
          fetch: async () => {
            await control.sql`
              select pg_terminate_backend(pid)
              from pg_locks
              where locktype = ${"advisory"}
                and granted
                and objsubid = 2
                and classid::text = ${String(0x726f_7574)}
                and objid::text = ${String(advisoryLockKey("capability_intelligence_sync") >>> 0)}
                and database = (select oid from pg_database where datname = ${databaseName})
            `
            throw sourceFailure
          },
        },
      ],
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )
    const watchdogResult = Promise.withResolvers<{ readonly status: "timeout" }>()
    // Bounds only the old failure mode, where unlocking the dead reservation never settled.
    const watchdog = setTimeout(() => watchdogResult.resolve({ status: "timeout" }), 4_000)
    try {
      const outcome = await Promise.race([sync, watchdogResult.promise])
      if (outcome.status !== "rejected") {
        throw new Error(`sync did not reject promptly after lock-session loss (${outcome.status})`)
      }
      expect(outcome.error).toBe(sourceFailure)
    } finally {
      clearTimeout(watchdog)
      await lostHandle.close()
    }
  })

  test("unresolved evidence summary changes create a new published revision", async () => {
    const resolved = observation({
      key: `summary-resolved-${crypto.randomUUID()}`,
      sourceModelId: "claude-sonnet-4-6",
      canonicalModelId: "anthropic/claude-sonnet-4-6",
      rawValue: 62,
      observedAt: new Date("2026-10-19T16:00:00Z"),
    })
    await repository.recordObservations([resolved])
    const generatedAt = new Date("2026-10-21T16:00:00Z")
    const first = await compileAndPublishCapabilitySnapshot({
      repository,
      bootstrap,
      now: () => generatedAt,
    })
    const unresolved = observation({
      key: `summary-unresolved-${crypto.randomUUID()}`,
      sourceModelId: "unmapped-fixture-model",
      canonicalModelId: null,
      rawValue: 55,
      observedAt: new Date("2026-10-19T17:00:00Z"),
    })
    await repository.recordObservations([unresolved])

    const next = await compileAndPublishCapabilitySnapshot({
      repository,
      bootstrap,
      now: () => generatedAt,
    })
    const published = await repository.getPublishedSnapshot()
    expect(next.compiled.snapshot.evidenceDigest).toBe(first.compiled.snapshot.evidenceDigest)
    expect(next.publishedRevision).not.toBe(first.publishedRevision)
    expect(next.compiled.summary).toMatchObject({ totalObservations: 2, unresolvedObservations: 1 })
    expect(published?.revision).toBe(next.publishedRevision)
    expect(published?.summary).toMatchObject({ totalObservations: 2, unresolvedObservations: 1 })
  })

  test("A-B-A route reconciliation republishes the original immutable snapshot", async () => {
    let textInput = true
    const routeSource = {
      id: "publication-recurrence",
      tags: ["local"],
      discover: async () => ({
        descriptors: [
          {
            routeModelId: "audit-model",
            semanticModelId: "audit/model",
            baseModelId: null,
            derivativeModelId: null,
            capabilities: { textInput, textOutput: true },
          },
        ],
        rejected: [],
      }),
    }
    const times = [
      new Date("2026-10-21T10:00:00Z"),
      new Date("2026-10-21T11:00:00Z"),
      new Date("2026-10-21T12:00:00Z"),
    ] as const
    const syncAt = (generatedAt: Date) =>
      syncCapabilityIntelligence({
        repository,
        sources: [],
        routeSources: [routeSource],
        bootstrap,
        now: () => generatedAt,
      })

    const first = await syncAt(times[0])
    const firstPublished = await repository.getPublishedSnapshot()
    if (!firstPublished) throw new Error("first route snapshot was not published")
    textInput = false
    const second = await syncAt(times[1])
    textInput = true
    const third = await syncAt(times[2])
    const republished = await repository.getPublishedSnapshot()

    expect(second.publishedRevision).not.toBe(first.publishedRevision)
    expect(third.publishedRevision).toBe(first.publishedRevision)
    expect(third.publishedAt).toBe(first.publishedAt)
    expect(republished).toMatchObject({
      id: firstPublished.id,
      revision: firstPublished.revision,
      publicationState: "published",
      generatedAt: firstPublished.generatedAt,
      publishedAt: firstPublished.publishedAt,
      compilerVersion: firstPublished.compilerVersion,
      normalizerVersion: firstPublished.normalizerVersion,
      evidenceDigest: firstPublished.evidenceDigest,
      payload: firstPublished.payload,
      summary: firstPublished.summary,
    })
    expect(
      (await repository.listSnapshots(1000)).filter((row) => row.publicationState === "published"),
    ).toHaveLength(1)
  })
})
