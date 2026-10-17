import {
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  type ModelCapabilityProfile,
} from "../capabilities"
import type { ModelRequirements, SelectionPolicy } from "./schema"

/**
 * Hard eligibility: every requirement and every policy floor, checked against catalog facts.
 * Pure. Every failed rule is recorded, not just the first, so a decision explains itself fully.
 *
 * Unknown is never read as support: a required feature or limit the catalog does not know fails
 * unless the policy explicitly sets `unknownHardFacts: "accept"`, and a floor on an unknown
 * score always fails.
 */

export type RequiredFeature = "imageInput" | "toolUse" | "structuredOutput"
export type RequiredLimit = "contextTokens" | "maxOutputTokens"

export type IneligibleReason =
  | { readonly code: "no-profile" }
  | { readonly code: "disabled" }
  | { readonly code: "feature"; readonly feature: RequiredFeature; readonly value: false | null }
  | {
      readonly code: "limit"
      readonly limit: RequiredLimit
      readonly required: number
      readonly value: number | null
    }
  | { readonly code: "tag-missing"; readonly tag: string }
  | { readonly code: "tag-excluded"; readonly tag: string }
  | {
      readonly code: "floor"
      readonly dimension: CapabilityDimension
      readonly floor: number
      readonly value: number | null
    }

const FEATURES: readonly RequiredFeature[] = ["imageInput", "toolUse", "structuredOutput"]
const LIMITS: readonly [RequiredLimit, "minContextTokens" | "minOutputTokens"][] = [
  ["contextTokens", "minContextTokens"],
  ["maxOutputTokens", "minOutputTokens"],
]

export function ineligibility(
  profile: ModelCapabilityProfile | null,
  requirements: ModelRequirements,
  policy: SelectionPolicy,
): readonly IneligibleReason[] {
  if (profile === null) return [{ code: "no-profile" }]
  const reasons: IneligibleReason[] = []
  if (!profile.enabled) reasons.push({ code: "disabled" })
  const acceptUnknown = policy.unknownHardFacts === "accept"

  for (const feature of FEATURES) {
    if (requirements[feature] !== true) continue
    const value = profile.hard[feature]
    if (value === true || (value === null && acceptUnknown)) continue
    reasons.push({ code: "feature", feature, value })
  }
  for (const [limit, key] of LIMITS) {
    const required = requirements[key]
    if (required === undefined) continue
    const value = profile.hard[limit]
    if (value === null ? acceptUnknown : value >= required) continue
    reasons.push({ code: "limit", limit, required, value })
  }
  for (const tag of requirements.requireTags ?? []) {
    if (!profile.tags.includes(tag)) reasons.push({ code: "tag-missing", tag })
  }
  for (const tag of requirements.excludeTags ?? []) {
    if (profile.tags.includes(tag)) reasons.push({ code: "tag-excluded", tag })
  }
  for (const dimension of CAPABILITY_DIMENSIONS) {
    const floor = policy.floors?.[dimension]
    if (floor === undefined) continue
    const value = profile.scores[dimension]
    if (value === null || value < floor) reasons.push({ code: "floor", dimension, floor, value })
  }
  return reasons
}
