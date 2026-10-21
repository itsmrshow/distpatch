import { describe, expect, test } from "bun:test"
import type {
  CapabilityObservationInsert,
  CapabilitySnapshotInsert,
  RouteModelInventoryRow,
} from "@multi-ai-router/db"
import { createMemoryCapabilityRepo } from "./memory-repo"

function observation(sourceModelId: string): CapabilityObservationInsert {
  const timestamp = new Date("2026-10-21T12:00:00Z")
  return {
    source: "memory-repo-test",
    sourceModelId,
    canonicalModelId: null,
    metric: "fixture_metric",
    rawValue: 1,
    unit: "index",
    benchmark: "fixture",
    benchmarkVersion: "v1",
    fingerprint: `fp:${sourceModelId}`,
    observedAt: timestamp,
    ingestedAt: timestamp,
    sourceRef: "fixture://memory-repo",
    provenance: {},
  }
}

function route(firstSeenAt: Date): RouteModelInventoryRow {
  return {
    source: "memory-repo-test",
    routeModelId: "fixture-model",
    descriptor: { routeModelId: "fixture-model", semanticModelId: "fixture/model" },
    tags: ["fixture"],
    status: "present",
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    absentSince: null,
  }
}

describe("memory capability repository concurrency semantics", () => {
  test("sync lock fails fast while held and is released after work completes", async () => {
    const repository = createMemoryCapabilityRepo()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = repository.withSyncLock(async () => {
      started.resolve()
      await release.promise
      return "completed"
    })

    await started.promise
    expect(await repository.withSyncLock(async () => "should not run")).toEqual({ acquired: false })
    release.resolve()
    await expect(first).resolves.toEqual({ acquired: true, value: "completed" })
    await expect(repository.withSyncLock(async () => "reacquired")).resolves.toEqual({
      acquired: true,
      value: "reacquired",
    })
  })

  test("identity resolution leaves all observations unchanged when resolver throws", async () => {
    const repository = createMemoryCapabilityRepo()
    await repository.recordObservations([observation("model-one"), observation("model-two")])

    await expect(
      repository.resolveObservationIdentities((_source, sourceModelId) => {
        if (sourceModelId === "model-two") throw new Error("resolver failed")
        return "mapped/model-one"
      }),
    ).rejects.toThrow("resolver failed")
    expect(repository.observations.map((row) => row.canonicalModelId)).toEqual([null, null])
  })

  test("route reconciliation preserves firstSeenAt for an existing row", async () => {
    const repository = createMemoryCapabilityRepo()
    const firstSeenAt = new Date("2026-10-20T12:00:00Z")
    const laterSeenAt = new Date("2026-10-21T12:00:00Z")
    const initial = route(firstSeenAt)
    await repository.reconcileRouteModels(() => ({ rows: [initial], result: undefined }))
    await repository.reconcileRouteModels(() => ({
      rows: [{ ...initial, firstSeenAt: laterSeenAt, lastSeenAt: laterSeenAt }],
      result: undefined,
    }))

    expect((await repository.listRouteModels())[0]?.firstSeenAt).toEqual(firstSeenAt)
  })

  test("republishing a superseded snapshot preserves its first publication metadata", async () => {
    const repository = createMemoryCapabilityRepo()
    const generatedAt = new Date("2026-10-21T12:00:00Z")
    const original: CapabilitySnapshotInsert = {
      revision: "memory-recurrence-a",
      generatedAt,
      compilerVersion: "first-compiler",
      normalizerVersion: "first-normalizer",
      evidenceDigest: "sha256:first",
      publicationState: "candidate",
      payload: { generatedAt: generatedAt.toISOString(), revision: "A" },
      summary: { observations: 1 },
    }
    const publish = (snapshot: CapabilitySnapshotInsert) =>
      repository.publishSnapshotWithCurrentEvidence(async () => ({
        snapshot,
        result: undefined,
      }))

    const firstPublished = await publish(original)
    await publish({
      ...original,
      revision: "memory-recurrence-b",
      generatedAt: new Date("2026-10-21T13:00:00Z"),
      evidenceDigest: "sha256:intermediate",
      payload: { revision: "B" },
    })
    const republished = await publish({
      ...original,
      generatedAt: new Date("2026-10-21T14:00:00Z"),
      compilerVersion: "replacement-compiler",
      normalizerVersion: "replacement-normalizer",
      evidenceDigest: "sha256:replacement",
      payload: { generatedAt: "2026-10-21T14:00:00.000Z", revision: "A-replaced" },
      summary: { observations: 99 },
    })

    expect(republished.publishedSnapshot).toMatchObject({
      id: firstPublished.publishedSnapshot.id,
      revision: original.revision,
      publicationState: "published",
      generatedAt,
      publishedAt: generatedAt,
      compilerVersion: original.compilerVersion,
      normalizerVersion: original.normalizerVersion,
      evidenceDigest: original.evidenceDigest,
      payload: original.payload,
      summary: original.summary,
    })
    expect(repository.snapshots.filter((row) => row.publicationState === "published")).toHaveLength(
      1,
    )
  })

  test("a lost sync lock fences older route reconciliation and publication", async () => {
    const repository = createMemoryCapabilityRepo()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const generatedAt = new Date("2026-10-21T12:00:00Z")
    const row = (semanticModelId: string) => ({
      ...route(generatedAt),
      descriptor: { routeModelId: "fixture-model", semanticModelId },
    })
    const older = repository.withSyncLock(async (syncFence) => {
      started.resolve()
      await release.promise
      await repository.reconcileRouteModels(
        () => ({ rows: [row("review/older")], result: undefined }),
        syncFence,
      )
    })

    await started.promise
    repository.loseSyncLock()
    await repository.withSyncLock(async (syncFence) => {
      await repository.reconcileRouteModels(
        () => ({ rows: [row("review/newer")], result: undefined }),
        syncFence,
      )
      await repository.publishSnapshotWithCurrentEvidence(
        async () => ({
          snapshot: {
            revision: "memory-newer",
            generatedAt,
            compilerVersion: "test",
            normalizerVersion: "test",
            evidenceDigest: "sha256:test",
            publicationState: "candidate",
            payload: { semanticModelId: "review/newer" },
            summary: {},
          },
          result: undefined,
        }),
        syncFence,
      )
    })

    release.resolve()
    await expect(older).rejects.toThrow(/no longer holds the sync lock/)
    expect((await repository.listRouteModels())[0]?.descriptor).toMatchObject({
      semanticModelId: "review/newer",
    })
    expect((await repository.getPublishedSnapshot())?.revision).toBe("memory-newer")
  })
})
