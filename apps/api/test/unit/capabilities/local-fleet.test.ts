import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NoEligibleModelError } from "@multi-ai-router/core"
import {
  ARTIFICIAL_ANALYSIS_SOURCE_ID,
  applyPublishedSnapshotToBootstrap,
  buildCapabilityCatalog,
  canonicalIdFromRepo,
  compileCapabilitySnapshot,
  createExternalIdentityResolver,
  isProductionComparable,
  LOCAL_EVAL_GRADER_VERSION,
  LOCAL_EVAL_NORMALIZATION_VERSION,
  LOCAL_EVAL_SOURCE_ID,
  LOCAL_EVAL_SUITE_VERSION,
  type ModelCapabilityCatalog,
  parseLocalEvaluationArtifact,
  RouteInventory,
  SHIPPED_CAPABILITY_CATALOG,
  type SourceObservation,
} from "../../../src/services/capabilities"
import { chooseModel, scopedConcreteModels } from "../../../src/services/dataplane"
import { virtualModels } from "../../../src/services/virtual-models"
import { account, catalog as routingCatalog } from "../dataplane/fixtures"
import { dockerlmDescriptors, NOW, storedRows } from "./fleet-fixture"

const INVENTORY_PATH = fileURLToPath(
  new URL("../../../../../evidence/model-inventory/dockerlm.json", import.meta.url),
)
const SCORES_PATH = fileURLToPath(
  new URL("../../../../../evidence/capability-calibration-v1/scores.json", import.meta.url),
)

/** The fleet exactly as discovery would deliver it: the catalog holds no hard-coded local model. */
const descriptors = dockerlmDescriptors()
const ROWS = storedRows(descriptors)
const compile = (
  observations: readonly SourceObservation[],
  options: Parameters<typeof compileCapabilitySnapshot>[1] = {},
) => compileCapabilitySnapshot(observations, { generatedAt: NOW, routeModels: ROWS, ...options })
const catalog = compile([]).catalog
const byRoute = new Map(descriptors.map((d) => [d.routeModelId, d]))
const EMBEDDING_ROUTE = "qwen3-embedding-0.6b"
const generativeRoutes = descriptors
  .filter((d) => d.capabilities.textOutput === true && d.capabilities.embedding !== true)
  .map((d) => d.routeModelId)

function aaObservation(
  sourceModelId: string,
  canonicalModelId: string | null,
  rawValue: number,
): SourceObservation {
  return {
    source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
    sourceModelId,
    canonicalModelId,
    metric: "intelligence_index",
    rawValue,
    unit: "index_0_100",
    benchmark: "aa-intelligence-index",
    benchmarkVersion: "test",
    fingerprint: `sha256:${sourceModelId}`,
    observedAt: NOW,
    ingestedAt: NOW,
    sourceRef: "https://artificialanalysis.ai/models/qwen3-8-27b",
    provenance: {},
  }
}

describe("discovered route models → catalog identity", () => {
  test("discovery yields the six deployed routes, five generative and one embedding", () => {
    expect([...byRoute.keys()].sort()).toEqual([
      "mimo-v2.6-distill-9b",
      "qwen3-embedding-0.6b",
      "qwen3.8-27b",
      "qwen3.8-27b-rvn",
      "qwen36-35b-apex-v21",
      "strata-qwen38-flash-next",
    ])
    expect(generativeRoutes).toHaveLength(5)
    expect(generativeRoutes).not.toContain(EMBEDDING_ROUTE)
  })

  test("the shipped bootstrap hard-codes no local model; every one arrives as `discovered`", () => {
    expect(SHIPPED_CAPABILITY_CATALOG.profiles.some((p) => p.tags?.includes("local"))).toBe(false)
    for (const descriptor of descriptors) {
      expect(catalog.resolve(descriptor.routeModelId)?.origin).toBe("discovered")
    }
  })

  test("every route alias resolves to a lowercase canonical profile with the discovered lineage", () => {
    for (const d of descriptors) {
      const profile = catalog.resolve(d.routeModelId)
      expect(profile?.id).toBe(d.semanticModelId as string)
      expect(profile?.id).toBe(profile?.id.toLowerCase() as string)
      expect(profile?.baseModel).toBe(d.baseModelId === d.semanticModelId ? null : d.baseModelId)
      expect(profile?.tags).toContain("local")
      expect(profile?.id).not.toBe(d.routeModelId)
    }
  })

  test("the flat inventory document and the discovery fixture agree on identity, artifact and runtime", () => {
    const document = RouteInventory.parse(JSON.parse(readFileSync(INVENTORY_PATH, "utf8")))
    expect(document).toHaveLength(descriptors.length)
    for (const entry of document) {
      const d = byRoute.get(entry.exposed_model)
      expect(d?.semanticModelId).toBe(canonicalIdFromRepo(entry.semantic_model))
      expect(d?.artifact?.repository).toBe(entry.artifact_repo)
      expect(d?.artifact?.quantization).toBe(entry.quantization)
      expect(d?.runtime?.name).toBe(entry.runtime.name)
      expect(d?.capabilities.contextTokens).toBe(entry.capabilities.context_tokens)
    }
  })

  test("Hugging Face casing survives only as provenance, never in a canonical id", () => {
    expect(catalog.get("qwen/qwen3.8-flash-next")?.sources).toContain(
      "https://huggingface.co/Qwen/Qwen3.8-Flash-Next",
    )
    for (const profile of catalog.list()) expect(profile.id).toBe(profile.id.toLowerCase())
  })

  test("quantized and runtime-managed routes map to the public semantic model, not a new one", () => {
    for (const [route, id] of [
      ["qwen3.8-27b", "qwen/qwen3.8-27b"],
      ["strata-qwen38-flash-next", "qwen/qwen3.8-flash-next"],
    ] as const) {
      expect(byRoute.get(route)?.semanticModelId).toBe(id)
      expect(catalog.get(id)?.baseModel).toBeNull()
      expect(byRoute.get(route)?.artifact?.quantization).toBeTruthy()
    }
    expect(byRoute.get("qwen3.8-27b")?.runtime?.name).toBe("llamampere")
    expect(byRoute.get("strata-qwen38-flash-next")?.runtime?.name).toBe("strata")
  })

  test("true derivatives keep a distinct profile and name their base", () => {
    for (const [route, base] of [
      ["qwen3.8-27b-rvn", "qwen/qwen3.8-27b"],
      ["qwen36-35b-apex-v21", "qwen/qwen3.6-35b-a3b"],
      ["mimo-v2.6-distill-9b", "qwen/qwen3.5-9b"],
    ] as const) {
      expect(catalog.resolve(route)?.baseModel).toBe(base)
      expect(catalog.resolve(route)?.id).not.toBe(base)
    }
    expect(catalog.resolve("qwen3.8-27b-rvn")?.id).not.toBe(catalog.resolve("qwen3.8-27b")?.id)
  })

  test("unlisted or near-miss names never resolve by fuzzy matching", () => {
    for (const name of ["qwen3.8", "qwen3.8-27b-r", "qwen3.8-27b-rvn-2", "qwen36-35b", "strata"]) {
      expect(catalog.resolve(name)).toBeNull()
    }
  })
})

/** The real request path: scope enumeration, the non-text filter, then the selector. */
const serving = (models: readonly string[]) =>
  routingCatalog([account("fleet", { snapshot: { supportedModels: [...models] } })])
const ALL_ROUTES = descriptors.map((d) => d.routeModelId)
const choose = (capabilities: ModelCapabilityCatalog, id: string, models = ALL_ROUTES) =>
  chooseModel({ capabilities }, serving(models), { kind: "all" }, id, "messages")
/** The decision, or `null` when no candidate is eligible (`auto-task` needs declared tool use). */
const decisionOf = (capabilities: ModelCapabilityCatalog, id: string) => {
  try {
    return choose(capabilities, id).virtual?.decision ?? null
  } catch (error) {
    if (error instanceof NoEligibleModelError) return null
    throw error
  }
}

describe("embedding model is not a generative candidate", () => {
  const embedding = catalog.resolve(EMBEDDING_ROUTE)

  test("its hard facts state what it is: text in, no text out", () => {
    expect(embedding?.id).toBe("qwen/qwen3-embedding-0.6b")
    expect(embedding?.hard.textInput).toBe(true)
    expect(embedding?.hard.textOutput).toBe(false)
    expect(embedding?.tags).toContain("embedding")
  })

  test("it is never enumerated as a virtual candidate", () => {
    expect(scopedConcreteModels(serving(ALL_ROUTES), { kind: "all" }, catalog)).toEqual(
      [...generativeRoutes].sort(),
    )
  })

  test("no active virtual model can select it, whatever else is in scope", () => {
    for (const descriptor of virtualModels()) {
      const decision = decisionOf(catalog, descriptor.id)
      expect(decision?.ranked.map((r) => r.model) ?? []).not.toContain(EMBEDDING_ROUTE)
      expect(decision?.rejected.map((r) => r.model) ?? []).not.toContain(EMBEDDING_ROUTE)
    }
  })

  test("with only the embedding model in scope every virtual model has no candidate", () => {
    for (const descriptor of virtualModels()) {
      expect(() => choose(catalog, descriptor.id, [EMBEDDING_ROUTE])).toThrow(NoEligibleModelError)
    }
  })
})

describe("auto-local over the real local fleet", () => {
  test("every local generative model is a candidate; the embedding model is absent", () => {
    const decision = choose(catalog, "auto-local").virtual?.decision
    expect(decision?.ranked.map((r) => r.model).sort()).toEqual([...generativeRoutes].sort())
    expect(decision?.ranked).toHaveLength(5)
  })

  test("with no comparable evidence nothing is invented: all unknown, ties break deterministically", () => {
    const forward = choose(catalog, "auto-local").virtual?.decision
    const reversed = choose(catalog, "auto-local", [...ALL_ROUTES].reverse()).virtual?.decision
    expect(forward?.digest).toBe(reversed?.digest)
    for (const r of forward?.ranked ?? []) {
      expect(r.score).toBe(0)
      expect(r.coverage).toBe(0)
    }
    const ids = (forward?.ranked ?? []).map((r) => r.profileId)
    expect(ids).toEqual([...ids].sort())
  })

  test("only the public model with explicit AA evidence is ranked above its unscored derivative", () => {
    const resolver = createExternalIdentityResolver()
    const base = resolver.resolve("artificial-analysis", "qwen3-8-27b")
    expect(base).toBe("qwen/qwen3.8-27b")
    const compiled = compile([aaObservation("qwen3-8-27b", base, 34)], {
      generatedAt: NOW,
    })
    const decision = choose(compiled.catalog, "auto-local").virtual?.decision
    expect(decision?.selected?.profileId).toBe("qwen/qwen3.8-27b")
    expect(decision?.selected?.coverage).toBeGreaterThan(0)
    const derivative = decision?.ranked.find((r) => r.model === "qwen3.8-27b-rvn")
    expect(derivative?.score).toBe(0)
    expect(derivative?.coverage).toBe(0)
    expect(
      compiled.catalog.get("0bserverx/qwen3.8-27b-heretic-abliterated-uncensored")?.scores,
    ).toMatchObject({ general: null, coding: null, agentic: null })
  })
})

describe("Artificial Analysis identity for the local fleet", () => {
  const resolver = createExternalIdentityResolver()

  test("explicit mappings exist only for verified public models", () => {
    expect(resolver.resolve("artificial-analysis", "qwen3-8-27b")).toBe("qwen/qwen3.8-27b")
    expect(resolver.resolve("artificial-analysis", "qwen3-8-flash-next")).toBe(
      "qwen/qwen3.8-flash-next",
    )
  })

  test("derivatives and unverified models are never silently mapped to base evidence", () => {
    for (const id of [
      "qwen3-8-27b-heretic",
      "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored",
      "qwen3.8-27b-rvn",
      "qwen3-6-35b-a3b",
      "mimo-v2-6-distill-qwen-9b",
      "mimo-v2-6-distill-9b",
    ]) {
      expect(resolver.resolve("artificial-analysis", id)).toBeNull()
    }
  })
})

describe("Local Evaluation trust boundary", () => {
  const stamped = {
    suite: LOCAL_EVAL_SUITE_VERSION,
    graderVersion: LOCAL_EVAL_GRADER_VERSION,
    normalization: LOCAL_EVAL_NORMALIZATION_VERSION,
    scores: { "mimo/mimo-v2.6-distill-9b": { general: 0.8 } },
  }
  const metrics = (artifact: unknown) =>
    parseLocalEvaluationArtifact(artifact, { ingestedAt: NOW, observedAt: NOW })

  test("a current, fully stamped artifact is accepted as production-eligible evidence", () => {
    const parsed = metrics(stamped)
    expect(parsed.rejections).toEqual([])
    expect(parsed.observations.map((o) => o.metric)).toEqual(["local_eval_general"])
    expect(parsed.observations[0]?.provenance.graderVersion).toBe(LOCAL_EVAL_GRADER_VERSION)
  })

  test.each([
    ["missing grader version", { ...stamped, graderVersion: undefined }],
    ["pre-sandbox grader", { ...stamped, graderVersion: "distpatch-grader-v1-pre-sandbox" }],
    ["incompatible normalization", { ...stamped, normalization: "distpatch-norm-v0" }],
    ["incompatible suite", { ...stamped, suite: "distpatch-calibration-v0" }],
  ])(
    "%s is rejected as production evidence but retained as historical, never as a zero",
    (_name, artifact) => {
      const parsed = metrics(artifact)
      expect(parsed.rejections.length).toBeGreaterThan(0)
      expect(parsed.observations.map((o) => o.metric)).toEqual(["historical_local_eval_general"])
      expect(parsed.observations[0]?.rawValue).toBe(0.8)
      expect(parsed.observations[0]?.provenance.productionEligible).toBe(false)

      const compiled = compile(parsed.observations, { generatedAt: NOW })
      expect(compiled.catalog.get("qwen/qwen3.8-27b")?.scores.general).toBeNull()
    },
  )

  test("the committed pre-sandbox scores.json is stamped and cannot enter a production snapshot", () => {
    const artifact = JSON.parse(readFileSync(SCORES_PATH, "utf8")) as Record<string, unknown>
    expect(artifact.graderVersion).toBe("distpatch-grader-v1-pre-sandbox")
    const parsed = metrics(artifact)
    expect(parsed.rejections).toEqual([
      `graderVersion distpatch-grader-v1-pre-sandbox != ${LOCAL_EVAL_GRADER_VERSION}`,
    ])
    expect(parsed.observations.length).toBeGreaterThan(0)
    expect(parsed.observations.every((o) => o.metric.startsWith("historical_"))).toBe(true)
    // Its legacy model key still resolves, so the history stays attached to the right model.
    expect(parsed.matchedCanonicalIds).toContain("xiaomimimo/mimo-v2.6-distill-qwen-9b")
  })
})

describe("cross-source comparability", () => {
  test("Local Evaluation evidence is retained but never promoted into the shared preference vector", () => {
    const parsed = parseLocalEvaluationArtifact(
      {
        suite: LOCAL_EVAL_SUITE_VERSION,
        graderVersion: LOCAL_EVAL_GRADER_VERSION,
        normalization: LOCAL_EVAL_NORMALIZATION_VERSION,
        scores: { "mimo/mimo-v2.6-distill-9b": { general: 0.82, coding: 0.72 } },
      },
      { ingestedAt: NOW, observedAt: NOW },
    )
    expect(isProductionComparable(LOCAL_EVAL_SOURCE_ID)).toBe(false)
    const withEvidence = compile(parsed.observations, { generatedAt: NOW })
    const without = compile([], { generatedAt: NOW })
    const profile = withEvidence.catalog.get("xiaomimimo/mimo-v2.6-distill-qwen-9b")
    expect(profile?.scores.general).toBeNull()
    expect(profile?.scores.coding).toBeNull()
    // Retained: the evidence is part of the snapshot's evidence digest even though it never scores.
    expect(withEvidence.snapshot.evidenceDigest).not.toBe(without.snapshot.evidenceDigest)
  })

  test("an explicitly calibrated, versioned entry is the only way a source becomes comparable", () => {
    const parsed = parseLocalEvaluationArtifact(
      {
        suite: LOCAL_EVAL_SUITE_VERSION,
        graderVersion: LOCAL_EVAL_GRADER_VERSION,
        normalization: LOCAL_EVAL_NORMALIZATION_VERSION,
        scores: { "mimo/mimo-v2.6-distill-9b": { general: 0.82 } },
      },
      { ingestedAt: NOW, observedAt: NOW },
    )
    const compiled = compile(parsed.observations, {
      generatedAt: NOW,
      comparability: {
        [LOCAL_EVAL_SOURCE_ID]: { comparable: true, calibration: "future-v2", reason: "test" },
      },
    })
    expect(compiled.catalog.get("xiaomimimo/mimo-v2.6-distill-qwen-9b")?.scores.general).toBe(0.82)
    // A `comparable` flag without a named calibration is not enough, and unknown sources never are.
    expect(
      isProductionComparable(LOCAL_EVAL_SOURCE_ID, {
        [LOCAL_EVAL_SOURCE_ID]: { comparable: true, calibration: null, reason: "x" },
      }),
    ).toBe(false)
    expect(isProductionComparable("some-future-source")).toBe(false)
  })

  test("a local model's AA hosted-API speed is not its speed", () => {
    const speed: SourceObservation = {
      ...aaObservation("qwen3-8-27b", "qwen/qwen3.8-27b", 41.3),
      metric: "median_output_tokens_per_second",
      fingerprint: "sha256:speed",
    }
    const compiled = compile([speed], { generatedAt: NOW })
    expect(compiled.catalog.get("qwen/qwen3.8-27b")?.scores.speed).toBeNull()
  })
})

describe("existing guarantees over the expanded catalog", () => {
  test("the effective catalog digest is stable across builds", () => {
    expect(buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG).revision()).toEqual(
      buildCapabilityCatalog(SHIPPED_CAPABILITY_CATALOG).revision(),
    )
  })

  test("an operator override still outranks published evidence", () => {
    const compiled = compile([aaObservation("qwen3-8-27b", "qwen/qwen3.8-27b", 34)], {
      generatedAt: NOW,
    })
    expect(compiled.catalog.get("qwen/qwen3.8-27b")?.scores.general).toBe(0.34)
    const overridden = applyPublishedSnapshotToBootstrap(
      SHIPPED_CAPABILITY_CATALOG,
      compiled.snapshot,
      { schemaVersion: 1, overrides: [{ id: "qwen/qwen3.8-27b", scores: { general: 0.9 } }] },
    )
    expect(overridden.get("qwen/qwen3.8-27b")?.scores.general).toBe(0.9)
    expect(overridden.get("qwen/qwen3.8-27b")?.overridden).toContain("scores.general")
  })
})
