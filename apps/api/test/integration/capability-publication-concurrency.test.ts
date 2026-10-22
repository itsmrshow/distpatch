import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type CapabilityIntelligenceRepository,
  type CapabilityObservationInsert,
  createCapabilityIntelligenceRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { compileAndPublishCapabilitySnapshot } from "../../src/services/capabilities/intelligence/lifecycle"

const configuredUrl = process.env.DATABASE_URL ?? ""
const databaseName = `cap_api_pub_${crypto.randomUUID().replaceAll("-", "")}`
const bootstrap = {
  schemaVersion: 1 as const,
  revision: "2026-10-21.1",
  profiles: [{ id: "anthropic/claude-sonnet-4-6" }],
}

let admin: DatabaseHandle | undefined
let handle: DatabaseHandle | undefined
let repository!: CapabilityIntelligenceRepository

function observation(input: {
  readonly key: string
  readonly sourceModelId: string
  readonly rawValue: number
  readonly observedAt: Date
}): CapabilityObservationInsert {
  return {
    source: "artificial-analysis",
    sourceModelId: input.sourceModelId,
    canonicalModelId: "anthropic/claude-sonnet-4-6",
    metric: "intelligence_index",
    rawValue: input.rawValue,
    unit: "index_100",
    benchmark: "artificial_analysis_intelligence_index",
    benchmarkVersion: "publication-test-v1",
    fingerprint: `fp:${input.key}`,
    observedAt: input.observedAt,
    ingestedAt: input.observedAt,
    sourceRef: `https://example.invalid/${input.key}`,
    provenance: { fixture: input.key },
  }
}

async function waitForAdvisoryLockWait(): Promise<boolean> {
  if (!handle) throw new Error("database fixture is not initialized")
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await handle.sql<{ readonly granted: boolean }[]>`
      select granted
      from pg_locks
      where locktype = 'advisory'
        and database = (select oid from pg_database where datname = current_database())
        and not granted
    `
    if (rows.length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

describe.skipIf(!configuredUrl)("capability lifecycle publication concurrency in Postgres", () => {
  beforeAll(async () => {
    admin = createDatabase({ url: configuredUrl, maxConnections: 1 })
    await admin.sql.unsafe(`create database "${databaseName}"`)
    const testUrl = new URL(configuredUrl)
    testUrl.pathname = `/${databaseName}`
    await runMigrations({ url: testUrl.toString(), migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: testUrl.toString(), maxConnections: 8 })
    repository = createCapabilityIntelligenceRepository(handle.db)
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

  test("twenty concurrent compiles and evidence writes publish newest evidence despite clock skew", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const sourceModelId = `compile-race-${iteration}-${crypto.randomUUID()}`
      const oldObservedAt = new Date("2026-10-19T14:00:00Z")
      const newObservedAt = new Date("2026-10-19T15:00:00Z")
      await repository.recordObservations([
        observation({
          key: `${sourceModelId}-old`,
          sourceModelId,
          rawValue: 60,
          observedAt: oldObservedAt,
        }),
      ])

      const evidenceRead = Promise.withResolvers<void>()
      const continueCompile = Promise.withResolvers<void>()
      const delayedRepository: CapabilityIntelligenceRepository = {
        ...repository,
        publishSnapshotWithCurrentEvidence: (build) =>
          repository.publishSnapshotWithCurrentEvidence(async (evidence) => {
            evidenceRead.resolve()
            await continueCompile.promise
            return build(evidence)
          }),
      }
      const firstTimestamp = new Date("2026-10-21T14:00:30Z")
      const secondTimestamp = new Date("2026-10-21T14:00:00Z")
      const first = compileAndPublishCapabilitySnapshot({
        repository: delayedRepository,
        bootstrap,
        now: () => firstTimestamp,
      })
      await evidenceRead.promise

      let observationWriteFinished = false
      const observationWrite = repository
        .recordObservations([
          observation({
            key: `${sourceModelId}-new`,
            sourceModelId,
            rawValue: 72,
            observedAt: newObservedAt,
          }),
        ])
        .then((result) => {
          observationWriteFinished = true
          return result
        })

      let observationWriteBlocked = false
      try {
        observationWriteBlocked = (await waitForAdvisoryLockWait()) && !observationWriteFinished
      } finally {
        continueCompile.resolve()
      }
      const firstResult = await first
      await observationWrite
      expect(observationWriteBlocked).toBe(true)
      const [secondResult, concurrentResult] = await Promise.all([
        compileAndPublishCapabilitySnapshot({
          repository,
          bootstrap,
          now: () => secondTimestamp,
        }),
        compileAndPublishCapabilitySnapshot({
          repository,
          bootstrap,
          now: () => secondTimestamp,
        }),
      ])
      const published = await repository.getPublishedSnapshot()

      expect(firstResult.compiled.snapshot.evidenceDigest).not.toBe(
        secondResult.compiled.snapshot.evidenceDigest,
      )
      expect(secondResult.compiled.snapshot.evidenceDigest).toBe(
        concurrentResult.compiled.snapshot.evidenceDigest,
      )
      expect(firstResult.compiled.snapshot.generatedAt).toBe(firstTimestamp.toISOString())
      expect(secondResult.compiled.snapshot.generatedAt).toBe(secondTimestamp.toISOString())
      expect(
        secondResult.compiled.snapshot.models["anthropic/claude-sonnet-4-6"]?.scores.general,
      ).toBe(0.72)
      expect(published?.revision).toBe(secondResult.publishedRevision)
      expect(published?.revision).toBe(concurrentResult.publishedRevision)
      expect(published?.evidenceDigest).toBe(secondResult.compiled.snapshot.evidenceDigest)
      expect(published?.payload).toMatchObject({
        evidenceDigest: secondResult.compiled.snapshot.evidenceDigest,
      })
      expect(
        (await repository.listSnapshots(1000)).filter(
          (row) => row.publicationState === "published",
        ),
      ).toHaveLength(1)
    }
  }, 60_000)
})
