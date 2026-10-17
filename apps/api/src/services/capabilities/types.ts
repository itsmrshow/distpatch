import type { CanonicalModelId, CapabilityDimension } from "./schema"

/**
 * The effective, read-only shapes a selector consumes. Hard facts and preference scores are two
 * separate records on purpose: "can it take images" filters, "how good is it with images"
 * compares, and a selector must never be able to confuse the two.
 *
 * `null` everywhere means **unknown**. A known-unsupported hard feature is `false`.
 */

export interface HardFacts {
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  readonly textInput: boolean | null
  readonly textOutput: boolean | null
  readonly imageInput: boolean | null
  readonly toolUse: boolean | null
  readonly structuredOutput: boolean | null
}

export type CapabilityScores = { readonly [D in CapabilityDimension]: number | null }

export interface ModelCapabilityProfile {
  readonly id: CanonicalModelId
  readonly family: string | null
  /** Catalog aliases: names that *identify* this profile. Never a wire rewrite. */
  readonly aliases: readonly string[]
  /** Semantic model tags, sorted. Not Account tags. */
  readonly tags: readonly string[]
  /** `false` only by operator choice; a disabled profile is still returned, flagged. */
  readonly enabled: boolean
  readonly hard: HardFacts
  readonly scores: CapabilityScores
  readonly sources: readonly string[]
  /** `shipped` with the image, or added whole by the operator's override file. */
  readonly origin: "shipped" | "operator"
  /** Field paths an operator override changed (`enabled`, `scores.coding`, …), sorted. */
  readonly overridden: readonly string[]
}

export interface CatalogRevision {
  readonly schemaVersion: number
  /** The shipped table's revision, `YYYY-MM-DD.N`. */
  readonly shipped: string
  /** `sha256:<hex>` over the effective profile contents; identical contents, identical value. */
  readonly effective: string
}

/** Synchronous, immutable, in-memory. Nothing here performs I/O. */
export interface ModelCapabilityCatalog {
  /** A canonical id or catalog alias, case-insensitive. `null` = no profile (unknown model). */
  resolve(model: string): ModelCapabilityProfile | null
  /** Canonical id only. */
  get(id: CanonicalModelId): ModelCapabilityProfile | null
  /** Every profile, disabled included, sorted by id. */
  list(): readonly ModelCapabilityProfile[]
  revision(): CatalogRevision
}
