import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CAPABILITY_DIMENSIONS, type CapabilityDimension } from "../schema"
import { createExternalIdentityResolver, type ExternalIdentityResolver } from "./identity"
import {
  LOCAL_EVAL_GRADER_VERSION,
  LOCAL_EVAL_NORMALIZATION_VERSION,
  LOCAL_EVAL_SUITE_VERSION,
} from "./local-eval-versions"
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
 * Trust boundary: an artifact is production-eligible only when its `suite`, `graderVersion` and
 * `normalization` all equal the current versions (`local-eval-versions.ts`). A missing or different
 * stamp (for example the pre-sandbox grader) is *rejected as production evidence*: its values are
 * retained as `historical_*` observations for audit and never as `local_eval_*` metrics, and are
 * never turned into zero scores.
 *
 * Even compatible local scores do not reach the shared preference vector until the source is marked
 * cross-source comparable (`comparability.ts`); that is the compiler's gate, not this adapter's.
 *
 * Role: supplemental evidence for local models, custom quantizations, models absent from external
 * indexes, and Distpatch-specific validation. Saturated dimensions (`reasoning`, `review`,
 * `structured_output`, `tool_use`, `long_context` in `distpatch-calibration-v1`) remain withheld
 * (`scores[model][dim] === null`), while their raw suite means (`raw[model][dim]`) are recorded
 * with `saturated_<dim>` metrics for audit provenance without being promoted into preference scores.
 */

export const LOCAL_EVAL_SOURCE_ID = "distpatch-local-eval"
export const DEFAULT_LOCAL_EVAL_SCORES_PATH = fileURLToPath(
  new URL("../../../../../../evidence/capability-calibration-v1/scores.json", import.meta.url),
)
export const LOCAL_EVAL_SOURCE_REF = "repo:evidence/capability-calibration-v1.md"

interface LocalEvalInputProvenance {
  readonly file: string
  readonly profileId: string
  readonly route: string
  readonly wireModel: string
  readonly recordedAt: string
  readonly suite: string
  readonly graderVersion: string
}

interface LocalEvalScoresArtifact {
  readonly suite?: string
  readonly graderVersion?: string
  readonly normalization?: string
  readonly generatedAt?: string
  readonly inputs?: readonly LocalEvalInputProvenance[]
  readonly excluded?: readonly unknown[]
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
  /** Why the artifact is not production-eligible; empty when it is. */
  readonly rejections: readonly string[]
} {
  if (typeof rawArtifact !== "object" || rawArtifact === null) {
    throw new Error("Local evaluation artifact is not a JSON object")
  }
  const artifact = rawArtifact as LocalEvalScoresArtifact
  const suite = typeof artifact.suite === "string" ? artifact.suite : "unknown"
  const grader = typeof artifact.graderVersion === "string" ? artifact.graderVersion : "unknown"
  const normalization =
    typeof artifact.normalization === "string" ? artifact.normalization : "unknown"
  const rejections: string[] = []
  const expected: readonly [string, string | undefined, string][] = [
    ["suite", artifact.suite, LOCAL_EVAL_SUITE_VERSION],
    ["graderVersion", artifact.graderVersion, LOCAL_EVAL_GRADER_VERSION],
    ["normalization", artifact.normalization, LOCAL_EVAL_NORMALIZATION_VERSION],
  ]
  for (const [field, actual, want] of expected) {
    if (actual !== want) {
      rejections.push(`${field} ${actual === undefined ? "(missing)" : actual} != ${want}`)
    }
  }
  // Every recorded input must be well formed: dropping a malformed one would leave scores that
  // rest partly on runs the artifact no longer names.
  const rawInputs: readonly unknown[] = Array.isArray(artifact.inputs) ? artifact.inputs : []
  if (!Array.isArray(artifact.inputs)) rejections.push("inputs missing")
  const malformedInputs = rawInputs.filter((input) => !isInputProvenance(input)).length
  if (malformedInputs > 0) rejections.push(`${malformedInputs} malformed input record(s)`)
  const inputs = rawInputs.filter(isInputProvenance)
  const generatedAt = validDate(artifact.generatedAt)
  if (generatedAt === null) rejections.push("generatedAt missing or invalid")
  for (const input of inputs) {
    if (
      input.suite !== LOCAL_EVAL_SUITE_VERSION ||
      input.graderVersion !== LOCAL_EVAL_GRADER_VERSION
    ) {
      rejections.push(`input ${input.file} is ${input.suite}/${input.graderVersion}`)
    }
  }
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const ingestedAt = options.ingestedAt ?? new Date()
  const scoresByModel = artifact.scores ?? {}
  const rawByModel = artifact.raw ?? {}
  const saturatedDims = new Set(artifact.saturated ?? [])
  const modelIds = [...new Set([...Object.keys(scoresByModel), ...Object.keys(rawByModel)])]
  const inputsByModel = new Map(
    modelIds.map((modelId) => [modelId, inputs.filter((input) => input.profileId === modelId)]),
  )
  for (const [modelId, modelInputs] of inputsByModel) {
    if (modelInputs.length === 0) rejections.push(`no recorded input for ${modelId}`)
  }
  // Rejected artifacts are kept, under a metric namespace the compiler never reads.
  const metricPrefix = rejections.length === 0 ? "" : "historical_"

  const observations: SourceObservation[] = []
  const matchedSet = new Set<string>()
  const unresolvedSet = new Set<string>()
  for (const modelId of modelIds) {
    const canonicalModelId = resolver.resolve(LOCAL_EVAL_SOURCE_ID, modelId)
    if (canonicalModelId !== null) matchedSet.add(canonicalModelId)
    else unresolvedSet.add(modelId)
    const modelInputs = inputsByModel.get(modelId) ?? []
    const recorded = modelInputs.map((input) => (validDate(input.recordedAt) as Date).getTime())
    // A measurement is as old as its newest recorded run. Provenance-free (historical) artifacts
    // fall back to the artifact time, then the caller's, then the epoch, so they never look fresh
    // merely because they were ingested now.
    const observedAt =
      recorded.length > 0
        ? new Date(Math.max(...recorded))
        : (generatedAt ?? options.observedAt ?? new Date(0))
    const meta = {
      suite,
      grader,
      normalization,
      observedAt,
      ingestedAt,
      inputProvenance: modelInputs,
    }
    const dimMap = scoresByModel[modelId] ?? {}
    const rawDimMap = rawByModel[modelId] ?? {}

    for (const dimension of CAPABILITY_DIMENSIONS) {
      const val = dimMap[dimension]
      const rawVal = rawDimMap[dimension]

      if (typeof val === "number" && Number.isFinite(val)) {
        if (val < 0 || val > 1) {
          throw new Error(
            `Local evaluation score for ${modelId}.${dimension} (${val}) is outside [0, 1]`,
          )
        }
        observations.push(
          emitLocalMetric(
            modelId,
            canonicalModelId,
            `${metricPrefix}local_eval_${dimension}`,
            val,
            meta,
          ),
        )
        continue
      }

      // Saturated dimension: the published score is `null` but the raw suite mean is a measured
      // value. Retain it as audit evidence under a `saturated_` metric that the compiler never
      // converts into a preference score.
      if (
        saturatedDims.has(dimension) &&
        typeof rawVal === "number" &&
        Number.isFinite(rawVal) &&
        rawVal >= 0 &&
        rawVal <= 1
      ) {
        observations.push(
          emitLocalMetric(
            modelId,
            canonicalModelId,
            `${metricPrefix}saturated_${dimension}`,
            rawVal,
            meta,
          ),
        )
      }
    }
  }
  return {
    observations,
    matchedCanonicalIds: [...matchedSet].sort(),
    unresolvedSourceModelIds: [...unresolvedSet].sort(),
    rejections,
  }
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function isInputProvenance(value: unknown): value is LocalEvalInputProvenance {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    ["file", "profileId", "route", "wireModel", "suite", "graderVersion"].every(
      (key) => typeof v[key] === "string",
    ) && validDate(v.recordedAt) !== null
  )
}

function emitLocalMetric(
  modelId: string,
  canonicalModelId: string | null,
  metric: string,
  rawValue: number,
  meta: {
    readonly suite: string
    readonly grader: string
    readonly normalization: string
    readonly observedAt: Date
    readonly ingestedAt: Date
    readonly inputProvenance: readonly LocalEvalInputProvenance[]
  },
): SourceObservation {
  const benchmarkVersion = `${meta.normalization}/${meta.grader}`
  const fingerprint = observationFingerprint({
    source: LOCAL_EVAL_SOURCE_ID,
    sourceModelId: modelId,
    metric,
    benchmark: meta.suite,
    benchmarkVersion,
    rawValue,
    unit: "score_0_1",
  })
  return {
    source: LOCAL_EVAL_SOURCE_ID,
    sourceModelId: modelId,
    canonicalModelId,
    metric,
    rawValue,
    unit: "score_0_1",
    benchmark: meta.suite,
    benchmarkVersion,
    fingerprint,
    observedAt: meta.observedAt,
    ingestedAt: meta.ingestedAt,
    sourceRef: LOCAL_EVAL_SOURCE_REF,
    provenance: {
      suite: meta.suite,
      graderVersion: meta.grader,
      normalization: meta.normalization,
      dimension: metric.replace(/^(historical_)?(local_eval_|saturated_)/, ""),
      withheldBySaturationGate: /^(historical_)?saturated_/.test(metric),
      productionEligible: !metric.startsWith("historical_"),
      inputs: meta.inputProvenance.map(({ file, profileId, route, wireModel, recordedAt }) => ({
        file,
        profileId,
        route,
        wireModel,
        recordedAt,
      })),
    },
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
        observedAt: options.observedAt,
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
          rejections: parsed.rejections,
          rateLimit: { limit: null, remaining: null, reset: null },
        },
      }
    },
  }
}
