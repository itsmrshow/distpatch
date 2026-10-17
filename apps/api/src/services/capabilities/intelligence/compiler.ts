import { createHash } from "node:crypto"
import { buildCapabilityCatalog, CapabilityCatalogError } from "../build"
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCHEMA_VERSION,
  type CapabilityDimension,
  type ShippedCatalogInput,
} from "../schema"
import { SHIPPED_CAPABILITY_CATALOG } from "../shipped"
import type { ModelCapabilityCatalog } from "../types"
import { ARTIFICIAL_ANALYSIS_SOURCE_ID } from "./artificial-analysis"
import { LOCAL_EVAL_SOURCE_ID } from "./local-eval"
import type {
  CompiledCapabilitySnapshotPayload,
  CompiledDimensionEvidence,
  CompiledModelIntelligence,
  SourceObservation,
} from "./types"

/**
 * Capability Intelligence Compiler (`distpatch-cap-compiler-v1` / `distpatch-cap-norm-v1`).
 *
 * **Off the inference request path.** Compiles durable `SourceObservation` rows into a validated,
 * immutable capability snapshot that layers cleanly over `SHIPPED_CAPABILITY_CATALOG` and under
 * `MODEL_CAPABILITY_OVERRIDES_PATH`.
 *
 * Precedence and policy:
 * 1. Hosted / widely benchmarked models (`!tags.includes("local")`):
 *    - Maintained external sources (`artificial-analysis`) are primary evidence for dimensions they
 *      directly measure:
 *        `general` <- `intelligence_index` (`raw / 100` clamped to `[0, 1]`, rounded to 4 decimals)
 *        `coding`  <- `coding_index` (`raw / 100`)
 *        `agentic` <- `agentic_index` (`raw / 100`)
 *        `speed`   <- `median_output_tokens_per_second` (`min(1, raw / 300)`) +
 *                     `median_time_to_first_token_seconds` (`1 / (1 + raw / 2)`)
 *    - When external evidence is present for a hosted model on `(general | coding | agentic | speed)`,
 *      it wins over local calibration; local evaluation fills only dimensions where external evidence
 *      is absent (`null`), never averaging the two sources.
 * 2. Local / DockerLM models (`tags.includes("local")`):
 *    - `distpatch-local-eval` is primary evidence where external sources have no entry.
 * 3. Dimensions never inferred or fabricated:
 *    - `cost` stays `null` (pricing observations are retained in Postgres as evidence, not turned
 *      into a provider-independent semantic score).
 *    - `reasoning`, `review`, `structured_output`, `tool_use`, `long_context`, `vision` stay `null`
 *      unless a source measures them without saturation or mismatch.
 *    - Hard facts (`contextTokens`, `toolUse`, `structuredOutput`, etc.) are never converted into
 *      preference scores (`long_context`, `tool_use`, `structured_output`).
 */

export const CAPABILITY_COMPILER_VERSION = "distpatch-cap-compiler-v1"
export const CAPABILITY_NORMALIZER_VERSION = "distpatch-cap-norm-v1"
export const DEFAULT_OBSERVATION_STALE_DAYS = 90
const MS_PER_DAY = 86_400_000

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000

export function normalizeIndex100(rawValue: number): number {
  return round4(clamp01(rawValue / 100))
}

export function normalizeSpeedMetrics(
  throughputTokPerSec: number | null,
  ttftSeconds: number | null,
): number | null {
  const throughputScore =
    throughputTokPerSec !== null && throughputTokPerSec > 0
      ? clamp01(throughputTokPerSec / 300)
      : null
  const ttftScore =
    ttftSeconds !== null && ttftSeconds >= 0 ? clamp01(1 / (1 + ttftSeconds / 2)) : null

  if (throughputScore !== null && ttftScore !== null) {
    return round4(0.7 * throughputScore + 0.3 * ttftScore)
  }
  if (throughputScore !== null) return round4(throughputScore)
  if (ttftScore !== null) return round4(ttftScore)
  return null
}

/**
 * When an external source publishes both a flagship/adaptive release and a non-reasoning variant
 * that map to the same canonical model id, prefer the flagship slug first, then newest timestamp.
 */
const PREFERRED_SOURCE_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  "anthropic/claude-sonnet-4-6": ["claude-sonnet-4-6-adaptive", "claude-sonnet-4-6"],
  "openai/gpt-5.5": ["gpt-5-5"],
  "openai/gpt-oss-120b": ["gpt-oss-120b"],
}

function sourceModelPriority(canonicalModelId: string, sourceModelId: string): number {
  const list = PREFERRED_SOURCE_MODEL_IDS[canonicalModelId]
  if (!list) return 999
  const idx = list.indexOf(sourceModelId.toLowerCase())
  return idx === -1 ? 999 : idx
}

function selectNewestObservation(
  observations: readonly SourceObservation[],
  canonicalModelId: string,
  source: string,
  metric: string,
): SourceObservation | null {
  let best: SourceObservation | null = null
  for (const obs of observations) {
    if (
      obs.canonicalModelId !== canonicalModelId ||
      obs.source !== source ||
      obs.metric !== metric
    ) {
      continue
    }
    if (!Number.isFinite(obs.rawValue)) continue
    if (best === null) {
      best = obs
      continue
    }
    const obsPri = sourceModelPriority(canonicalModelId, obs.sourceModelId)
    const bestPri = sourceModelPriority(canonicalModelId, best.sourceModelId)
    if (obsPri < bestPri) {
      best = obs
      continue
    }
    if (obsPri > bestPri) continue
    const obsTime = obs.observedAt.getTime()
    const bestTime = best.observedAt.getTime()
    if (obsTime > bestTime) {
      best = obs
      continue
    }
    if (obsTime === bestTime) {
      const ingDiff = obs.ingestedAt.getTime() - best.ingestedAt.getTime()
      if (ingDiff > 0 || (ingDiff === 0 && obs.fingerprint > best.fingerprint)) {
        best = obs
      }
    }
  }
  return best
}

function isObservationStale(observedAt: Date, now: Date, staleDays: number): boolean {
  return now.getTime() - observedAt.getTime() > staleDays * MS_PER_DAY
}

function emptyDimensionEvidence(dimension: CapabilityDimension): CompiledDimensionEvidence {
  const digest = createHash("sha256")
    .update(JSON.stringify({ dimension, score: null }))
    .digest("hex")
  return {
    dimension,
    score: null,
    rawValue: null,
    unit: null,
    sources: [],
    sourceRefs: [],
    benchmark: null,
    benchmarkVersion: null,
    observedAt: null,
    ingestedAt: null,
    stale: false,
    provenanceDigest: `sha256:${digest}`,
  }
}

function buildSingleObservationEvidence(
  dimension: CapabilityDimension,
  obs: SourceObservation,
  score: number,
  now: Date,
  staleDays: number,
): CompiledDimensionEvidence {
  const observedAt = obs.observedAt.toISOString()
  const ingestedAt = obs.ingestedAt.toISOString()
  const stale = isObservationStale(obs.observedAt, now, staleDays)
  const payload = {
    dimension,
    score,
    source: obs.source,
    metric: obs.metric,
    rawValue: obs.rawValue,
    unit: obs.unit,
    benchmark: obs.benchmark,
    benchmarkVersion: obs.benchmarkVersion,
    fingerprint: obs.fingerprint,
    stale,
  }
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  return {
    dimension,
    score,
    rawValue: obs.rawValue,
    unit: obs.unit,
    sources: [obs.source],
    sourceRefs: [obs.sourceRef],
    benchmark: obs.benchmark,
    benchmarkVersion: obs.benchmarkVersion,
    observedAt,
    ingestedAt,
    stale,
    provenanceDigest: `sha256:${digest}`,
  }
}

const AA_INDEX_METRIC_BY_DIMENSION: Partial<Record<CapabilityDimension, string>> = {
  general: "intelligence_index",
  coding: "coding_index",
  agentic: "agentic_index",
}

function compileDimension(
  canonicalModelId: string,
  dimension: CapabilityDimension,
  isLocalModel: boolean,
  observations: readonly SourceObservation[],
  now: Date,
  staleDays: number,
): CompiledDimensionEvidence {
  // Cost is never compiled into a provider-independent semantic preference score in M2/pre-M3.
  if (dimension === "cost") {
    return emptyDimensionEvidence(dimension)
  }

  // Speed from Artificial Analysis performance observations (throughput + TTFT).
  if (dimension === "speed") {
    const tpsObs = selectNewestObservation(
      observations,
      canonicalModelId,
      ARTIFICIAL_ANALYSIS_SOURCE_ID,
      "median_output_tokens_per_second",
    )
    const ttftObs = selectNewestObservation(
      observations,
      canonicalModelId,
      ARTIFICIAL_ANALYSIS_SOURCE_ID,
      "median_time_to_first_token_seconds",
    )
    const speedScore = normalizeSpeedMetrics(tpsObs?.rawValue ?? null, ttftObs?.rawValue ?? null)
    const primaryObs = tpsObs ?? ttftObs
    if (speedScore === null || primaryObs === null) {
      return emptyDimensionEvidence(dimension)
    }
    const oldestObservedAt =
      tpsObs !== null && ttftObs !== null
        ? new Date(Math.min(tpsObs.observedAt.getTime(), ttftObs.observedAt.getTime()))
        : primaryObs.observedAt
    const observedAt = oldestObservedAt.toISOString()
    const ingestedAt = primaryObs.ingestedAt.toISOString()
    const stale =
      (tpsObs !== null && isObservationStale(tpsObs.observedAt, now, staleDays)) ||
      (ttftObs !== null && isObservationStale(ttftObs.observedAt, now, staleDays))
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          dimension,
          score: speedScore,
          tpsFingerprint: tpsObs?.fingerprint ?? null,
          ttftFingerprint: ttftObs?.fingerprint ?? null,
          stale,
        }),
      )
      .digest("hex")
    return {
      dimension,
      score: speedScore,
      rawValue: tpsObs?.rawValue ?? ttftObs?.rawValue ?? null,
      unit: tpsObs ? tpsObs.unit : (ttftObs?.unit ?? null),
      sources: [ARTIFICIAL_ANALYSIS_SOURCE_ID],
      sourceRefs: [...new Set([tpsObs?.sourceRef, ttftObs?.sourceRef].filter(Boolean) as string[])],
      benchmark: primaryObs.benchmark,
      benchmarkVersion: primaryObs.benchmarkVersion,
      observedAt,
      ingestedAt,
      stale,
      provenanceDigest: `sha256:${digest}`,
    }
  }

  const aaMetric = AA_INDEX_METRIC_BY_DIMENSION[dimension]
  const aaObs =
    aaMetric !== undefined
      ? selectNewestObservation(
          observations,
          canonicalModelId,
          ARTIFICIAL_ANALYSIS_SOURCE_ID,
          aaMetric,
        )
      : null

  const localObs = selectNewestObservation(
    observations,
    canonicalModelId,
    LOCAL_EVAL_SOURCE_ID,
    `local_eval_${dimension}`,
  )

  if (isLocalModel) {
    // Local/DockerLM models prefer Distpatch Local Evaluation first, falling back to external if present.
    if (localObs !== null) {
      return buildSingleObservationEvidence(
        dimension,
        localObs,
        round4(clamp01(localObs.rawValue)),
        now,
        staleDays,
      )
    }
    if (aaObs !== null) {
      return buildSingleObservationEvidence(
        dimension,
        aaObs,
        normalizeIndex100(aaObs.rawValue),
        now,
        staleDays,
      )
    }
    return emptyDimensionEvidence(dimension)
  }

  // Hosted models use Artificial Analysis primary evidence for headline dimensions (`general`,
  // `coding`, `agentic`, `speed`). Local evaluation supplements hosted models only on dimensions
  // that external indexes do not measure (`reasoning`, `review`, `structured_output`, `tool_use`,
  // `long_context`, `vision`) or when a hosted model is completely absent from external indexes.
  if (aaObs !== null) {
    return buildSingleObservationEvidence(
      dimension,
      aaObs,
      normalizeIndex100(aaObs.rawValue),
      now,
      staleDays,
    )
  }
  const hasAnyExternalEvidenceForModel = observations.some(
    (o) => o.canonicalModelId === canonicalModelId && o.source === ARTIFICIAL_ANALYSIS_SOURCE_ID,
  )
  if (localObs !== null && (aaMetric === undefined || !hasAnyExternalEvidenceForModel)) {
    return buildSingleObservationEvidence(
      dimension,
      localObs,
      round4(clamp01(localObs.rawValue)),
      now,
      staleDays,
    )
  }
  return emptyDimensionEvidence(dimension)
}

export interface CompileCapabilitySnapshotOptions {
  readonly bootstrap?: ShippedCatalogInput
  readonly generatedAt?: Date
  readonly staleDays?: number
}

export interface CompiledCapabilitySnapshotResult {
  readonly snapshot: CompiledCapabilitySnapshotPayload
  readonly catalog: ModelCapabilityCatalog
  readonly summary: {
    readonly compilerVersion: string
    readonly normalizerVersion: string
    readonly evidenceDigest: string
    readonly totalObservations: number
    readonly resolvedObservations: number
    readonly unresolvedObservations: number
    readonly scoredModels: readonly string[]
    readonly staleDimensions: readonly string[]
  }
}

export function compileCapabilitySnapshot(
  observations: readonly SourceObservation[],
  options: CompileCapabilitySnapshotOptions = {},
): CompiledCapabilitySnapshotResult {
  const bootstrap = options.bootstrap ?? SHIPPED_CAPABILITY_CATALOG
  const now = options.generatedAt ?? new Date()
  const staleDays = options.staleDays ?? DEFAULT_OBSERVATION_STALE_DAYS

  const resolvedObs = observations
    .filter((o) => o.canonicalModelId !== null)
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))

  const evidenceDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        compilerVersion: CAPABILITY_COMPILER_VERSION,
        normalizerVersion: CAPABILITY_NORMALIZER_VERSION,
        fingerprints: resolvedObs.map((o) => o.fingerprint),
      }),
    )
    .digest("hex")}`

  const models: Record<string, CompiledModelIntelligence> = {}
  const scoredModels: string[] = []
  const staleDimensions: string[] = []

  const sortedProfiles = [...bootstrap.profiles].sort((a, b) => (a.id < b.id ? -1 : 1))

  for (const profile of sortedProfiles) {
    const isLocalModel = (profile.tags ?? []).includes("local")
    const dimensions = {} as Record<CapabilityDimension, CompiledDimensionEvidence>
    const scores: Partial<Record<CapabilityDimension, number | null>> = {}
    const sourceRefs = new Set<string>()
    let knownCount = 0

    for (const dim of CAPABILITY_DIMENSIONS) {
      // Never score a dimension whose matching hard feature is explicitly unsupported (`false`).
      const unsupported =
        (dim === "vision" && profile.hard?.imageInput === false) ||
        (dim === "tool_use" && profile.hard?.toolUse === false) ||
        (dim === "structured_output" && profile.hard?.structuredOutput === false)

      const compiled = unsupported
        ? emptyDimensionEvidence(dim)
        : compileDimension(profile.id, dim, isLocalModel, resolvedObs, now, staleDays)

      dimensions[dim] = compiled
      scores[dim] = compiled.score
      if (compiled.score !== null) {
        knownCount += 1
        for (const ref of compiled.sourceRefs) sourceRefs.add(ref)
        if (compiled.stale) staleDimensions.push(`${profile.id}.${dim}`)
      }
    }

    if (knownCount > 0) scoredModels.push(profile.id)

    const coverage = round4(knownCount / CAPABILITY_DIMENSIONS.length)
    const modelDigest = `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          id: profile.id,
          dimensions: CAPABILITY_DIMENSIONS.map((d) => [d, dimensions[d].provenanceDigest]),
        }),
      )
      .digest("hex")}`

    models[profile.id] = {
      id: profile.id,
      dimensions,
      scores,
      sources: [...sourceRefs].sort(),
      coverage,
      provenanceDigest: modelDigest,
    }
  }

  const revisionHash = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: CAPABILITY_SCHEMA_VERSION,
        compilerVersion: CAPABILITY_COMPILER_VERSION,
        normalizerVersion: CAPABILITY_NORMALIZER_VERSION,
        bootstrapRevision: bootstrap.revision,
        // Content-address the retained-evidence digest too: a sync that only adds provenance-only
        // observations (pricing, saturated raw audits) must produce a new immutable revision, not
        // silently reuse the previously published snapshot.
        evidenceDigest,
        models: Object.keys(models)
          .sort()
          .map((id) => ({
            id,
            scores: models[id]?.scores,
            sources: models[id]?.sources,
            provenanceDigest: models[id]?.provenanceDigest,
          })),
      }),
    )
    .digest("hex")

  const snapshot: CompiledCapabilitySnapshotPayload = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    revision: `sha256:${revisionHash}`,
    generatedAt: now.toISOString(),
    compilerVersion: CAPABILITY_COMPILER_VERSION,
    normalizerVersion: CAPABILITY_NORMALIZER_VERSION,
    evidenceDigest,
    models,
  }

  // Validate candidate snapshot by building the layered catalog (bootstrap + snapshot).
  // Throws CapabilityCatalogError on any schema or contradiction error.
  const catalog = applyPublishedSnapshotToBootstrap(bootstrap, snapshot, null)

  return {
    snapshot,
    catalog,
    summary: {
      compilerVersion: CAPABILITY_COMPILER_VERSION,
      normalizerVersion: CAPABILITY_NORMALIZER_VERSION,
      evidenceDigest,
      totalObservations: observations.length,
      resolvedObservations: resolvedObs.length,
      unresolvedObservations: observations.length - resolvedObs.length,
      scoredModels: scoredModels.sort(),
      staleDimensions: staleDimensions.sort(),
    },
  }
}

/**
 * Merges a published capability-intelligence snapshot over the static bootstrap catalog, and then
 * applies operator overrides (`MODEL_CAPABILITY_OVERRIDES_PATH`) on top.
 *
 * Layering precedence:
 *   1. `bootstrap` (`SHIPPED_CAPABILITY_CATALOG` — hard facts, tags, aliases, `null` scores)
 *   2. `publishedSnapshot` (evidence-backed preference scores + provenance source refs)
 *   3. `operatorOverrides` (highest authority; can override or null out any score, hard fact, or `enabled`)
 *
 * Pure and synchronous: never touches Postgres, the filesystem, or the network.
 */
export function applyPublishedSnapshotToBootstrap(
  bootstrap: ShippedCatalogInput,
  publishedSnapshot: unknown | null,
  operatorOverrides: unknown = null,
): ModelCapabilityCatalog {
  if (publishedSnapshot === null || publishedSnapshot === undefined) {
    return buildCapabilityCatalog(bootstrap, operatorOverrides)
  }

  if (typeof publishedSnapshot !== "object") {
    throw new CapabilityCatalogError(["publishedSnapshot: must be an object"])
  }
  const snap = publishedSnapshot as Partial<CompiledCapabilitySnapshotPayload>
  if (snap.schemaVersion !== CAPABILITY_SCHEMA_VERSION) {
    throw new CapabilityCatalogError([
      `publishedSnapshot.schemaVersion: expected ${CAPABILITY_SCHEMA_VERSION}, got ${String(snap.schemaVersion)}`,
    ])
  }
  if (typeof snap.models !== "object" || snap.models === null || Array.isArray(snap.models)) {
    throw new CapabilityCatalogError([
      "publishedSnapshot.models: must be a record of model entries",
    ])
  }

  const bootstrapIds = new Set(bootstrap.profiles.map((p) => p.id))
  for (const modelId of Object.keys(snap.models)) {
    if (!bootstrapIds.has(modelId)) {
      throw new CapabilityCatalogError([
        `publishedSnapshot.models.${modelId}: unknown canonical model id (not in bootstrap catalog)`,
      ])
    }
  }

  const mergedProfiles = bootstrap.profiles.map((profile) => {
    const compiled = snap.models?.[profile.id]
    if (!compiled) return profile

    const mergedScores: Record<string, number | null> = { ...(profile.scores ?? {}) }
    if (typeof compiled.scores === "object" && compiled.scores !== null) {
      for (const [dim, value] of Object.entries(compiled.scores)) {
        if (value !== undefined) {
          mergedScores[dim] = value as number | null
        }
      }
    }

    const extraSources = Array.isArray(compiled.sources)
      ? compiled.sources.filter((s): s is string => typeof s === "string")
      : []
    const mergedSources = [...new Set([...(profile.sources ?? []), ...extraSources])].slice(0, 8)

    return {
      ...profile,
      scores: mergedScores,
      sources: mergedSources,
    }
  })

  return buildCapabilityCatalog(
    {
      ...bootstrap,
      profiles: mergedProfiles,
    },
    operatorOverrides,
  )
}
