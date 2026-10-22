import { CAPABILITY_DIMENSIONS, type CapabilityDimension } from "../../src/services/capabilities"
import { LOCAL_EVAL_NORMALIZATION_VERSION } from "../../src/services/capabilities/intelligence/local-eval-versions"

/**
 * Normalization `distpatch-norm-v1`: raw case grades → catalog `[0, 1]` preference scores.
 *
 *   raw(model, d) = round2( mean over the dimension's cases c of  mean over runs r of grade(c, r) )
 *   score(model, d) = raw(model, d)  if dimension d is discriminating, else null
 *
 * - `grade(c, r)` is the fraction of case `c`'s deterministic checks that passed on run `r`.
 * - **Absolute, not relative**: a published value depends only on that model's own grades, never
 *   on which other models were measured, so one extreme model cannot rescale everyone and adding
 *   a model never changes an existing value. Monotonic in every grade.
 * - **Full coverage or unknown**: `raw` exists only when every case of the dimension has at least
 *   one graded run. A route that cannot run a case leaves it `null`; nothing is extrapolated.
 * - **Validity gate**: a dimension is *discriminating* when at least one measured model's raw
 *   score is ≤ {@link SATURATION_CEILING}. If every measured model clears it, the suite has not
 *   shown it can tell models apart on that dimension, so publishing 1.0 for a 9B model and a
 *   frontier model alike would be a ceiling artifact, not a capability claim: the dimension stays
 *   `null` and is reported as saturated. The gate can only withhold a value, never alter one.
 * - Several routes serving the same canonical model pool their runs: quality describes the
 *   model, not the route.
 * - Two decimals: the suite has 4–7 cases per dimension; finer precision would be false.
 *
 * `speed` and `cost` are never produced here (see the evidence artifact for why).
 */
export const NORMALIZATION_VERSION = LOCAL_EVAL_NORMALIZATION_VERSION
export const SATURATION_CEILING = 0.9

export interface GradedCase {
  readonly id: string
  readonly dimension: CapabilityDimension
  /** `null` = not run or unknown after an infrastructure failure; never treated as zero. */
  readonly grade: number | null
}

export interface ModelRun {
  readonly profileId: string
  readonly suite: string
  readonly cases: readonly GradedCase[]
}

export type DimensionScores = Record<CapabilityDimension, number | null>

export interface Normalized {
  /** Ungated per-model means, for the evidence artifact. */
  readonly raw: Record<string, DimensionScores>
  /** What may enter the catalog. */
  readonly scores: Record<string, DimensionScores>
  /** Measured dimensions withheld because no model scored ≤ the ceiling. */
  readonly saturated: readonly CapabilityDimension[]
}

export function normalize(
  runs: readonly ModelRun[],
  suiteCases: readonly { readonly id: string; readonly dimension: CapabilityDimension }[],
  suite: string,
): Normalized {
  const byProfile = new Map<string, ModelRun[]>()
  for (const run of runs) {
    if (run.suite !== suite)
      throw new Error(`run for ${run.profileId} is ${run.suite}, not ${suite}`)
    byProfile.set(run.profileId, [...(byProfile.get(run.profileId) ?? []), run])
  }
  const raw: Record<string, DimensionScores> = {}
  for (const [profileId, profileRuns] of [...byProfile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const scores = {} as DimensionScores
    for (const dimension of CAPABILITY_DIMENSIONS) {
      const cases = suiteCases.filter((c) => c.dimension === dimension)
      const means = cases.map((c) => {
        const grades = profileRuns
          .flatMap((r) => r.cases.filter((g) => g.id === c.id))
          .map((g) => g.grade)
          .filter((g): g is number => g !== null)
        return grades.length === 0 ? null : grades.reduce((a, b) => a + b, 0) / grades.length
      })
      scores[dimension] =
        cases.length === 0 || means.some((m) => m === null)
          ? null
          : Math.round(((means as number[]).reduce((a, b) => a + b, 0) / means.length) * 100) / 100
    }
    raw[profileId] = scores
  }

  const saturated = CAPABILITY_DIMENSIONS.filter((d) => {
    const measured = Object.values(raw)
      .map((s) => s[d])
      .filter((v): v is number => v !== null)
    return measured.length > 0 && measured.every((v) => v > SATURATION_CEILING)
  })
  const scores = Object.fromEntries(
    Object.entries(raw).map(([id, s]) => [
      id,
      Object.fromEntries(
        CAPABILITY_DIMENSIONS.map((d) => [d, saturated.includes(d) ? null : s[d]]),
      ) as DimensionScores,
    ]),
  )
  return { raw, scores, saturated }
}
