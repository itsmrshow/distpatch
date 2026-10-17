import { ARTIFICIAL_ANALYSIS_SOURCE_ID } from "./artificial-analysis"
import { LOCAL_EVAL_SOURCE_ID } from "./local-eval"

/**
 * Cross-source score comparability.
 *
 * Every shared preference dimension is one `[0, 1]` scale that policies weigh across models. A
 * source may only write into it when its values are *calibrated onto the same scale* as the other
 * sources feeding that dimension; fitting inside `[0, 1]` is not comparability.
 *
 *   evidence exists → valid? → cross-source comparable?
 *                                ├─ yes → production score candidate
 *                                └─ no  → stored evidence/provenance only
 *
 * A source is comparable only through an explicit, versioned entry here naming the calibration that
 * established it. An unlisted source is not comparable. There is no multiplier, offset or fitted
 * conversion anywhere: a source becomes comparable by a future calibration changing its entry (and
 * the compiler version), never by a hand-tuned transform.
 */

export interface SourceScaleComparability {
  readonly comparable: boolean
  /** The versioned calibration that makes this source comparable; `null` when it is not. */
  readonly calibration: string | null
  readonly reason: string
}

export const SOURCE_SCALE_COMPARABILITY: Readonly<Record<string, SourceScaleComparability>> = {
  [ARTIFICIAL_ANALYSIS_SOURCE_ID]: {
    comparable: true,
    calibration: "artificial-analysis-index-100-v1",
    reason: "Maintained public index on a single scale across all models it covers (`raw / 100`).",
  },
  [LOCAL_EVAL_SOURCE_ID]: {
    comparable: false,
    calibration: null,
    reason:
      "Local pass fractions are not calibrated against Artificial Analysis indexes; no anchor-model calibration exists yet.",
  },
}

export type SourceComparability = Readonly<Record<string, SourceScaleComparability>>

export function isProductionComparable(
  source: string,
  registry: SourceComparability = SOURCE_SCALE_COMPARABILITY,
): boolean {
  return registry[source]?.comparable === true && registry[source]?.calibration != null
}
