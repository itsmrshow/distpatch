import { createHash } from "node:crypto"
import {
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  type CatalogRevision,
  type ModelCapabilityCatalog,
  type ModelCapabilityProfile,
} from "../capabilities"
import { type IneligibleReason, ineligibility } from "./eligibility"
import { type ModelRequirements, SELECTOR_VERSION, type SelectionPolicy } from "./schema"

/**
 * Deterministic model selection: candidates → hard eligibility → ranking → one decision.
 *
 * Pure and synchronous. The same candidates (in any order), requirements, policy and catalog
 * revision always produce the same decision and the same `digest`. No clock, no randomness, no
 * account/provider state, no classifier — and no wiring: nothing on the request path calls this
 * yet (`auto-*` resolution is #9).
 *
 * The selected `model` is the candidate name exactly as the caller supplied it, never the
 * canonical id: the catalog identifies, it does not rename what goes upstream.
 */

export interface ModelSelectionInput {
  /** Concrete model names the caller could route, e.g. reachable under the presenting key. */
  readonly candidates: readonly string[]
  readonly requirements: ModelRequirements
  readonly policy: SelectionPolicy
}

export interface RankedModel {
  readonly model: string
  readonly profileId: string
  /** Σ weight·score over known dimensions ÷ Σ weight. Unknown dimensions earn no credit. */
  readonly score: number
  /** Share of the policy's weight whose score is known, `[0, 1]`. */
  readonly coverage: number
  readonly unknownDimensions: readonly CapabilityDimension[]
  /** Position in `policy.preference`, `null` when unlisted. */
  readonly preferenceRank: number | null
}

export interface RejectedModel {
  readonly model: string
  readonly profileId: string | null
  readonly reasons: readonly IneligibleReason[]
}

export interface ModelSelectionDecision {
  readonly selectorVersion: number
  /** `digest` covers the policy's full content, so an edit without a version bump is visible. */
  readonly policy: { readonly id: string; readonly version: number; readonly digest: string }
  readonly catalogRevision: CatalogRevision
  readonly requirements: ModelRequirements
  readonly outcome: "selected" | "no-eligible-model"
  readonly selected: RankedModel | null
  /** Eligible candidates, best first. */
  readonly ranked: readonly RankedModel[]
  /** Ineligible candidates, by model name, each with every rule it failed. */
  readonly rejected: readonly RejectedModel[]
  /** `sha256:<hex>` over every field above. */
  readonly digest: string
}

export function selectModel(
  catalog: ModelCapabilityCatalog,
  input: ModelSelectionInput,
): ModelSelectionDecision {
  const { policy } = input
  const requirements = normalizeRequirements(input.requirements)
  const ranked: RankedModel[] = []
  const rejected: RejectedModel[] = []

  for (const model of [...new Set(input.candidates)].sort()) {
    const profile = catalog.resolve(model)
    const reasons = ineligibility(profile, requirements, policy)
    if (profile === null || reasons.length > 0) {
      rejected.push({ model, profileId: profile?.id ?? null, reasons })
      continue
    }
    ranked.push(rank(model, profile, policy))
  }
  ranked.sort(compare)

  const body = {
    selectorVersion: SELECTOR_VERSION,
    policy: { id: policy.id, version: policy.version, digest: sha256(normalizePolicy(policy)) },
    catalogRevision: catalog.revision(),
    requirements,
    outcome: ranked.length > 0 ? ("selected" as const) : ("no-eligible-model" as const),
    selected: ranked[0] ?? null,
    ranked,
    rejected,
  }
  return { ...body, digest: sha256(body) }
}

function rank(
  model: string,
  profile: ModelCapabilityProfile,
  policy: SelectionPolicy,
): RankedModel {
  let total = 0
  let known = 0
  let earned = 0
  const unknownDimensions: CapabilityDimension[] = []
  for (const dimension of CAPABILITY_DIMENSIONS) {
    const weight = policy.weights[dimension] ?? 0
    if (weight === 0) continue
    total += weight
    const score = profile.scores[dimension]
    if (score === null) {
      unknownDimensions.push(dimension)
      continue
    }
    known += weight
    earned += weight * score
  }
  const position = policy.preference?.indexOf(profile.id) ?? -1
  return {
    model,
    profileId: profile.id,
    score: round(earned / total),
    coverage: round(known / total),
    unknownDimensions,
    preferenceRank: position === -1 ? null : position,
  }
}

/** Score, then coverage, then policy preference, then canonical id, then name — a total order. */
function compare(a: RankedModel, b: RankedModel): number {
  return (
    b.score - a.score ||
    b.coverage - a.coverage ||
    (a.preferenceRank ?? Number.POSITIVE_INFINITY) -
      (b.preferenceRank ?? Number.POSITIVE_INFINITY) ||
    order(a.profileId, b.profileId) ||
    order(a.model, b.model)
  )
}

function order(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

/** Dimension order, not object key order, so equal policies digest identically. */
function normalizePolicy(p: SelectionPolicy): unknown {
  const byDimension = (record: Partial<Record<CapabilityDimension, number>> | undefined) =>
    CAPABILITY_DIMENSIONS.map((d) => record?.[d] ?? null)
  return {
    id: p.id,
    version: p.version,
    weights: byDimension(p.weights),
    floors: byDimension(p.floors),
    unknownHardFacts: p.unknownHardFacts ?? "reject",
    preference: p.preference ?? [],
  }
}

/** Nine decimals: summation-order float noise must not decide a tie. */
function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

/** Fixed key order and sorted tags, so equal requirements serialize — and digest — identically. */
function normalizeRequirements(r: ModelRequirements): ModelRequirements {
  return {
    ...(r.minContextTokens === undefined ? {} : { minContextTokens: r.minContextTokens }),
    ...(r.minOutputTokens === undefined ? {} : { minOutputTokens: r.minOutputTokens }),
    ...(r.imageInput === undefined ? {} : { imageInput: r.imageInput }),
    ...(r.toolUse === undefined ? {} : { toolUse: r.toolUse }),
    ...(r.structuredOutput === undefined ? {} : { structuredOutput: r.structuredOutput }),
    ...(r.requireTags === undefined ? {} : { requireTags: [...r.requireTags].sort() }),
    ...(r.excludeTags === undefined ? {} : { excludeTags: [...r.excludeTags].sort() }),
  }
}
