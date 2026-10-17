import { z } from "zod"

/**
 * The boundary schema for the model capability catalog — shipped profiles and the operator's
 * override file are both validated here, once, before an effective snapshot exists
 * (docs/distpatch/capability-catalog.md).
 *
 * Every object is `strict`: an unknown key is a typo or an attempt to smuggle account-local data
 * (an account id, a credential) into model metadata, and both must fail loudly. Every string is
 * pattern-restricted for the same reason — there is no free-text field a secret could ride in.
 *
 * Unknown is a first-class value. An omitted or `null` hard fact or score means **not known** and
 * stays `null` through merge, lookup and serialization; it is never defaulted to `0`, `0.5` or
 * `false`.
 */

/** Bump only with a migration story for override files written against the previous format. */
export const CAPABILITY_SCHEMA_VERSION = 1

/**
 * Preference dimensions, each a normalized `[0, 1]` desirability where higher is better —
 * `speed` and `cost` included (`cost: 1` = cheapest class). These are curated static judgments,
 * never live telemetry and never a monetary price (`services/cost/` owns prices).
 */
export const CAPABILITY_DIMENSIONS = [
  "general",
  "coding",
  "reasoning",
  "agentic",
  "review",
  "structured_output",
  "tool_use",
  "long_context",
  "vision",
  "speed",
  "cost",
] as const
export type CapabilityDimension = (typeof CAPABILITY_DIMENSIONS)[number]

/** Hard facts a selector can filter on. `null` = unknown, `false` = known unsupported. */
export const HARD_FEATURES = [
  "textInput",
  "textOutput",
  "imageInput",
  "toolUse",
  "structuredOutput",
] as const
export type HardFeature = (typeof HARD_FEATURES)[number]

/** `vendor/model`, lowercase. Stable semantic identity, never a wire name. */
export const CanonicalModelId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/,
    "must be lowercase `vendor/model` (letters, digits, `.`, `_`, `-`, `:`)",
  )
export type CanonicalModelId = z.infer<typeof CanonicalModelId>

/** A name clients or providers use for the model. Lowercase; lookup lowercases its input. */
export const CatalogAlias = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._:/@-]{0,199}$/,
    "must be a lowercase model name (letters, digits, `.`, `_`, `-`, `:`, `/`, `@`)",
  )

export const ModelFamilyName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be a lowercase family name")

/** Semantic model tags (`local`, `free`, `dockerlm`, …). Distinct from Account tags. */
export const ModelTag = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "must be a lowercase tag (letters, digits, `-`)")

/** `https://host/path` or `repo:path#anchor` — no query string or userinfo a secret could hide in. */
export const SourceRef = z
  .string()
  .regex(
    /^(https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/#%-]*)?|repo:[A-Za-z0-9._/#-]+)$/,
    "must be an https URL without query/userinfo, or `repo:<path>`",
  )

const score = z.number().min(0).max(1).nullable().optional()
const tokens = z.number().int().positive().nullable().optional()
const fact = z.boolean().nullable().optional()

export const HardFactsInput = z.strictObject({
  contextTokens: tokens,
  maxOutputTokens: tokens,
  textInput: fact,
  textOutput: fact,
  imageInput: fact,
  toolUse: fact,
  structuredOutput: fact,
})
export type HardFactsInput = z.infer<typeof HardFactsInput>

export const ScoresInput = z.strictObject(
  Object.fromEntries(CAPABILITY_DIMENSIONS.map((dimension) => [dimension, score])) as Record<
    CapabilityDimension,
    typeof score
  >,
)
export type ScoresInput = z.infer<typeof ScoresInput>

const uniqueList = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((list) => new Set(list).size === list.length, "must not contain duplicates")

export const ProfileInput = z.strictObject({
  id: CanonicalModelId,
  family: ModelFamilyName.nullable().optional(),
  aliases: uniqueList(CatalogAlias, 32).optional(),
  tags: uniqueList(ModelTag, 16).optional(),
  enabled: z.boolean().optional(),
  hard: HardFactsInput.optional(),
  scores: ScoresInput.optional(),
  sources: uniqueList(SourceRef, 8).optional(),
})
export type ProfileInput = z.infer<typeof ProfileInput>

export const ShippedCatalogInput = z.strictObject({
  schemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  revision: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, "must be `YYYY-MM-DD.N`"),
  profiles: z.array(ProfileInput),
})
export type ShippedCatalogInput = z.infer<typeof ShippedCatalogInput>

/**
 * Tags either replace the list (`set`) or edit it (`remove` then `add`) — never both, and never
 * the same tag added and removed, so the outcome cannot depend on reading order.
 */
const TagEdit = z
  .strictObject({
    set: uniqueList(ModelTag, 16).optional(),
    add: uniqueList(ModelTag, 16).optional(),
    remove: uniqueList(ModelTag, 16).optional(),
  })
  .refine(
    (edit) => edit.set === undefined || (edit.add === undefined && edit.remove === undefined),
    "`set` cannot be combined with `add`/`remove`",
  )
  .refine(
    (edit) => !(edit.add ?? []).some((tag) => (edit.remove ?? []).includes(tag)),
    "a tag cannot be both added and removed",
  )

/** A partial edit of one existing profile. Absent field = keep; `null` = make unknown. */
export const ProfileOverride = z.strictObject({
  id: CanonicalModelId,
  enabled: z.boolean().optional(),
  family: ModelFamilyName.nullable().optional(),
  aliases: uniqueList(CatalogAlias, 32).optional(),
  tags: TagEdit.optional(),
  hard: HardFactsInput.optional(),
  scores: ScoresInput.optional(),
  sources: uniqueList(SourceRef, 8).optional(),
})
export type ProfileOverride = z.infer<typeof ProfileOverride>

/** The operator's override file: whole new profiles plus partial edits of existing ones. */
export const CatalogOverridesInput = z.strictObject({
  schemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  profiles: z.array(ProfileInput).optional(),
  overrides: z.array(ProfileOverride).optional(),
})
export type CatalogOverridesInput = z.infer<typeof CatalogOverridesInput>
