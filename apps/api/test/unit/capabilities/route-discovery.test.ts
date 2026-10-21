import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { NoEligibleModelError } from "@multi-ai-router/core"
import {
  applyPublishedSnapshotToBootstrap,
  type CapabilityCatalogStore,
  type CompiledCapabilitySnapshotPayload,
  compileCapabilitySnapshot,
  createCapabilityCatalogStore,
  createLlamaSwapDiscoverySource,
  type ModelCapabilityCatalog,
  parseLlamaSwapModelList,
  RouteDiscoveryError,
  type RouteModelSource,
  reconcileRouteModels,
  SHIPPED_CAPABILITY_CATALOG,
  syncCapabilityIntelligence,
} from "../../../src/services/capabilities"
import * as compiler from "../../../src/services/capabilities/intelligence/compiler"
import { chooseModel } from "../../../src/services/dataplane"
import { selectVirtualModel, virtualModels } from "../../../src/services/virtual-models"
import { bearer, CRYPTOR, harness, post } from "../../integration/harness"
import { account, jsonResponse, catalog as routingCatalog } from "../dataplane/fixtures"
import { dockerlmDescriptors, dockerlmListing, NOW, storedRows } from "./fleet-fixture"
import { createMemoryCapabilityRepo } from "./memory-repo"

type Descriptors = ReturnType<typeof dockerlmDescriptors>

/** The catalog a sync would publish from these (all-present) route models. */
const compileOnly = (descriptors: Descriptors): ModelCapabilityCatalog =>
  compileCapabilitySnapshot([], { generatedAt: NOW, routeModels: storedRows(descriptors) }).catalog

const asJson = (value: unknown) => new Response(JSON.stringify(value))

/** A llama-swap `/v1/models` entry; any field of `meta.llamaswap` can be overridden. */
function entry(
  id: string,
  semantic: string,
  over: Record<string, unknown> = {},
  base: string | null = semantic,
) {
  return {
    id,
    object: "model",
    meta: {
      llamaswap: {
        model_identity: { semantic_model: semantic, base_model: base, derivative_model: null },
        artifact: {
          repository: `acme/${id}-GGUF`,
          files: [`${id}.gguf`],
          format: "gguf",
          quantization: "Q4_K_M",
        },
        runtime: { name: "runtime-a", version: "1.0" },
        model_capabilities: {
          context_tokens: 32768,
          text_input: true,
          text_output: true,
          image_input: false,
          embedding: false,
        },
        routing: { model_type: "chat", endpoint: "/v1/chat/completions" },
        provenance: {
          semantic_model_source: `https://huggingface.co/${semantic}`,
          artifact_source: `https://huggingface.co/acme/${id}-GGUF`,
          resolution_method: "verified-embedded-metadata-and-hf-repo",
          confidence: "verified",
        },
        ...over,
      },
    },
  }
}

/** A discovery source whose answer the test controls; `null` simulates an unreachable host. */
function hostSource(initial: unknown): RouteModelSource & { answer: unknown } {
  const self = {
    id: "dockerlm",
    tags: ["local"],
    answer: initial as unknown,
    discover: async () => {
      if (self.answer === null) throw new RouteDiscoveryError("route discovery request failed")
      return parseLlamaSwapModelList(self.answer)
    },
  }
  return self
}

const list = (...entries: unknown[]) => ({ object: "list", data: entries })

describe("DockerLM / llama-swap discovery parsing", () => {
  const parsed = parseLlamaSwapModelList(dockerlmListing())
  const byId = new Map(parsed.descriptors.map((d) => [d.routeModelId, d]))

  test("parses the OpenAI-compatible list and every meta.llamaswap entry", () => {
    expect(parsed.rejected).toEqual([])
    expect(byId.size).toBe(6)
  })

  test("a chat model resolves to a lowercase canonical id with artifact and runtime extracted", () => {
    const d = byId.get("strata-qwen38-flash-next")
    expect(d?.semanticModelId).toBe("qwen/qwen3.8-flash-next")
    expect(d?.baseModelId).toBe("qwen/qwen3.8-flash-next")
    expect(d?.artifact).toMatchObject({
      repository: "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF",
      format: "gguf",
      quantization: "GSQ-RCO IQ2_XS",
    })
    expect(d?.artifact?.files).toHaveLength(2)
    expect(d?.runtime).toEqual({ name: "strata", version: "0.1.44.1-296b59d" })
    expect(d?.capabilities).toMatchObject({
      textOutput: true,
      embedding: false,
      contextTokens: 131072,
    })
    expect(d?.provenance?.semanticModelSource).toBe(
      "https://huggingface.co/Qwen/Qwen3.8-Flash-Next",
    )
  })

  test("the embedding model is ingested accurately", () => {
    const d = byId.get("qwen3-embedding-0.6b")
    expect(d?.semanticModelId).toBe("qwen/qwen3-embedding-0.6b")
    expect(d?.capabilities).toMatchObject({ embedding: true, textOutput: false, textInput: true })
    expect(d?.routing).toEqual({ modelType: "embedding", endpoint: "/v1/embeddings" })
  })

  test("a derivative keeps its own semantic id and names its base", () => {
    const d = byId.get("qwen3.8-27b-rvn")
    expect(d?.semanticModelId).toBe("0bserverx/qwen3.8-27b-heretic-abliterated-uncensored")
    expect(d?.baseModelId).toBe("qwen/qwen3.8-27b")
    // The host's free-text "(via …)" annotation does not leak into the id.
    expect(d?.derivativeModelId).toBe("0bserverx/qwen3.8-27b-heretic-abliterated-uncensored")
  })

  test("malformed metadata rejects only that entry; the rest of the list survives", () => {
    const bad = entry("bad", "acme/bad", {
      model_capabilities: { text_input: "yes", text_output: true },
    })
    const result = parseLlamaSwapModelList(list(entry("good", "acme/good"), bad))
    expect(result.descriptors.map((d) => d.routeModelId)).toEqual(["good"])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.routeModelId).toBe("bad")
  })

  test("a semantic_model that is not a vendor/model id rejects the entry", () => {
    const result = parseLlamaSwapModelList(list(entry("x", "not-a-repo"), entry("y", "acme/y")))
    expect(result.rejected.map((r) => r.routeModelId)).toEqual(["x"])
    expect(result.descriptors.map((d) => d.routeModelId)).toEqual(["y"])
  })

  test("missing metadata is kept as an unresolved route, never guessed", () => {
    const result = parseLlamaSwapModelList(list({ id: "plain-route", object: "model" }))
    expect(result.descriptors).toEqual([
      {
        routeModelId: "plain-route",
        semanticModelId: null,
        baseModelId: null,
        derivativeModelId: null,
        capabilities: {},
      },
    ])
    const compiled = compileOnly(result.descriptors)
    expect(compiled.resolve("plain-route")).toBeNull()
  })

  test("unverified provenance leaves the route unresolved", () => {
    const unverified = entry("u", "acme/u", {
      provenance: {
        confidence: "inferred",
        semantic_model_source: "https://huggingface.co/acme/u",
      },
    })
    const d = parseLlamaSwapModelList(list(unverified)).descriptors[0]
    expect(d?.routeModelId).toBe("u")
    expect(d?.semanticModelId).toBeNull()
  })

  test("an entry without a string id is rejected; a repeated id keeps the first", () => {
    const result = parseLlamaSwapModelList(
      list({ object: "model" }, entry("dup", "acme/first"), entry("dup", "acme/second")),
    )
    expect(result.rejected[0]?.routeModelId).toBeNull()
    expect(result.descriptors.map((d) => d.semanticModelId)).toEqual(["acme/first"])
  })

  test("a listing whose every entry is rejected rejects the whole discovery", () => {
    expect(() =>
      parseLlamaSwapModelList(list({ object: "model" }, entry("x", "not-a-repo"))),
    ).toThrow(RouteDiscoveryError)
  })
  test("routes sharing a semantic id keep lineage unknown when base identities disagree", () => {
    const result = parseLlamaSwapModelList(
      list(entry("one", "acme/shared"), entry("two", "acme/shared", {}, "other/base")),
    )
    const catalog = compileOnly(result.descriptors)
    expect(catalog.get("acme/shared")?.baseModel).toBeNull()
  })

  test.each([[null], [{}], [{ data: "nope" }], [list()]])(
    "an unreadable or empty listing rejects the whole discovery: %j",
    (body: unknown) => {
      expect(() => parseLlamaSwapModelList(body)).toThrow(RouteDiscoveryError)
    },
  )

  test("the source GETs {base}/models and never reports the host address on failure", async () => {
    const seen: string[] = []
    const ok = createLlamaSwapDiscoverySource({
      baseUrl: "http://10.9.8.7:8000/v1/",
      fetch: (async (url: string) => {
        seen.push(String(url))
        return asJson(dockerlmListing())
      }) as unknown as typeof fetch,
    })
    expect((await ok.discover()).descriptors).toHaveLength(6)
    expect(seen).toEqual(["http://10.9.8.7:8000/v1/models"])
    expect(ok.tags).toEqual(["local"])

    const down = createLlamaSwapDiscoverySource({
      baseUrl: "http://10.9.8.7:8000/v1",
      fetch: (async () => {
        throw new TypeError("connect ECONNREFUSED 10.9.8.7:8000")
      }) as unknown as typeof fetch,
    })
    const error = await down.discover().then(
      () => null,
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(RouteDiscoveryError)
    expect(error?.message).not.toContain("10.9.8.7")

    const status = createLlamaSwapDiscoverySource({
      baseUrl: "http://h/v1",
      fetch: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
    })
    await expect(status.discover()).rejects.toThrow("HTTP 503")
  })
})

describe("reconciliation", () => {
  const source = { id: "dockerlm", tags: ["local"] }
  const base = parseLlamaSwapModelList(list(entry("a", "acme/a"), entry("b", "acme/b")))
  const first = reconcileRouteModels([], source, base, NOW)
  const stored = first.rows

  test("a new route is added as present", () => {
    expect(first.summary.added).toEqual(["a", "b"])
    expect(stored.every((r) => r.status === "present" && r.firstSeenAt === NOW)).toBe(true)
  })

  test("an identical listing writes nothing", () => {
    const again = reconcileRouteModels(stored, source, base, new Date(NOW.getTime() + 1000))
    expect(again.rows).toEqual([])
    expect(again.summary.unchanged).toEqual(["a", "b"])
  })

  test("a route that disappears turns absent and is kept, not deleted", () => {
    const later = new Date(NOW.getTime() + 1000)
    const only = parseLlamaSwapModelList(list(entry("a", "acme/a")))
    const next = reconcileRouteModels(stored, source, only, later)
    expect(next.summary.absent).toEqual(["b"])
    expect(next.rows).toHaveLength(1)
    expect(next.rows[0]).toMatchObject({ routeModelId: "b", status: "absent", absentSince: later })
    expect(next.rows[0]?.descriptor.semanticModelId).toBe("acme/b")
    // Listed again later: present again, first-seen preserved.
    const back = reconcileRouteModels(
      next.rows.concat(stored.filter((r) => r.routeModelId === "a")),
      source,
      base,
      later,
    )
    expect(back.summary.reappeared).toEqual(["b"])
    expect(back.rows[0]).toMatchObject({ status: "present", absentSince: null, firstSeenAt: NOW })
  })

  test("a quant/runtime change updates the route but not the semantic identity", () => {
    const changed = parseLlamaSwapModelList(
      list(
        entry("a", "acme/a", {
          artifact: { repository: "acme/a-GGUF", format: "gguf", quantization: "Q8_0" },
          runtime: { name: "runtime-b", version: "2.0" },
        }),
        entry("b", "acme/b"),
      ),
    )
    const next = reconcileRouteModels(stored, source, changed, NOW)
    expect(next.summary.changed).toEqual(["a"])
    expect(next.rows[0]?.descriptor.semanticModelId).toBe("acme/a")
    expect(next.rows[0]?.descriptor.artifact?.quantization).toBe("Q8_0")
    expect(next.rows[0]?.descriptor.runtime?.name).toBe("runtime-b")
  })

  test("a malformed entry for a known route is not evidence of removal", () => {
    const next = reconcileRouteModels(
      stored,
      source,
      parseLlamaSwapModelList(
        list(entry("a", "acme/a"), entry("b", "acme/b", { model_capabilities: { text_input: 7 } })),
      ),
      NOW,
    )
    expect(next.summary.absent).toEqual([])
    expect(next.summary.rejected.map((r) => r.routeModelId)).toEqual(["b"])
    expect(next.rows).toEqual([])
  })

  test("another source's rows are never touched", () => {
    const other = reconcileRouteModels(stored, { id: "ollama", tags: [] }, base, NOW)
    expect(other.summary.added).toEqual(["a", "b"])
    expect(other.summary.absent).toEqual([])
  })
})

describe("sync: discovery feeds the published catalog, last-known-good survives", () => {
  const publishedCatalog = (repo: ReturnType<typeof createMemoryCapabilityRepo>) => {
    const snapshot = repo.snapshots.find((s) => s.publicationState === "published")
    return applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, snapshot?.payload ?? null)
  }
  const run = (repo: ReturnType<typeof createMemoryCapabilityRepo>, host: RouteModelSource) =>
    syncCapabilityIntelligence({
      repository: repo,
      sources: [],
      routeSources: [host],
      now: () => NOW,
    })

  test("a new verified model becomes available with no source change", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha")))
    await run(repo, host)
    expect(publishedCatalog(repo).resolve("alpha")?.id).toBe("acme/alpha")
    expect(publishedCatalog(repo).get("acme/alpha")?.tags).toEqual(["local"])

    host.answer = list(entry("alpha", "acme/alpha"), entry("beta", "newco/beta"))
    await run(repo, host)
    expect(publishedCatalog(repo).resolve("beta")?.id).toBe("newco/beta")
  })

  test("a disappeared model leaves the catalog but its evidence row stays", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha"), entry("beta", "acme/beta")))
    await run(repo, host)
    host.answer = list(entry("alpha", "acme/alpha"))
    const result = await run(repo, host)
    expect(result.routeDiscovery[0]).toMatchObject({ ok: true })
    expect(publishedCatalog(repo).resolve("beta")).toBeNull()
    const rows = await repo.listRouteModels()
    expect(rows.find((r) => r.routeModelId === "beta")).toMatchObject({ status: "absent" })
  })

  test("quant/runtime change keeps the semantic profile; a derivative identity change replaces it", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha")))
    await run(repo, host)
    const before = publishedCatalog(repo).get("acme/alpha")

    host.answer = list(entry("alpha", "acme/alpha", { runtime: { name: "other", version: "9" } }))
    await run(repo, host)
    expect(publishedCatalog(repo).get("acme/alpha")?.aliases).toEqual(before?.aliases ?? [])
    expect(
      publishedCatalog(repo)
        .list()
        .filter((p) => p.origin === "discovered"),
    ).toHaveLength(1)

    host.answer = list(entry("alpha", "fork/alpha-uncensored", {}, "acme/alpha"))
    await run(repo, host)
    const after = publishedCatalog(repo)
    expect(after.resolve("alpha")?.id).toBe("fork/alpha-uncensored")
    expect(after.resolve("alpha")?.baseModel).toBe("acme/alpha")
    expect(after.get("acme/alpha")).toBeNull()
  })

  test("an unreachable host reports the failure and keeps the last-known-good catalog", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha")))
    await run(repo, host)
    const rowsBefore = JSON.stringify(await repo.listRouteModels())

    host.answer = null
    const result = await run(repo, host)
    expect(result.routeDiscovery[0]).toMatchObject({ ok: false })
    expect(JSON.stringify(await repo.listRouteModels())).toBe(rowsBefore)
    expect(publishedCatalog(repo).resolve("alpha")?.id).toBe("acme/alpha")
  })

  test("an empty or unreadable listing never wipes the catalog", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha")))
    await run(repo, host)
    for (const body of [list(), { nope: true }]) {
      host.answer = body
      expect((await run(repo, host)).routeDiscovery[0]).toMatchObject({ ok: false })
      expect(publishedCatalog(repo).resolve("alpha")?.id).toBe("acme/alpha")
    }
  })
  test("an all-rejected listing fails sync and preserves its last-known-good catalog", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha")))
    await run(repo, host)
    const rowsBefore = JSON.stringify(await repo.listRouteModels())
    const revisionBefore = (await repo.getPublishedSnapshot())?.revision

    host.answer = list({ id: "alpha", meta: { llamaswap: { invalid: true } } })
    const result = await run(repo, host)

    expect(result.routeDiscovery[0]).toMatchObject({ ok: false })
    expect(JSON.stringify(await repo.listRouteModels())).toBe(rowsBefore)
    expect((await repo.getPublishedSnapshot())?.revision).toBe(revisionBefore)
    expect(publishedCatalog(repo).resolve("alpha")?.id).toBe("acme/alpha")
  })

  test("a malformed entry for a known route keeps its last-known-good profile", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha", "acme/alpha"), entry("beta", "acme/beta")))
    await run(repo, host)
    host.answer = list(
      entry("alpha", "acme/alpha"),
      entry("beta", "acme/beta", { model_capabilities: { text_output: "maybe" } }),
    )
    await run(repo, host)
    expect(publishedCatalog(repo).resolve("beta")?.id).toBe("acme/beta")
  })

  test("two routes of one semantic model (two quants) make one profile with both aliases", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("alpha-q4", "acme/alpha"), entry("alpha-q8", "acme/alpha")))
    await run(repo, host)
    const catalog = publishedCatalog(repo)
    expect(catalog.get("acme/alpha")?.aliases).toEqual(["alpha-q4", "alpha-q8"])
    expect(catalog.list().filter((p) => p.origin === "discovered")).toHaveLength(1)
  })

  test("a route alias that collides with a bootstrap model is dropped, not fatal", async () => {
    const repo = createMemoryCapabilityRepo()
    const host = hostSource(list(entry("gpt-5.5", "acme/imposter"), entry("ok", "acme/ok")))
    await run(repo, host)
    const catalog = publishedCatalog(repo)
    expect(catalog.resolve("gpt-5.5")?.id).toBe("openai/gpt-5.5")
    expect(catalog.resolve("ok")?.id).toBe("acme/ok")
  })
})

describe("auto-local is driven by discovery, not by a hard-coded fleet", () => {
  const catalogFor = compileOnly
  const routing = (models: readonly string[]) =>
    routingCatalog([account("host", { snapshot: { supportedModels: [...models] } })])
  const candidates = (catalog: ModelCapabilityCatalog, models: readonly string[]) =>
    chooseModel(
      { capabilities: catalog },
      routing(models),
      { kind: "all" },
      "auto-local",
      "messages",
    )
      .virtual?.decision.ranked.map((r) => r.model)
      .sort()

  test("any discovered set of local generative models is the candidate set; embedding stays out", () => {
    const parsed = parseLlamaSwapModelList(
      list(
        entry("r1", "one/model-one"),
        entry("r2", "two/model-two"),
        entry("r3", "three/model-three", {}, "one/model-one"),
        entry("emb", "emb/embedder", {
          model_capabilities: { text_input: true, text_output: false, embedding: true },
          routing: { model_type: "embedding", endpoint: "/v1/embeddings" },
        }),
      ),
    )
    const catalog = catalogFor(parsed.descriptors)
    expect(candidates(catalog, ["r1", "r2", "r3", "emb"])).toEqual(["r1", "r2", "r3"])
  })

  test("adding and removing a discovered model changes the candidate set with no code change", () => {
    const three = parseLlamaSwapModelList(
      list(entry("r1", "a/one"), entry("r2", "b/two"), entry("r3", "c/three")),
    )
    expect(candidates(catalogFor(three.descriptors), ["r1", "r2", "r3"])).toEqual([
      "r1",
      "r2",
      "r3",
    ])
    const two = parseLlamaSwapModelList(list(entry("r1", "a/one"), entry("r3", "c/three")))
    const rows = storedRows(three.descriptors).map((r) =>
      two.descriptors.some((d) => d.routeModelId === r.routeModelId)
        ? r
        : { ...r, status: "absent" as const },
    )
    const catalog = compileCapabilitySnapshot([], { generatedAt: NOW, routeModels: rows }).catalog
    expect(candidates(catalog, ["r1", "r3"])).toEqual(["r1", "r3"])
  })

  test("the embedding model alone is no candidate", () => {
    const catalog = catalogFor(dockerlmDescriptors())
    expect(() =>
      chooseModel(
        { capabilities: catalog },
        routing(["qwen3-embedding-0.6b"]),
        { kind: "all" },
        "auto-local",
        "messages",
      ),
    ).toThrow(NoEligibleModelError)
  })
})

describe("catalog refresh ordering", () => {
  test("a mutation during an older read prevents that snapshot from replacing current", async () => {
    const pending: Array<
      (value: { readonly revision: string; readonly payload: unknown } | undefined) => void
    > = []
    const store = createCapabilityCatalogStore({
      initialCatalog: applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, null),
      loadPublishedSnapshot: () => {
        const deferred = Promise.withResolvers<
          { readonly revision: string; readonly payload: unknown } | undefined
        >()
        pending.push(deferred.resolve)
        return deferred.promise
      },
      refreshIntervalMs: 3_600_000,
    })
    const stale = compileCapabilitySnapshot([], {
      generatedAt: NOW,
      routeModels: storedRows(
        parseLlamaSwapModelList(list(entry("stale", "acme/stale"))).descriptors,
      ),
    }).snapshot
    const fresh = compileCapabilitySnapshot([], {
      generatedAt: NOW,
      routeModels: storedRows(
        parseLlamaSwapModelList(list(entry("fresh", "acme/fresh"))).descriptors,
      ),
    }).snapshot

    const firstRefresh = store.refresh()
    await Promise.resolve()
    const afterMutation = store.refreshAfterMutation()
    pending[0]?.({ revision: stale.revision, payload: stale })
    for (let attempt = 0; attempt < 8 && pending.length < 2; attempt++) {
      await Promise.resolve()
    }
    expect(pending).toHaveLength(2)
    expect(store.resolve("stale")).toBeNull()
    pending[1]?.({ revision: fresh.revision, payload: fresh })
    await Promise.all([firstRefresh, afterMutation])

    expect(store.resolve("stale")).toBeNull()
    expect(store.resolve("fresh")?.id).toBe("acme/fresh")
    expect(store.publishedSnapshotRevision()).toBe(fresh.revision)
  })

  test("an invalid snapshot cannot partially replace the held catalog", async () => {
    const initial = applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, null)
    const store = createCapabilityCatalogStore({
      initialCatalog: initial,
      loadPublishedSnapshot: async () => ({ revision: "invalid", payload: {} }),
      refreshIntervalMs: 3_600_000,
    })

    await expect(store.refresh()).rejects.toThrow()
    expect(store.list()).toEqual(initial.list())
    expect(store.revision()).toEqual(initial.revision())
    expect(store.publishedSnapshotRevision()).toBeNull()
    store.stop()
  })
})

describe("request-path isolation", () => {
  const realFetch = globalThis.fetch
  let restoreCompile: (() => void) | undefined
  afterEach(() => {
    globalThis.fetch = realFetch
    restoreCompile?.()
    restoreCompile = undefined
  })

  test("serving inference and selection never touches discovery, the repository or the network", async () => {
    const repo = createMemoryCapabilityRepo()
    let discoveries = 0
    const host = createLlamaSwapDiscoverySource({
      baseUrl: "http://host/v1",
      fetch: (async () => {
        discoveries += 1
        return asJson(dockerlmListing())
      }) as unknown as typeof fetch,
    })
    // Boot the way production does: discovery runs in a sync, the router adopts the snapshot.
    await syncCapabilityIntelligence({
      repository: repo,
      sources: [],
      routeSources: [host],
      now: () => NOW,
    })
    expect(discoveries).toBe(1)

    let repositoryReads = 0
    const store: CapabilityCatalogStore = createCapabilityCatalogStore({
      initialCatalog: applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, null),
      loadPublishedSnapshot: async () => {
        repositoryReads += 1
        const pub = await repo.getPublishedSnapshot()
        return pub
          ? { revision: pub.revision, payload: pub.payload as CompiledCapabilitySnapshotPayload }
          : undefined
      },
      refreshIntervalMs: 3_600_000,
    })
    await store.refresh()
    const reads = repositoryReads
    expect(store.resolve("qwen3.8-27b")?.origin).toBe("discovered")

    // From here on, any network call or repository query is a failure.
    let networkCalls = 0
    globalThis.fetch = (async () => {
      networkCalls += 1
      throw new Error("network during inference")
    }) as unknown as typeof fetch

    const models = dockerlmDescriptors().map((d) => d.routeModelId)
    const scope = routingCatalog([account("host", { snapshot: { supportedModels: [...models] } })])
    for (const descriptor of virtualModels()) {
      try {
        chooseModel({ capabilities: store }, scope, { kind: "all" }, descriptor.id, "messages")
      } catch (error) {
        expect(error).toBeInstanceOf(NoEligibleModelError)
      }
      selectVirtualModel(store, descriptor, models)
    }

    expect(discoveries).toBe(1)
    expect(repositoryReads).toBe(reads)
    expect(networkCalls).toBe(0)
    store.stop()
  })

  test("a real inference request cannot discover, load, compile or fetch catalog state", async () => {
    const repo = createMemoryCapabilityRepo()
    let discoveries = 0
    const host = createLlamaSwapDiscoverySource({
      baseUrl: "http://host/v1",
      fetch: (async () => {
        discoveries += 1
        return asJson(dockerlmListing())
      }) as unknown as typeof fetch,
    })
    await syncCapabilityIntelligence({
      repository: repo,
      sources: [],
      routeSources: [host],
      now: () => NOW,
    })

    let repositoryReads = 0
    let requestPhase = false
    const store = createCapabilityCatalogStore({
      initialCatalog: applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, null),
      loadPublishedSnapshot: async () => {
        if (requestPhase) throw new Error("repository access during inference")
        repositoryReads += 1
        const published = await repo.getPublishedSnapshot()
        return published
          ? {
              revision: published.revision,
              payload: published.payload as CompiledCapabilitySnapshotPayload,
            }
          : undefined
      },
      refreshIntervalMs: 3_600_000,
    })
    await store.refresh()
    const readsBeforeRequest = repositoryReads
    requestPhase = true
    let unexpectedNetworkCalls = 0
    globalThis.fetch = (async () => {
      unexpectedNetworkCalls += 1
      throw new Error("network access during inference")
    }) as unknown as typeof fetch
    const compile = spyOn(compiler, "compileCapabilitySnapshot").mockImplementation(() => {
      throw new Error("catalog compilation during inference")
    })
    restoreCompile = () => compile.mockRestore()
    const models = dockerlmDescriptors().map((descriptor) => descriptor.routeModelId)
    const { app, upstream } = harness({
      accounts: [
        account("dockerlm", {
          provider: "openai-api",
          apiKey: "sk-test",
          cipher: CRYPTOR,
          snapshot: { supportedModels: models },
        }),
      ],
      responses: [() => jsonResponse(200, { choices: [{ message: { content: "ok" } }] })],
      capabilities: store,
    })

    const response = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: "auto-local",
          messages: [{ role: "user", content: "hello" }],
        }),
        bearer(),
      ),
    )
    await response.text()

    expect(response.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(JSON.parse(upstream.calls[0]?.body ?? "{}").model).not.toBe("auto-local")
    expect(discoveries).toBe(1)
    expect(repositoryReads).toBe(readsBeforeRequest)
    expect(unexpectedNetworkCalls).toBe(0)
    expect(compile).not.toHaveBeenCalled()
    store.stop()
  })
})
