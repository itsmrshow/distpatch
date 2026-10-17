import { z } from "zod"
import { CAPABILITY_DIMENSIONS, type CapabilityDimension } from "../capabilities"

/**
 * The two inputs a model-selection decision is made from besides the catalog, validated once at
 * the boundary (docs/distpatch/model-selection.md):
 *
 * - **Requirements**: what *this request* needs. Hard only — a model that cannot meet one is
 *   ineligible, whatever it scores.
 * - **Policy**: how *this kind of request* trades capabilities off. Named and versioned, so a
 *   decision can say exactly which rules produced it.
 *
 * There is no classifier input. Requirements are explicit hints; a missing hint is "not required",
 * never "guessed".
 */

/** Bump when eligibility or ranking semantics change, so recorded decisions stay interpretable. */
export const SELECTOR_VERSION = 1

const tag = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "must be a lowercase tag")
const tags = z
  .array(tag)
  .max(16)
  .refine((list) => new Set(list).size === list.length, "must not contain duplicates")

export const ModelRequirements = z
  .strictObject({
    minContextTokens: z.number().int().positive().optional(),
    minOutputTokens: z.number().int().positive().optional(),
    imageInput: z.literal(true).optional(),
    toolUse: z.literal(true).optional(),
    structuredOutput: z.literal(true).optional(),
    /** Semantic model tags that must all be present (`local`, `free`, …). */
    requireTags: tags.optional(),
    /** Semantic model tags none of which may be present. */
    excludeTags: tags.optional(),
  })
  .refine(
    (r) => !(r.requireTags ?? []).some((t) => (r.excludeTags ?? []).includes(t)),
    "a tag cannot be both required and excluded",
  )
export type ModelRequirements = z.infer<typeof ModelRequirements>

const dimensionRecord = <T extends z.ZodType<number>>(value: T) =>
  z.strictObject(
    Object.fromEntries(CAPABILITY_DIMENSIONS.map((d) => [d, value.optional()])) as Record<
      CapabilityDimension,
      z.ZodOptional<T>
    >,
  )

export const SelectionPolicy = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "must be a lowercase policy id"),
    version: z.number().int().positive(),
    /** Relative importance per dimension; omitted = not considered. */
    weights: dimensionRecord(z.number().min(0).max(100)),
    /** Per-dimension minimum score. A floor on an unknown score is not met. */
    floors: dimensionRecord(z.number().min(0).max(1)).optional(),
    /**
     * A required hard feature the catalog does not know: `reject` (default) treats it as unmet,
     * `accept` lets the model through. Never silently assumed supported.
     */
    unknownHardFacts: z.enum(["reject", "accept"]).optional(),
    /** Canonical ids, most preferred first: the tie-break after score and coverage. */
    preference: z
      .array(z.string().min(1))
      .max(64)
      .refine((list) => new Set(list).size === list.length, "must not contain duplicates")
      .optional(),
  })
  .refine(
    (p) => Object.values(p.weights).some((w) => w !== undefined && w > 0),
    "weights must give at least one dimension a positive weight",
  )
export type SelectionPolicy = z.infer<typeof SelectionPolicy>
