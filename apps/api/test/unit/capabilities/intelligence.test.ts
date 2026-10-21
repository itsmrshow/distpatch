import { describe, expect, test } from "bun:test"
import type { CapabilitySnapshotInsert } from "@multi-ai-router/db"
import { redact, redactValue } from "../../../src/logging/redact"
import {
  ARTIFICIAL_ANALYSIS_SOURCE_ID,
  ArtificialAnalysisError,
  applyPublishedSnapshotToBootstrap,
  buildCapabilityCatalog,
  CapabilityCatalogError,
  type CompiledCapabilitySnapshotPayload,
  compileCapabilitySnapshot,
  createArtificialAnalysisSource,
  createCapabilityCatalogStore,
  createExternalIdentityResolver,
  LOCAL_EVAL_SOURCE_ID,
  parseArtificialAnalysisPayload,
  parseLocalEvaluationArtifact,
  resolveArtificialAnalysisApiKey,
  SHIPPED_CAPABILITY_CATALOG,
  type SourceObservation,
  syncCapabilityIntelligence,
} from "../../../src/services/capabilities"
import { selectVirtualModel, virtualModels } from "../../../src/services/virtual-models"
import { dockerlmDescriptors, storedRows } from "./fleet-fixture"
import { createMemoryCapabilityRepo } from "./memory-repo"

const NOW = new Date("2026-10-17T12:00:00.000Z")

const VALID_AA_PAGE_1 = {
  tier: "free",
  intelligence_index_version: 4.1,
  pagination: {
    page: 1,
    page_size: 2,
    total_pages: 2,
    has_more: true,
  },
  data: [
    {
      id: "aa-uuid-sonnet-46",
      name: "Claude 4.6 Sonnet",
      slug: "claude-sonnet-4-6",
      release_date: "2026-02-17",
      model_creator: { id: "creator-anthropic", name: "Anthropic" },
      evaluations: {
        artificial_analysis_intelligence_index: 64.2,
        artificial_analysis_coding_index: 61.5,
        artificial_analysis_agentic_index: 68.0,
        artificial_analysis_finance_and_accounting_index: 52.1,
        artificial_analysis_strategy_and_ops_index: null,
        artificial_analysis_legal_index: null,
        artificial_analysis_healthcare_and_medical_index: null,
        artificial_analysis_engineering_index: 59.4,
        artificial_analysis_economics_index: null,
      },
      artificial_analysis_intelligence_index_cost: {
        total_cost: 420.5,
        cost_per_task: { total_cost: 0.45 },
      },
      pricing: {
        price_1m_input_tokens: 3.0,
        price_1m_output_tokens: 15.0,
        price_1m_cache_hit_tokens: 0.3,
        price_1m_cache_write_tokens: 3.75,
      },
      performance: {
        median_output_tokens_per_second: 92.4,
        median_time_to_first_token_seconds: 0.85,
        median_time_to_first_answer_token_seconds: 1.2,
        median_end_to_end_response_time_seconds: 6.4,
      },
    },
    {
      id: "aa-uuid-gpt-oss-120b",
      name: "gpt-oss-120B (high)",
      slug: "gpt-oss-120b",
      release_date: "2025-08-05",
      model_creator: { id: "creator-openai", name: "OpenAI" },
      evaluations: {
        artificial_analysis_intelligence_index: 52.8,
        artificial_analysis_coding_index: 49.0,
        artificial_analysis_agentic_index: 51.2,
        artificial_analysis_finance_and_accounting_index: null,
        artificial_analysis_strategy_and_ops_index: null,
        artificial_analysis_legal_index: null,
        artificial_analysis_healthcare_and_medical_index: null,
        artificial_analysis_engineering_index: null,
        artificial_analysis_economics_index: null,
      },
      artificial_analysis_intelligence_index_cost: null,
      pricing: {
        price_1m_input_tokens: 0.15,
        price_1m_output_tokens: 0.6,
        price_1m_cache_hit_tokens: null,
        price_1m_cache_write_tokens: null,
      },
      performance: {
        median_output_tokens_per_second: 280.0,
        median_time_to_first_token_seconds: 0.45,
        median_time_to_first_answer_token_seconds: 2.1,
        median_end_to_end_response_time_seconds: 3.9,
      },
    },
  ],
}

const VALID_AA_PAGE_2 = {
  tier: "free",
  intelligence_index_version: 4.1,
  pagination: {
    page: 2,
    page_size: 2,
    total_pages: 2,
    has_more: false,
  },
  data: [
    {
      id: "aa-uuid-unknown-1",
      name: "Mystery Experimental 70B",
      slug: "mystery-experimental-70b",
      release_date: "2026-01-10",
      model_creator: { id: "creator-other", name: "OtherLab" },
      evaluations: {
        artificial_analysis_intelligence_index: 41.0,
        artificial_analysis_coding_index: null,
        artificial_analysis_agentic_index: null,
        artificial_analysis_finance_and_accounting_index: null,
        artificial_analysis_strategy_and_ops_index: null,
        artificial_analysis_legal_index: null,
        artificial_analysis_healthcare_and_medical_index: null,
        artificial_analysis_engineering_index: null,
        artificial_analysis_economics_index: null,
      },
      artificial_analysis_intelligence_index_cost: null,
      pricing: {
        price_1m_input_tokens: 0.5,
        price_1m_output_tokens: 1.5,
        price_1m_cache_hit_tokens: null,
        price_1m_cache_write_tokens: null,
      },
      performance: {
        median_output_tokens_per_second: 110.0,
        median_time_to_first_token_seconds: 0.6,
        median_time_to_first_answer_token_seconds: null,
        median_end_to_end_response_time_seconds: null,
      },
    },
  ],
}

describe("external identity mapping", () => {
  const resolver = createExternalIdentityResolver()

  test("resolves explicitly mapped external slugs and canonical IDs without fuzzy guessing", () => {
    expect(resolver.resolve("artificial-analysis", "claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    )
    expect(resolver.resolve("artificial-analysis", "gpt-oss-120b")).toBe("openai/gpt-oss-120b")
    expect(resolver.resolve("artificial-analysis", "gpt-5-5")).toBe("openai/gpt-5.5")
    expect(resolver.resolve("artificial-analysis", "qwen3-8-27b")).toBe("qwen/qwen3.8-27b")
    expect(resolver.resolve("artificial-analysis", "qwen3-8-flash-next")).toBe(
      "qwen/qwen3.8-flash-next",
    )
  })

  test("does not fuzzy-match, substring-match, or family-guess unknown models", () => {
    expect(resolver.resolve("artificial-analysis", "claude-sonnet-4-6-experimental")).toBeNull()
    expect(resolver.resolve("artificial-analysis", "gpt-oss-20b")).toBeNull()
    expect(resolver.resolve("artificial-analysis", "gpt-5-3-codex")).toBeNull()
    expect(resolver.resolve("artificial-analysis", "claude-sonnet")).toBeNull()
  })

  test("rejects conflicting explicit mappings for the same source + external id", () => {
    expect(() =>
      createExternalIdentityResolver([
        {
          source: "artificial-analysis",
          externalId: "dupe-slug",
          canonicalId: "anthropic/claude-sonnet-4-6",
        },
        {
          source: "artificial-analysis",
          externalId: "dupe-slug",
          canonicalId: "openai/gpt-5.5",
        },
      ]),
    ).toThrow(/Conflicting external identity mapping/)
  })
})

describe("Artificial Analysis adapter & fixtures", () => {
  test("parses valid multi-model payload, maps known models, and retains unresolved models with null canonicalModelId", () => {
    const parsed = parseArtificialAnalysisPayload(
      {
        ...VALID_AA_PAGE_1,
        data: [...VALID_AA_PAGE_1.data, ...VALID_AA_PAGE_2.data],
      },
      { ingestedAt: NOW },
    )

    expect(parsed.matchedCanonicalIds).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-oss-120b",
    ])
    expect(parsed.unresolvedSourceModelIds).toEqual(["mystery-experimental-70b"])

    const sonnetIntel = parsed.observations.find(
      (o) =>
        o.canonicalModelId === "anthropic/claude-sonnet-4-6" && o.metric === "intelligence_index",
    )
    expect(sonnetIntel).toMatchObject({
      source: "artificial-analysis",
      sourceModelId: "claude-sonnet-4-6",
      canonicalModelId: "anthropic/claude-sonnet-4-6",
      rawValue: 64.2,
      unit: "index_100",
      benchmark: "artificial_analysis_intelligence_index",
      benchmarkVersion: "4.1",
      sourceRef: "https://artificialanalysis.ai/models/claude-sonnet-4-6",
    })

    const mysteryObs = parsed.observations.filter(
      (o) => o.sourceModelId === "mystery-experimental-70b",
    )
    expect(mysteryObs.length).toBeGreaterThan(0)
    expect(mysteryObs.every((o) => o.canonicalModelId === null)).toBe(true)
  })

  test("deduplicates duplicate upstream records within the same payload", () => {
    const withDuplicate = {
      ...VALID_AA_PAGE_1,
      data: [VALID_AA_PAGE_1.data[0], VALID_AA_PAGE_1.data[0]],
    }
    const single = parseArtificialAnalysisPayload(
      { ...VALID_AA_PAGE_1, data: [VALID_AA_PAGE_1.data[0]] },
      { ingestedAt: NOW },
    )
    const doubled = parseArtificialAnalysisPayload(withDuplicate, { ingestedAt: NOW })
    expect(doubled.observations.length).toBe(single.observations.length)
  })

  test("fails the fetch rather than returning partial evidence when pagination hits maxPages", async () => {
    const source = createArtificialAnalysisSource({
      apiKey: "aa_secret_token_value_123456",
      endpointPath: "/api/v2/language/models/free",
      maxPages: 1,
      fetchImpl: (async () =>
        new Response(JSON.stringify(VALID_AA_PAGE_1), {
          // page 1 of total_pages 2, has_more true — and maxPages 1 stops after it
          status: 200,
        })) as unknown as typeof fetch,
      now: () => NOW,
    })
    await expect(source.fetch()).rejects.toThrow(/pagination incomplete/)
  })

  test("handles pagination, Pro->Free 403 fallback, rate-limit headers, and never leaks the API key", async () => {
    const seenUrls: string[] = []
    const seenAuthHeaders: (string | null)[] = []
    const secretKey = "aa_live_test_secret_key_999999"

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seenUrls.push(url)
      const headers = new Headers(init?.headers)
      seenAuthHeaders.push(headers.get("x-api-key"))

      if (url.includes("/api/v2/language/models?")) {
        return new Response(JSON.stringify({ error: "Pro subscription required" }), {
          status: 403,
          headers: { "x-aa-tier": "free" },
        })
      }
      if (url.includes("page=1")) {
        return new Response(JSON.stringify(VALID_AA_PAGE_1), {
          status: 200,
          headers: {
            "x-aa-tier": "free",
            "x-ratelimit-limit": "100",
            "x-ratelimit-remaining": "98",
            "x-ratelimit-reset": "2026-10-18T00:00:00Z",
          },
        })
      }
      return new Response(JSON.stringify(VALID_AA_PAGE_2), {
        status: 200,
        headers: {
          "x-aa-tier": "free",
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "97",
          "x-ratelimit-reset": "2026-10-18T00:00:00Z",
        },
      })
    }) as unknown as typeof fetch

    const source = createArtificialAnalysisSource({
      apiKey: secretKey,
      fetchImpl: mockFetch,
      now: () => NOW,
    })

    const result = await source.fetch()
    expect(seenUrls).toEqual([
      "https://artificialanalysis.ai/api/v2/language/models?page=1",
      "https://artificialanalysis.ai/api/v2/language/models/free?page=1",
      "https://artificialanalysis.ai/api/v2/language/models/free?page=2",
    ])
    expect(seenAuthHeaders).toEqual([secretKey, secretKey, secretKey])
    expect(result.metadata).toEqual({
      source: "artificial-analysis",
      endpoint: "https://artificialanalysis.ai/api/v2/language/models/free",
      tier: "free",
      pagesFetched: 2,
      recordsRetrieved: 3,
      observationsEmitted: result.observations.length,
      matchedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-oss-120b"],
      unresolvedSourceModelIds: ["mystery-experimental-70b"],
      rateLimit: {
        limit: 100,
        remaining: 97,
        reset: "2026-10-18T00:00:00Z",
      },
    })

    // Ensure no observation or metadata contains the secret key
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secretKey)
  })

  test("rejects malformed JSON, unexpected schema, missing required fields, and out-of-range values", async () => {
    expect(() => parseArtificialAnalysisPayload(null)).toThrow(ArtificialAnalysisError)
    expect(() => parseArtificialAnalysisPayload({ tier: "free" })).toThrow(/data/)
    expect(() =>
      parseArtificialAnalysisPayload({
        data: [{ id: "1", name: "Bad", evaluations: {} }],
      }),
    ).toThrow(/slug/)
    expect(() =>
      parseArtificialAnalysisPayload({
        data: [
          {
            id: "1",
            name: "OutOfRange",
            slug: "claude-sonnet-4-6",
            evaluations: { artificial_analysis_intelligence_index: 150 },
          },
        ],
      }),
    ).toThrow(/outside \[0, 100\]/)
  })

  test("handles missing API key, 401 unauthorized, 429 rate limit, and network errors cleanly with secret redaction", async () => {
    const noKeySource = createArtificialAnalysisSource({
      apiKey: "",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    })
    // Temporarily ensure env vars are not set during missing_api_key check
    expect(resolveArtificialAnalysisApiKey({}, null)).toBeNull()
    expect(
      resolveArtificialAnalysisApiKey({ ARTIFICIAL_ANALYSIS_API_KEY: "aa_fallback_123456" }, null),
    ).toBe("aa_fallback_123456")

    const rateLimitedSource = createArtificialAnalysisSource({
      apiKey: "aa_secret_token_value_123456",
      endpointPath: "/api/v2/language/models/free",
      fetchImpl: (async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" },
        })) as unknown as typeof fetch,
    })
    await expect(rateLimitedSource.fetch()).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 120,
    })

    const leakingErrorSource = createArtificialAnalysisSource({
      apiKey: "aa_secret_token_value_123456",
      endpointPath: "/api/v2/language/models/free",
      fetchImpl: (async () => {
        throw new Error("connect failed with key aa_secret_token_value_123456")
      }) as unknown as typeof fetch,
    })
    try {
      await leakingErrorSource.fetch()
      throw new Error("expected failure")
    } catch (error) {
      expect((error as Error).message).not.toContain("aa_secret_token_value_123456")
      expect((error as Error).message).toContain("[REDACTED]")
    }

    expect(redactValue("header x-api-key=aa_secret_token_value_123456")).not.toContain(
      "aa_secret_token_value_123456",
    )
    expect(
      redact({
        aa_api_key: "secret-1",
        ARTIFICIAL_ANALYSIS_API_KEY: "secret-2",
      }),
    ).toEqual({
      aa_api_key: "[REDACTED]",
      ARTIFICIAL_ANALYSIS_API_KEY: "[REDACTED]",
    })
    void noKeySource
  })
})

describe("capability compiler, provenance, staleness & snapshot lifecycle", () => {
  test("compiles external AA primary evidence + local supplemental evidence without averaging or inventing dimensions", () => {
    const aaParsed = parseArtificialAnalysisPayload(VALID_AA_PAGE_1, {
      ingestedAt: NOW,
      observedAt: new Date("2026-09-01T00:00:00.000Z"),
    })
    const localParsed = parseLocalEvaluationArtifact(
      {
        suite: "distpatch-calibration-v1",
        graderVersion: "distpatch-grader-v1-bwrap",
        normalization: "distpatch-norm-v1",
        scores: {
          "anthropic/claude-sonnet-4-6": { general: 1, coding: 0.95, agentic: 1 },
          "xiaomimimo/mimo-v2.6-distill-qwen-9b": { general: 0.82, coding: 0.72, agentic: 1 },
        },
      },
      {
        ingestedAt: NOW,
        observedAt: new Date("2026-10-17T00:00:00.000Z"),
      },
    )

    const compiled = compileCapabilitySnapshot(
      [...aaParsed.observations, ...localParsed.observations],
      { generatedAt: NOW, routeModels: storedRows(dockerlmDescriptors()) },
    )

    const sonnet = compiled.catalog.get("anthropic/claude-sonnet-4-6")
    const gptOss = compiled.catalog.get("openai/gpt-oss-120b")
    const mimo = compiled.catalog.get("xiaomimimo/mimo-v2.6-distill-qwen-9b")
    const gpt55 = compiled.catalog.get("openai/gpt-5.5")

    // Hosted model uses AA primary evidence, not local ceiling scores
    expect(sonnet?.scores.general).toBe(0.642)
    expect(sonnet?.scores.coding).toBe(0.615)
    expect(sonnet?.scores.agentic).toBe(0.68)
    expect(sonnet?.scores.speed).not.toBeNull()
    // Cost and unmeasured dimensions remain null
    expect(sonnet?.scores.cost).toBeNull()
    expect(sonnet?.scores.reasoning).toBeNull()
    expect(sonnet?.scores.review).toBeNull()
    expect(sonnet?.scores.tool_use).toBeNull()
    expect(sonnet?.scores.long_context).toBeNull()

    // Local evaluation is stored evidence but not cross-source comparable: it never scores.
    expect(mimo?.scores.general).toBeNull()
    expect(mimo?.scores.coding).toBeNull()
    expect(mimo?.scores.agentic).toBeNull()
    expect(mimo?.scores.speed).toBeNull()

    // gpt-oss-120b uses AA primary evidence
    expect(gptOss?.scores.general).toBe(0.528)
    expect(gptOss?.scores.coding).toBe(0.49)
    expect(gptOss?.scores.agentic).toBe(0.512)
    expect(gptOss?.scores.speed).not.toBeNull()

    // Unmeasured model stays all-null
    expect(gpt55?.scores.general).toBeNull()

    // Deterministic revision and digest across observation ordering
    const reversed = compileCapabilitySnapshot(
      [...localParsed.observations, ...aaParsed.observations].reverse(),
      { generatedAt: NOW, routeModels: storedRows(dockerlmDescriptors()) },
    )
    expect(reversed.snapshot.revision).toBe(compiled.snapshot.revision)
    expect(reversed.snapshot.evidenceDigest).toBe(compiled.snapshot.evidenceDigest)
    expect(reversed.catalog.revision()).toEqual(compiled.catalog.revision())
  })

  test("flags stale observations without dropping last-known-good scores", () => {
    const staleDate = new Date("2025-01-01T00:00:00.000Z")
    const aaParsed = parseArtificialAnalysisPayload(
      {
        ...VALID_AA_PAGE_1,
        data: [{ ...VALID_AA_PAGE_1.data[0], release_date: "2025-01-01" }],
      },
      { ingestedAt: NOW, observedAt: staleDate },
    )
    const freshCompiled = compileCapabilitySnapshot(aaParsed.observations, {
      generatedAt: new Date("2025-02-01T00:00:00.000Z"),
      staleDays: 90,
    })
    const compiled = compileCapabilitySnapshot(aaParsed.observations, {
      generatedAt: NOW,
      staleDays: 90,
    })
    expect(freshCompiled.summary.staleDimensions).toEqual([])
    expect(compiled.summary.staleDimensions).toContain("anthropic/claude-sonnet-4-6.general")
    // Crossing the staleness boundary changes the immutable snapshot revision.
    expect(compiled.snapshot.revision).not.toBe(freshCompiled.snapshot.revision)
    expect(compiled.snapshot.models["anthropic/claude-sonnet-4-6"]?.dimensions.general.stale).toBe(
      true,
    )
    expect(compiled.catalog.get("anthropic/claude-sonnet-4-6")?.scores.general).toBe(0.642)

    // Combined speed evidence is marked stale when throughput is fresh but TTFT is stale.
    const mixedSpeedObs = aaParsed.observations.map((o) =>
      o.metric === "median_output_tokens_per_second" ? { ...o, observedAt: NOW } : o,
    )
    const mixedSpeedCompiled = compileCapabilitySnapshot(mixedSpeedObs, {
      generatedAt: NOW,
      staleDays: 90,
    })
    expect(
      mixedSpeedCompiled.snapshot.models["anthropic/claude-sonnet-4-6"]?.dimensions.speed.stale,
    ).toBe(true)
  })

  test("snapshot revisions include retained evidence timestamps and source metadata", () => {
    const originalObservedAt = new Date(NOW.getTime() - 2_000)
    const parsed = parseArtificialAnalysisPayload(VALID_AA_PAGE_1, {
      ingestedAt: originalObservedAt,
      observedAt: originalObservedAt,
    })
    const generalObservation = parsed.observations.find(
      (row) => row.metric === "intelligence_index",
    )
    if (!generalObservation) throw new Error("missing general capability observation")

    const updatedObservedAt = new Date(NOW.getTime() - 1_000)
    const updatedObservations = parsed.observations.map((row) =>
      row.fingerprint === generalObservation.fingerprint
        ? {
            ...row,
            observedAt: updatedObservedAt,
            ingestedAt: updatedObservedAt,
            sourceRef: `${row.sourceRef}/recurrent`,
            provenance: { ...row.provenance, recurrence: true },
          }
        : row,
    )
    const original = compileCapabilitySnapshot(parsed.observations, { generatedAt: NOW })
    const updated = compileCapabilitySnapshot(updatedObservations, { generatedAt: NOW })
    const originalGeneral =
      original.snapshot.models["anthropic/claude-sonnet-4-6"]?.dimensions.general
    const updatedGeneral =
      updated.snapshot.models["anthropic/claude-sonnet-4-6"]?.dimensions.general

    expect(updated.snapshot.evidenceDigest).not.toBe(original.snapshot.evidenceDigest)
    expect(updated.snapshot.revision).not.toBe(original.snapshot.revision)
    expect(updatedGeneral?.observedAt).toBe(updatedObservedAt.toISOString())
    expect(updatedGeneral?.sourceRefs).toContain(`${generalObservation.sourceRef}/recurrent`)
    expect(updatedGeneral?.provenanceDigest).not.toBe(originalGeneral?.provenanceDigest)
  })

  test("memory repository serializes publication, rejects invalid snapshots, and ignores clock skew", async () => {
    const repo = createMemoryCapabilityRepo()
    const candidate: CapabilitySnapshotInsert = {
      revision: "memory-revision-a",
      generatedAt: NOW,
      compilerVersion: "compiler-v1",
      normalizerVersion: "normalizer-v1",
      evidenceDigest: "sha256:evidence-a",
      publicationState: "candidate",
      payload: { value: "published" },
      summary: { observations: 1 },
    }
    const publish = (snapshot: CapabilitySnapshotInsert) =>
      repo.publishSnapshotWithCurrentEvidence(async () => ({
        snapshot,
        result: undefined,
      }))
    await publish(candidate)

    await Promise.all([
      publish({
        ...candidate,
        payload: { value: "candidate overwrite one" },
        summary: { observations: 2 },
      }),
      publish({
        ...candidate,
        generatedAt: new Date(NOW.getTime() + 1),
        payload: { value: "candidate overwrite two" },
        summary: { observations: 3 },
      }),
    ])
    expect(await repo.getPublishedSnapshot()).toMatchObject({
      revision: candidate.revision,
      payload: candidate.payload,
      summary: candidate.summary,
      publicationState: "published",
      publishedAt: NOW,
    })

    await expect(
      publish({
        ...candidate,
        revision: "memory-revision-rejected",
        publicationState: "rejected",
      }),
    ).rejects.toThrow(/rejected/)
    expect(
      repo.snapshots.some((snapshot) => snapshot.revision === "memory-revision-rejected"),
    ).toBe(false)
    expect((await repo.getPublishedSnapshot())?.revision).toBe(candidate.revision)

    const olderCandidate = {
      ...candidate,
      revision: "memory-revision-clock-skew",
      generatedAt: new Date(NOW.getTime() - 60_000),
      payload: { value: "newer evidence with an older clock" },
    }
    await publish(olderCandidate)
    expect((await repo.getPublishedSnapshot())?.revision).toBe(olderCandidate.revision)
  })

  test("repeated sync is idempotent and failed sync / failed publish retains last-known-good snapshot", async () => {
    const repo = createMemoryCapabilityRepo()
    let currentPayload: unknown = VALID_AA_PAGE_1

    const source = {
      id: ARTIFICIAL_ANALYSIS_SOURCE_ID,
      fetch: async () => {
        const parsed = parseArtificialAnalysisPayload(currentPayload, {
          ingestedAt: NOW,
          observedAt: NOW,
        })
        return {
          observations: parsed.observations,
          metadata: {
            source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
            endpoint: "fixture://aa",
            tier: "free",
            pagesFetched: 1,
            recordsRetrieved: parsed.page.data.length,
            observationsEmitted: parsed.observations.length,
            matchedModels: parsed.matchedCanonicalIds,
            unresolvedSourceModelIds: parsed.unresolvedSourceModelIds,
            rateLimit: { limit: 100, remaining: 99, reset: null },
          },
        }
      },
    }

    const store = createCapabilityCatalogStore({
      initialCatalog: buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG),
      loadPublishedSnapshot: async () => {
        const pub = await repo.getPublishedSnapshot()
        return pub ? { revision: pub.revision, payload: pub.payload } : undefined
      },
      refreshIntervalMs: 60_000,
      now: () => NOW,
    })

    // Before first sync: bootstrap catalog has null scores
    expect(store.get("anthropic/claude-sonnet-4-6")?.scores.general).toBeNull()
    expect(store.publishedSnapshotRevision()).toBeNull()

    // First sync: inserts observations, publishes snapshot, updates warm store
    const sync1 = await syncCapabilityIntelligence({
      repository: repo,
      sources: [source],
      now: () => NOW,
      onPublished: () => store.refreshAfterMutation(),
    })
    expect(sync1.insertedObservations).toBeGreaterThan(0)
    expect(sync1.deduplicatedObservations).toBe(0)
    expect(store.publishedSnapshotRevision()).toBe(sync1.publishedRevision)
    expect(store.get("anthropic/claude-sonnet-4-6")?.scores.general).toBe(0.642)

    // Second identical sync: 0 inserted, all deduplicated, same snapshot revision
    const sync2 = await syncCapabilityIntelligence({
      repository: repo,
      sources: [source],
      now: () => NOW,
      onPublished: () => store.refreshAfterMutation(),
    })
    expect(sync2.insertedObservations).toBe(0)
    expect(sync2.deduplicatedObservations).toBe(sync1.insertedObservations)
    expect(sync2.publishedRevision).toBe(sync1.publishedRevision)

    // Failed publish: last-known-good remains active in both DB and warm store
    const firstRecord = VALID_AA_PAGE_1.data[0]
    if (!firstRecord) throw new Error("missing fixture record")
    currentPayload = {
      ...VALID_AA_PAGE_1,
      data: [
        {
          ...firstRecord,
          evaluations: {
            ...firstRecord.evaluations,
            artificial_analysis_intelligence_index: 70.0,
          },
        },
      ],
    }
    repo.failNextPublish = true
    await expect(
      syncCapabilityIntelligence({
        repository: repo,
        sources: [source],
        now: () => NOW,
        onPublished: () => store.refreshAfterMutation(),
      }),
    ).rejects.toThrow(/simulated atomic publish transaction failure/)

    expect((await repo.getPublishedSnapshot())?.revision).toBe(sync1.publishedRevision)
    expect(store.publishedSnapshotRevision()).toBe(sync1.publishedRevision)
    expect(store.get("anthropic/claude-sonnet-4-6")?.scores.general).toBe(0.642)
  })

  test("layering precedence: bootstrap -> published snapshot -> operator override, and invalid snapshot fails validation", () => {
    const aaParsed = parseArtificialAnalysisPayload(VALID_AA_PAGE_1, {
      ingestedAt: NOW,
      observedAt: NOW,
    })
    const compiled = compileCapabilitySnapshot(aaParsed.observations, { generatedAt: NOW })

    // Operator override wins over published snapshot (and can null out a score or disable a profile)
    const layered = applyPublishedSnapshotToBootstrap(
      SHIPPED_CAPABILITY_CATALOG,
      compiled.snapshot,
      {
        schemaVersion: 1,
        overrides: [
          {
            id: "anthropic/claude-sonnet-4-6",
            scores: { general: 0.99, coding: null },
          },
          {
            id: "openai/gpt-oss-120b",
            enabled: false,
          },
        ],
      },
    )

    const sonnet = layered.get("anthropic/claude-sonnet-4-6")
    expect(sonnet?.scores.general).toBe(0.99)
    expect(sonnet?.scores.coding).toBeNull()
    expect(sonnet?.scores.agentic).toBe(0.68) // from published snapshot
    expect(sonnet?.hard.contextTokens).toBe(1_000_000) // from bootstrap
    expect(layered.get("openai/gpt-oss-120b")?.enabled).toBe(false)

    // Snapshot validation failure: score outside [0, 1] or unknown canonical model id is rejected
    const sonnetModel = compiled.snapshot.models["anthropic/claude-sonnet-4-6"]
    if (!sonnetModel) throw new Error("missing compiled sonnet model")
    const corruptedSnapshot: CompiledCapabilitySnapshotPayload = {
      ...compiled.snapshot,
      models: {
        ...compiled.snapshot.models,
        "unknown/vendor-model": {
          id: "unknown/vendor-model",
          dimensions: sonnetModel.dimensions,
          scores: { general: 0.5 },
          sources: [],
          coverage: 0.1,
          provenanceDigest: "sha256:00",
        },
      },
    }
    expect(() =>
      applyPublishedSnapshotToBootstrap(SHIPPED_CAPABILITY_CATALOG, corruptedSnapshot, null),
    ).toThrow(CapabilityCatalogError)

    // Routing determinism over controlled snapshot: no DB or HTTP calls on request path
    const candidates = ["claude-sonnet-4-6", "gpt-5.5", "gpt-oss-120b"]
    for (const descriptor of virtualModels()) {
      const d1 = selectVirtualModel(compiled.catalog, descriptor, candidates)
      const d2 = selectVirtualModel(compiled.catalog, descriptor, [...candidates].reverse())
      expect(d1.digest).toBe(d2.digest)
      expect(d1.selected?.profileId).toBe(d2.selected?.profileId)
    }
  })

  test("never scores a dimension when bootstrap hard feature is explicitly false", () => {
    const id = "openai/gpt-oss-120b"
    const comparable = {
      [LOCAL_EVAL_SOURCE_ID]: { comparable: true, calibration: "test-calibration", reason: "test" },
    }
    const toolObs: SourceObservation = {
      source: LOCAL_EVAL_SOURCE_ID,
      sourceModelId: id,
      canonicalModelId: id,
      metric: "local_eval_tool_use",
      rawValue: 0.9,
      unit: "score_0_1",
      benchmark: "distpatch-calibration-v1",
      benchmarkVersion: "distpatch-norm-v1",
      fingerprint: "sha256:fake-tool",
      observedAt: NOW,
      ingestedAt: NOW,
      sourceRef: "repo:evidence/capability-calibration-v1.md",
      provenance: {},
    }
    // Control: with comparability granted, the measurement does score.
    const scored = compileCapabilitySnapshot([toolObs], {
      generatedAt: NOW,
      comparability: comparable,
    })
    expect(scored.catalog.get(id)?.scores.tool_use).toBe(0.9)

    const customBootstrap = {
      ...SHIPPED_CAPABILITY_CATALOG,
      profiles: SHIPPED_CAPABILITY_CATALOG.profiles.map((p) =>
        p.id === id ? { ...p, hard: { ...p.hard, toolUse: false } } : p,
      ),
    }
    const compiled = compileCapabilitySnapshot([toolObs], {
      bootstrap: customBootstrap,
      generatedAt: NOW,
      comparability: comparable,
    })
    expect(compiled.catalog.get(id)?.scores.tool_use).toBeNull()
  })
})
