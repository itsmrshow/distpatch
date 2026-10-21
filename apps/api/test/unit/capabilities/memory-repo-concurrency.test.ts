import { describe, expect, test } from "bun:test"
import type { CapabilityObservationInsert, RouteModelInventoryRow } from "@multi-ai-router/db"
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
})
