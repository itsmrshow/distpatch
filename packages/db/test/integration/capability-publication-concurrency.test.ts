import { afterAll, beforeAll, describe, expect, test } from "bun:test"
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
async function publish(candidate: CapabilitySnapshotInsert) {
  return repository.publishSnapshotWithCurrentEvidence(async () => ({
    snapshot: candidate,
    result: undefined,
  }))
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

  test("concurrent same-revision publications never alter an already-published row", async () => {
    const candidate = snapshot(`candidate-${crypto.randomUUID()}`, new Date("2026-10-21T12:00:00Z"))
    await publish(candidate)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        publish({
          ...candidate,
          publicationState: "candidate",
          generatedAt: new Date(candidate.generatedAt.getTime() + index + 1),
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
      publishedAt: candidate.generatedAt,
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
      await Promise.all(candidates.map(publish))
      expect(
        (await repository.listSnapshots(1000)).filter(
          (row) => row.publicationState === "published",
        ),
      ).toHaveLength(1)
    }
  })

  test("partial unique index rejects a second published row", async () => {
    const live = handle
    if (!live) throw new Error("database fixture is not initialized")
    await live.sql`
      update capability_snapshots
      set publication_state = 'superseded'
      where publication_state = 'published'
    `
    const firstRevision = `unique-first-${crypto.randomUUID()}`
    const secondRevision = `unique-second-${crypto.randomUUID()}`
    const insertPublished = (revision: string) =>
      live.sql`
        insert into capability_snapshots (
          revision, generated_at, published_at, compiler_version, normalizer_version, evidence_digest,
          publication_state, payload, summary
        ) values (
          ${revision}, now(), now(), 'test', 'test', 'sha256:test',
          'published', '{}'::jsonb, '{}'::jsonb
        )
      `
    await insertPublished(firstRevision)
    await expect(insertPublished(secondRevision)).rejects.toThrow()
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
    const afterReversion = (await repository.listObservations()).filter(
      (row) => row.sourceModelId === sourceModelId,
    )
    expect(afterReversion).toHaveLength(2)
    expect(afterReversion.at(-1)).toMatchObject({
      fingerprint: a.fingerprint,
      rawValue: a.rawValue,
      observedAt: revertedA.observedAt,
    })
    const laterB = {
      ...b,
      observedAt: new Date("2026-10-19T13:00:00Z"),
      ingestedAt: new Date("2026-10-19T13:00:00Z"),
    }
    expect(await repository.recordObservations([laterB])).toEqual({
      inserted: 1,
      deduplicated: 0,
    })
    expect(
      await repository.recordObservations([
        {
          ...a,
          observedAt: new Date("2026-10-19T11:00:00Z"),
          ingestedAt: new Date("2026-10-19T11:00:00Z"),
        },
      ]),
    ).toEqual({ inserted: 0, deduplicated: 1 })
    const history = (await repository.listObservations()).filter(
      (row) => row.sourceModelId === sourceModelId,
    )
    expect(history).toHaveLength(2)
    expect(history.find((row) => row.fingerprint === a.fingerprint)?.observedAt).toEqual(
      revertedA.observedAt,
    )
    expect(history.at(-1)).toMatchObject({
      fingerprint: b.fingerprint,
      observedAt: laterB.observedAt,
      ingestedAt: laterB.ingestedAt,
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
})
