import { createHash } from "node:crypto"
import type { z } from "zod"
import { createCatalogLookup } from "./lookup"
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCHEMA_VERSION,
  CatalogOverridesInput,
  HARD_FEATURES,
  type HardFactsInput,
  type ProfileInput,
  type ProfileOverride,
  type ScoresInput,
  ShippedCatalogInput,
} from "./schema"
import type {
  CapabilityScores,
  HardFacts,
  ModelCapabilityCatalog,
  ModelCapabilityProfile,
} from "./types"

/**
 * shipped catalog + validated operator overrides → one immutable effective snapshot.
 *
 * Pure: no I/O, no clock. Any problem anywhere — schema, duplicate, collision, unknown override
 * target, contradiction after merge — collects into one {@link CapabilityCatalogError} naming
 * every bad entry, and no snapshot is produced. A partially trusted catalog is never served.
 */

export class CapabilityCatalogError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid model capability catalog:\n${problems.map((p) => `  ${p}`).join("\n")}`)
    this.name = "CapabilityCatalogError"
    this.problems = problems
  }
}

type Draft = Omit<ModelCapabilityProfile, "overridden"> & { overridden: Set<string> }

const HARD_KEYS = ["contextTokens", "maxOutputTokens", ...HARD_FEATURES] as const

export function buildCapabilityCatalog(
  shipped: unknown,
  overrides: unknown = null,
): ModelCapabilityCatalog {
  const problems: string[] = []
  const base = parse(ShippedCatalogInput, shipped, "shipped", problems)
  const edits =
    overrides === null ? null : parse(CatalogOverridesInput, overrides, "overrides", problems)
  if (base === null || problems.length > 0) throw new CapabilityCatalogError(problems)

  const drafts = new Map<string, Draft>()
  addProfiles(drafts, base.profiles, "shipped", problems)
  addProfiles(drafts, edits?.profiles ?? [], "operator", problems)
  applyOverrides(drafts, edits?.overrides ?? [], problems)

  const profiles = [...drafts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(finish)
  for (const profile of profiles) checkContradictions(profile, problems)
  const lookup = createCatalogLookup(profiles, revisionOf(base.revision, profiles), problems)
  if (problems.length > 0) throw new CapabilityCatalogError(problems)
  return lookup
}

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
  problems: string[],
): T | null {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  for (const issue of result.error.issues) {
    problems.push(`${label}.${where(input, issue.path)}: ${issue.message}`)
  }
  return null
}

/** `profiles[3] (openai/gpt-5.5).scores.coding` — the id makes the bad entry findable. */
function where(input: unknown, path: readonly PropertyKey[]): string {
  const [list, index, ...rest] = path
  let id = ""
  if (typeof index === "number" && typeof input === "object" && input !== null) {
    const entries = (input as Record<string, unknown>)[String(list)]
    const entry = Array.isArray(entries)
      ? (entries[index] as { id?: unknown } | undefined)
      : undefined
    if (typeof entry?.id === "string") id = ` (${entry.id})`
  }
  const head =
    typeof index === "number" ? `${String(list)}[${index}]${id}` : String(list ?? "(root)")
  const tail = index === undefined || typeof index === "number" ? rest : [index, ...rest]
  return [head, ...tail.map(String)].join(".")
}

function addProfiles(
  drafts: Map<string, Draft>,
  inputs: readonly ProfileInput[],
  origin: Draft["origin"],
  problems: string[],
): void {
  for (const input of inputs) {
    if (drafts.has(input.id)) {
      problems.push(`${origin} profile ${input.id}: duplicate canonical id`)
      continue
    }
    drafts.set(input.id, {
      id: input.id,
      family: input.family ?? null,
      baseModel: input.baseModel ?? null,
      aliases: input.aliases ?? [],
      tags: input.tags ?? [],
      enabled: input.enabled ?? true,
      hard: hardFacts(input.hard),
      scores: scores(input.scores),
      sources: input.sources ?? [],
      origin,
      overridden: new Set(),
    })
  }
}

function applyOverrides(
  drafts: Map<string, Draft>,
  overrides: readonly ProfileOverride[],
  problems: string[],
): void {
  const seen = new Set<string>()
  for (const edit of overrides) {
    if (seen.has(edit.id)) {
      problems.push(`override ${edit.id}: duplicate override target`)
      continue
    }
    seen.add(edit.id)
    const draft = drafts.get(edit.id)
    if (draft === undefined) {
      const owner = [...drafts.values()].find((d) => d.aliases.includes(edit.id))
      problems.push(
        owner === undefined
          ? `override ${edit.id}: no profile with this canonical id`
          : `override ${edit.id}: is an alias of ${owner.id}; target the canonical id`,
      )
      continue
    }
    const set = <K extends "enabled" | "family" | "aliases" | "sources">(
      key: K,
      value: Draft[K] | undefined,
    ) => {
      if (value === undefined) return
      Object.assign(draft, { [key]: value })
      draft.overridden.add(key)
    }
    set("enabled", edit.enabled)
    set("family", edit.family)
    set("aliases", edit.aliases)
    set("sources", edit.sources)
    if (edit.tags !== undefined) {
      const kept = (edit.tags.set ?? draft.tags).filter((tag) => !edit.tags?.remove?.includes(tag))
      Object.assign(draft, { tags: [...new Set([...kept, ...(edit.tags.add ?? [])])] })
      draft.overridden.add("tags")
    }
    for (const key of HARD_KEYS) {
      const value = edit.hard?.[key]
      if (value === undefined) continue
      Object.assign(draft, { hard: { ...draft.hard, [key]: value } })
      draft.overridden.add(`hard.${key}`)
    }
    for (const key of CAPABILITY_DIMENSIONS) {
      const value = edit.scores?.[key]
      if (value === undefined) continue
      Object.assign(draft, { scores: { ...draft.scores, [key]: value } })
      draft.overridden.add(`scores.${key}`)
    }
  }
}

function hardFacts(input: HardFactsInput | undefined): HardFacts {
  return {
    contextTokens: input?.contextTokens ?? null,
    maxOutputTokens: input?.maxOutputTokens ?? null,
    textInput: input?.textInput ?? null,
    textOutput: input?.textOutput ?? null,
    imageInput: input?.imageInput ?? null,
    toolUse: input?.toolUse ?? null,
    structuredOutput: input?.structuredOutput ?? null,
  }
}

function scores(input: ScoresInput | undefined): CapabilityScores {
  return Object.fromEntries(
    CAPABILITY_DIMENSIONS.map((dimension) => [dimension, input?.[dimension] ?? null]),
  ) as CapabilityScores
}

/** Fixed key order and sorted lists: serialization and the revision digest are deterministic. */
function finish(draft: Draft): ModelCapabilityProfile {
  return Object.freeze({
    id: draft.id,
    family: draft.family,
    baseModel: draft.baseModel,
    aliases: Object.freeze([...draft.aliases].sort()),
    tags: Object.freeze([...draft.tags].sort()),
    enabled: draft.enabled,
    hard: Object.freeze({ ...draft.hard }),
    scores: Object.freeze({ ...draft.scores }),
    sources: Object.freeze([...draft.sources].sort()),
    origin: draft.origin,
    overridden: Object.freeze([...draft.overridden].sort()),
  })
}

/** Facts that cannot all be true at once. Checked after merge, so an override cannot create one. */
function checkContradictions(profile: ModelCapabilityProfile, problems: string[]): void {
  const { hard, scores: score } = profile
  const fail = (message: string) => problems.push(`profile ${profile.id}: ${message}`)
  if (
    hard.contextTokens !== null &&
    hard.maxOutputTokens !== null &&
    hard.maxOutputTokens > hard.contextTokens
  ) {
    fail("hard.maxOutputTokens exceeds hard.contextTokens")
  }
  if (hard.textOutput === false && (hard.toolUse === true || hard.structuredOutput === true)) {
    fail("tool use / structured output require hard.textOutput")
  }
  const unsupportedButScored: readonly [keyof HardFacts, keyof CapabilityScores][] = [
    ["imageInput", "vision"],
    ["toolUse", "tool_use"],
    ["structuredOutput", "structured_output"],
  ]
  for (const [feature, dimension] of unsupportedButScored) {
    if (hard[feature] === false && score[dimension] !== null) {
      fail(`scores.${dimension} is set but hard.${feature} is false`)
    }
  }
}

/** Contents only — not `origin`/`overridden` — so identical effective data yields one digest. */
function revisionOf(shipped: string, profiles: readonly ModelCapabilityProfile[]) {
  const contents = profiles.map(({ origin: _origin, overridden: _overridden, ...rest }) => rest)
  const digest = createHash("sha256")
    .update(JSON.stringify({ schemaVersion: CAPABILITY_SCHEMA_VERSION, profiles: contents }))
    .digest("hex")
  return Object.freeze({
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    shipped,
    effective: `sha256:${digest}`,
  })
}
