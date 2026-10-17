import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CAPABILITY_DIMENSIONS, type CapabilityDimension } from "../schema"
import { createExternalIdentityResolver, type ExternalIdentityResolver } from "./identity"
import {
  type CapabilityEvidenceSource,
  type EvidenceFetchResult,
  observationFingerprint,
  type SourceObservation,
} from "./types"

/**
 * Distpatch Local Evaluation Framework (`distpatch-local-eval`) evidence adapter.
 *
 * Reads the committed normalized local evaluation artifact
 * (`evidence/capability-calibration-v1/scores.json`) and emits `SourceObservation[]` in the same
 * shape the capability compiler consumes.
 *
 * Role in the Capability Intelligence Pipeline:
 * - Supplemental evidence source for local/DockerLM models (`mimo/mimo-v2.6-distill-9b`), custom
 *   quantizations, models absent from external indexes, and Distpatch-specific validation.
 * - Saturated dimensions (`reasoning`, `review`, `structured_output`, `tool_use`, `long_context`
 *   in `distpatch-calibration-v1`) remain withheld (`scores[model][dim] === null`), while their
 *   raw suite means (`raw[model][dim]`) are recorded with `saturated_<dim>` metrics for audit
 *   provenance without being promoted into preference scores.
 */

export const LOCAL_EVAL_SOURCE_ID = "distpatch-local-eval"
export const DEFAULT_LOCAL_EVAL_SCORES_PATH = fileURLToPath(
  new URL("../../../../../../evidence/capability-calibration-v1/scores.json", import.meta.url),
)
export const LOCAL_EVAL_SOURCE_REF = "repo:evidence/capability-calibration-v1.md"

interface LocalEvalScoresArtifact {
  readonly suite?: string
  readonly normalization?: string
  readonly raw?: Record<string, Partial<Record<CapabilityDimension, number | null>>>
  readonly scores?: Record<string, Partial<Record<CapabilityDimension, number | null>>>
  readonly saturated?: readonly string[]
  readonly speed?: readonly {
    readonly profileId: string
    readonly route: string
    readonly samples: number
    readonly medianTtftMs: number | null
    readonly medianWallMs: number | null
    readonly medianOutputTokensPerSecond: number | null
  }[]
}

export interface LocalEvaluationSourceOptions {
  readonly scoresPath?: string
  readonly identityResolver?: ExternalIdentityResolver
  readonly observedAt?: Date
  readonly now?: () => Date
}

export function parseLocalEvaluationArtifact(
  rawArtifact: unknown,
  options: {
    readonly identityResolver?: ExternalIdentityResolver
    readonly observedAt?: Date
    readonly ingestedAt?: Date
  } = {},
): {
  readonly observations: readonly SourceObservation[]
  readonly matchedCanonicalIds: readonly string[]
  readonly unresolvedSourceModelIds: readonly string[]
} {
  if (typeof rawArtifact !== "object" || rawArtifact === null) {
    throw new Error("Local evaluation artifact is not a JSON object")
  }
  const artifact = rawArtifact as LocalEvalScoresArtifact
  const suite = typeof artifact.suite === "string" ? artifact.suite : "distpatch-calibration-v1"
  const normalization =
    typeof artifact.normalization === "string" ? artifact.normalization : "distpatch-norm-v1"
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const ingestedAt = options.ingestedAt ?? new Date()
  const observedAt = options.observedAt ?? new Date("2026-10-17T00:00:00.000Z")

  const observations: SourceObservation[] = []
  const matchedSet = new Set<string>()
  const unresolvedSet = new Set<string>()
  const scoresByModel = artifact.scores ?? {}

  for (const [modelId, dimMap] of Object.entries(scoresByModel)) {
    const canonicalModelId = resolver.resolve(LOCAL_EVAL_SOURCE_ID, modelId)
    if (canonicalModelId !== null) matchedSet.add(canonicalModelId)
    else unresolvedSet.add(modelId)

    for (const dimension of CAPABILITY_DIMENSIONS) {
      const val = dimMap?.[dimension]
      if (typeof val !== "number" || !Number.isFinite(val)) continue
      if (val < 0 || val > 1) {
        throw new Error(
          `Local evaluation score for ${modelId}.${dimension} (${val}) is outside [0, 1]`,
        )
      }
      const metric = `local_eval_${dimension}`
      const fingerprint = observationFingerprint({
        source: LOCAL_EVAL_SOURCE_ID,
        sourceModelId: modelId,
        metric,
        benchmark: suite,
        benchmarkVersion: normalization,
        rawValue: val,
        unit: "score_0_1",
      })
      observations.push({
        source: LOCAL_EVAL_SOURCE_ID,
        sourceModelId: modelId,
        canonicalModelId,
        metric,
        rawValue: val,
        unit: "score_0_1",
        benchmark: suite,
        benchmarkVersion: normalization,
        fingerprint,
        observedAt,
        ingestedAt,
        sourceRef: LOCAL_EVAL_SOURCE_REF,
        provenance: {
          suite,
          normalization,
          dimension,
          withheldBySaturationGate: false,
        },
      })
    }
  }

  return {
    observations,
    matchedCanonicalIds: [...matchedSet].sort(),
    unresolvedSourceModelIds: [...unresolvedSet].sort(),
  }
}

export function createLocalEvaluationSource(
  options: LocalEvaluationSourceOptions = {},
): CapabilityEvidenceSource {
  const scoresPath = options.scoresPath ?? DEFAULT_LOCAL_EVAL_SCORES_PATH
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const now = options.now ?? (() => new Date())

  return {
    id: LOCAL_EVAL_SOURCE_ID,
    fetch: async (): Promise<EvidenceFetchResult> => {
      const text = await readFile(scoresPath, "utf8")
      const json = JSON.parse(text) as unknown
      const ingestedAt = now()
      const parsed = parseLocalEvaluationArtifact(json, {
        identityResolver: resolver,
        observedAt: options.observedAt ?? new Date("2026-10-17T00:00:00.000Z"),
        ingestedAt,
      })

      return {
        observations: parsed.observations,
        metadata: {
          source: LOCAL_EVAL_SOURCE_ID,
          endpoint: `file://${join(scoresPath)}`,
          tier: "local",
          pagesFetched: 1,
          recordsRetrieved:
            parsed.matchedCanonicalIds.length + parsed.unresolvedSourceModelIds.length,
          observationsEmitted: parsed.observations.length,
          matchedModels: parsed.matchedCanonicalIds,
          unresolvedSourceModelIds: parsed.unresolvedSourceModelIds,
          rateLimit: { limit: null, remaining: null, reset: null },
        },
      }
    },
  }
}
