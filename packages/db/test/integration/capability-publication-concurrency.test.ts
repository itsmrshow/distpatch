import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { compileAndPublishCapabilitySnapshot } from "../../../../apps/api/src/services/capabilities/intelligence/lifecycle"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type CapabilityIntelligenceRepository,
  type CapabilityObservationInsert,
  type CapabilitySnapshotInsert,
  createCapabilityIntelligenceRepository,
} from "../../src/repositories/capability-intelligence-repository"

const configuredUrl = process.env.DATABASE_URL ?? ""
const databaseName = `cap_pub_${crypto.randomUUID().replaceAll("-", "")}`
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

function snapshot(
  revision: string,
  generatedAt: Date,
  publicationState: CapabilitySnapshotInsert["publicationState"] = "candidate",
): CapabilitySnapshotInsert {
  return {
    revision,
    generatedAt,
    compilerVersion: "publication-test-compiler",
    normalizerVersion: "publication-test-normalizer",
    evidenceDigest: `sha256:${revision}`,
    publicationState,
    payload: { revision },
    summary: { observations: 0 },
  }
}

async function waitForAdvisoryLockWait(): Promise<void> {
  if (!handle) throw new Error("database fixture is not initialized")
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await handle.sql<{ readonly granted: boolean }[]>`
      select granted
      from pg_locks
      where locktype = 'advisory'
        and not granted
    `
    if (rows.length > 0) return
    await Promise.resolve()
  }
  throw new Error("publication did not wait for the held advisory lock")
}

describe.skipIf(!configuredUrl)("capability publication concurrency in Postgres", () => {
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

  test("concurrent candidate saves do not alter a published revision", async () => {
    const candidate = snapshot(`candidate-${crypto.randomUUID()}`, new Date("2026-10-21T12:00:00Z"))
    await repository.saveSnapshot(candidate)
    await repository.publishSnapshot(candidate.revision, candidate.generatedAt)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.saveSnapshot({
          ...candidate,
          publicationState: "candidate",
          payload: { overwriteAttempt: index },
          summary: { observations: index + 1 },
        }),
      ),
    )

    expect(await repository.getPublishedSnapshot()).toMatchObject({
      revision: candidate.revision,
      publicationState: "published",
      payload: candidate.payload,
      summary: candidate.summary,
      generatedAt: candidate.generatedAt,
    })
  })

  test("simultaneous publications leave exactly one published row", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const candidates = Array.from({ length: 2 }, (_, candidateIndex) =>
        snapshot(
          `parallel-${iteration}-${candidateIndex}-${crypto.randomUUID()}`,
          new Date(`2026-10-21T12:00:${String(iteration).padStart(2, "0")}Z`),
        ),
      )
      await Promise.all(candidates.map((candidate) => repository.saveSnapshot(candidate)))
      await Promise.all(
        candidates.map((candidate) =>
          repository.publishSnapshot(candidate.revision, candidate.generatedAt),
        ),
      )
      expect(
        (await repository.listSnapshots(1000)).filter(
          (row) => row.publicationState === "published",
        ),
      ).toHaveLength(1)
    }
  })

  test("A-B-A observation recurrence restamps A and counts the recurrence once", async () => {
    const sourceModelId = `recurrent-${crypto.randomUUID()}`
    const a = observation({
      key: `${sourceModelId}-a`,
      sourceModelId,
      rawValue: 61,
      observedAt: new Date("2026-10-19T10:00:00Z"),
    })
    const b = observation({
      key: `${sourceModelId}-b`,
      sourceModelId,
      rawValue: 68,
      observedAt: new Date("2026-10-19T11:00:00Z"),
    })
    const revertedA = {
      ...a,
      observedAt: new Date("2026-10-19T12:00:00Z"),
      ingestedAt: new Date("2026-10-19T12:00:00Z"),
    }

    expect(await repository.recordObservations([a])).toEqual({ inserted: 1, deduplicated: 0 })
    expect(await repository.recordObservations([b])).toEqual({ inserted: 1, deduplicated: 0 })
    expect(await repository.recordObservations([revertedA])).toEqual({
      inserted: 1,
      deduplicated: 0,
    })
    expect(await repository.recordObservations([revertedA])).toEqual({
      inserted: 0,
      deduplicated: 1,
    })

    const history = (await repository.listObservations()).filter(
      (row) => row.sourceModelId === sourceModelId,
    )
    expect(history).toHaveLength(2)
    expect(history.at(-1)).toMatchObject({
      fingerprint: a.fingerprint,
      rawValue: a.rawValue,
      observedAt: revertedA.observedAt,
      ingestedAt: revertedA.ingestedAt,
    })
  })

  test("concurrent identical fingerprints are idempotent", async () => {
    const row = observation({
      key: `concurrent-${crypto.randomUUID()}`,
      sourceModelId: `concurrent-${crypto.randomUUID()}`,
      rawValue: 63,
      observedAt: new Date("2026-10-19T13:00:00Z"),
    })
    const results = await Promise.all([
      repository.recordObservations([row]),
      repository.recordObservations([row]),
    ])

    expect(results.reduce((sum, result) => sum + result.inserted, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.deduplicated, 0)).toBe(1)
    expect(
      (await repository.listObservations()).filter(
        (stored) => stored.fingerprint === row.fingerprint,
      ),
    ).toHaveLength(1)
  })

  test("route inventory reconciliation reads and writes atomically", async () => {
    const route = (routeModelId: string) => ({
      source: "publication-route-test",
      routeModelId,
      descriptor: { routeModelId, semanticModelId: `test/${routeModelId}` },
      tags: ["local"],
      status: "present" as const,
      firstSeenAt: new Date("2026-10-21T13:00:00Z"),
      lastSeenAt: new Date("2026-10-21T13:00:00Z"),
      absentSince: null,
    })
    const seenCounts = await Promise.all(
      [route("route-a"), route("route-b")].map((row) =>
        repository.reconcileRouteModels((stored) => ({
          rows: [row],
          result: stored.filter((item) => item.source === row.source).length,
        })),
      ),
    )

    expect(seenCounts.sort()).toEqual([0, 1])
    expect(
      (await repository.listRouteModels()).filter((row) => row.source === "publication-route-test"),
    ).toHaveLength(2)
  })

  test("twenty concurrent compiles publish the newest committed evidence despite clock skew", async () => {
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

      await repository.recordObservations([
        observation({
          key: `${sourceModelId}-new`,
          sourceModelId,
          rawValue: 72,
          observedAt: newObservedAt,
        }),
      ])
      const secondPublication = Promise.withResolvers<void>()
      const secondRepository: CapabilityIntelligenceRepository = {
        ...repository,
        publishSnapshotWithCurrentEvidence: (build) => {
          const pending = repository.publishSnapshotWithCurrentEvidence(build)
          secondPublication.resolve()
          return pending
        },
      }
      let secondFinished = false
      const second = compileAndPublishCapabilitySnapshot({
        repository: secondRepository,
        bootstrap,
        now: () => secondTimestamp,
      }).then((result) => {
        secondFinished = true
        return result
      })
      await secondPublication.promise

      try {
        await waitForAdvisoryLockWait()
        expect(secondFinished).toBe(false)
      } finally {
        continueCompile.resolve()
      }

      const [firstResult, secondResult] = await Promise.all([first, second])
      const published = await repository.getPublishedSnapshot()
      expect(firstResult.compiled.snapshot.evidenceDigest).not.toBe(
        secondResult.compiled.snapshot.evidenceDigest,
      )
      expect(firstResult.compiled.snapshot.generatedAt).toBe(firstTimestamp.toISOString())
      expect(secondResult.compiled.snapshot.generatedAt).toBe(secondTimestamp.toISOString())
      expect(published?.revision).toBe(secondResult.publishedRevision)
      expect(published?.evidenceDigest).toBe(secondResult.compiled.snapshot.evidenceDigest)
      expect(published?.payload).toMatchObject({
        evidenceDigest: secondResult.compiled.snapshot.evidenceDigest,
      })
    }
  })
})
