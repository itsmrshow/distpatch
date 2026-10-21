import { createHash } from "node:crypto"
import { z } from "zod"
import { createCatalogLookup } from "./lookup"
import {
  CAPABILITY_DIMENSIONS,
  CAPABILITY_SCHEMA_VERSION,
  CatalogOverridesInput,
  HARD_FEATURES,
  type HardFactsInput,
  ProfileInput,
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
 * shipped catalog + discovered profiles + validated operator overrides → one immutable snapshot.
 *
 * Pure: no I/O, no clock. Strict problems — schema, duplicate targets, alias targets,
 * target-independent alias collisions, or contradictions on bootstrap/operator profiles — collect
 * into one {@link CapabilityCatalogError}. Missing canonical targets are inert and reported;
 * discovered-target edits that would invalidate the catalog are rejected atomically and reported.
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

export interface RejectedCapabilityOverride {
  readonly id: string
  readonly reason: string
}

export interface CapabilityCatalogWithUnmatchedOverrides extends ModelCapabilityCatalog {
  /** Canonical override targets not present in this effective catalog, sorted by id. */
  unmatchedOverrideIds(): readonly string[]
  /** Discovered targets whose entire override was rejected because it would invalidate the catalog. */
  rejectedOverrides(): readonly RejectedCapabilityOverride[]
}

const HARD_KEYS = ["contextTokens", "maxOutputTokens", ...HARD_FEATURES] as const

export function buildCapabilityCatalog(
  shipped: unknown,
  overrides: unknown = null,
  discovered: unknown = [],
): CapabilityCatalogWithUnmatchedOverrides {
  const problems: string[] = []
  const base = parse(ShippedCatalogInput, shipped, "shipped", problems)
  const edits =
    overrides === null ? null : parse(CatalogOverridesInput, overrides, "overrides", problems)
  const found = parse(z.array(ProfileInput), discovered, "discovered", problems)
  if (base === null || problems.length > 0) throw new CapabilityCatalogError(problems)

  const operatorProfiles = edits?.profiles ?? []
  const operatorOverrides = edits?.overrides ?? []
  validateTargetIndependentOverrides(
    [...base.profiles, ...operatorProfiles],
    operatorOverrides,
    problems,
  )
  if (problems.length > 0) throw new CapabilityCatalogError(problems)

  const discoveredProfiles = yieldDiscoveredProfiles(
    base.profiles,
    found ?? [],
    operatorProfiles,
    operatorOverrides,
  )
  const drafts = new Map<string, Draft>()
  addProfiles(drafts, base.profiles, "shipped", problems)
  addProfiles(drafts, discoveredProfiles, "discovered", problems)
  addProfiles(drafts, operatorProfiles, "operator", problems)
  const overrideStatus = applyOverrides(drafts, operatorOverrides, problems)
  const unmatchedOverrideIds = Object.freeze([...overrideStatus.unmatched].sort())
  const rejectedOverrides = Object.freeze(
    [...overrideStatus.rejected]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, reason }) => Object.freeze({ id, reason })),
  )

  const profiles = [...drafts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(finish)
  for (const profile of profiles) checkContradictions(profile, problems)
  const lookup = createCatalogLookup(profiles, revisionOf(base.revision, profiles), problems)
  if (problems.length > 0) throw new CapabilityCatalogError(problems)
  return Object.freeze({
    ...lookup,
    unmatchedOverrideIds: () => unmatchedOverrideIds,
    rejectedOverrides: () => rejectedOverrides,
  })
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
function validateTargetIndependentOverrides(
  profiles: readonly ProfileInput[],
  overrides: readonly ProfileOverride[],
  problems: string[],
): void {
  if (overrides.length === 0) return

  const canonicalIds = new Set(profiles.map((profile) => profile.id))
  const overrideTargetIds = new Set(overrides.map((edit) => edit.id))
  const aliasesById = new Map(profiles.map((profile) => [profile.id, profile.aliases ?? []]))
  for (const edit of overrides) {
    if (edit.aliases !== undefined && aliasesById.has(edit.id)) {
      aliasesById.set(edit.id, edit.aliases)
    }
  }

  const aliasOwners = new Map<string, Set<string>>()
  for (const [id, aliases] of aliasesById) {
    for (const alias of aliases) {
      const owners = aliasOwners.get(alias) ?? new Set<string>()
      owners.add(id)
      aliasOwners.set(alias, owners)
    }
  }

  const overrideAliasOwners = new Map<string, string>()
  for (const edit of overrides) {
    if (edit.hard !== undefined || edit.scores !== undefined) {
      const contradictions: string[] = []
      checkContradictions(
        {
          id: edit.id,
          family: null,
          baseModel: null,
          aliases: [],
          tags: [],
          enabled: true,
          hard: hardFacts(edit.hard),
          scores: scores(edit.scores),
          sources: [],
          origin: "operator",
          overridden: [],
        },
        contradictions,
      )
      problems.push(...contradictions)
    }

    for (const alias of edit.aliases ?? []) {
      if (alias === edit.id) {
        problems.push(`override ${edit.id}: alias ${alias} collides with its canonical id`)
      } else if (canonicalIds.has(alias)) {
        problems.push(`override ${edit.id}: alias ${alias} collides with canonical id ${alias}`)
      }
      if (alias !== edit.id && overrideTargetIds.has(alias)) {
        problems.push(`override ${alias}: is an alias of ${edit.id}; target the canonical id`)
      }

      const existingAliasOwner = [...(aliasOwners.get(alias) ?? [])].find(
        (owner) => owner !== edit.id,
      )
      if (existingAliasOwner !== undefined) {
        problems.push(
          `override ${edit.id}: alias ${alias} is already an alias of ${existingAliasOwner}`,
        )
      }

      const overrideAliasOwner = overrideAliasOwners.get(alias)
      if (overrideAliasOwner !== undefined && overrideAliasOwner !== edit.id) {
        problems.push(
          `override ${edit.id}: alias ${alias} is also claimed by override ${overrideAliasOwner}`,
        )
      } else {
        overrideAliasOwners.set(alias, edit.id)
      }
    }
  }
}

/**
 * Discovery yields to bootstrap/operator identities and their aliases. Unmatched override aliases
 * are also reserved, but aliases of a currently discovered target are checked atomically against
 * discovery so a conflicting edit can be rejected without trimming that discovered profile.
 */
function yieldDiscoveredProfiles(
  bootstrap: readonly ProfileInput[],
  discovered: readonly ProfileInput[],
  operatorProfiles: readonly ProfileInput[],
  operatorOverrides: readonly ProfileOverride[],
): readonly ProfileInput[] {
  const overrideAliasesById = new Map<string, readonly string[]>()
  const operatorAliasOwners = new Map<string, Set<string>>()
  const operatorProfileIds = new Set([
    ...bootstrap.map((profile) => profile.id),
    ...operatorProfiles.map((profile) => profile.id),
  ])
  const discoveredIds = new Set(discovered.map((profile) => profile.id))
  for (const edit of operatorOverrides) {
    if (edit.aliases === undefined) continue
    const targetsStaticProfile = operatorProfileIds.has(edit.id)
    if (!targetsStaticProfile && discoveredIds.has(edit.id)) continue
    if (targetsStaticProfile) overrideAliasesById.set(edit.id, edit.aliases)
    for (const alias of edit.aliases) {
      const owners = operatorAliasOwners.get(alias) ?? new Set<string>()
      owners.add(edit.id)
      operatorAliasOwners.set(alias, owners)
    }
  }
  const aliasesAfterOperatorEdits = (profile: ProfileInput) =>
    overrideAliasesById.get(profile.id) ?? profile.aliases ?? []
  const protectedNames = new Set([
    ...bootstrap.flatMap((profile) => [profile.id, ...aliasesAfterOperatorEdits(profile)]),
    ...operatorProfiles.flatMap((profile) => [profile.id, ...aliasesAfterOperatorEdits(profile)]),
  ])
  const canonicalIds = new Set([
    ...bootstrap.map((profile) => profile.id),
    ...operatorProfiles.map((profile) => profile.id),
    ...discovered.map((profile) => profile.id),
  ])
  const claimedAliases = new Set([
    ...bootstrap.flatMap(aliasesAfterOperatorEdits),
    ...operatorProfiles.flatMap(aliasesAfterOperatorEdits),
    ...operatorAliasOwners.keys(),
  ])
  const discoveredAliases = new Set<string>()
  const kept: ProfileInput[] = []

  for (const profile of [...discovered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (protectedNames.has(profile.id)) continue
    const overrideOwners = operatorAliasOwners.get(profile.id)
    if (overrideOwners !== undefined && !overrideOwners.has(profile.id)) continue

    const originalAliases = profile.aliases ?? []
    const aliases = originalAliases.filter((alias) => {
      if (canonicalIds.has(alias) || claimedAliases.has(alias) || discoveredAliases.has(alias)) {
        return false
      }
      discoveredAliases.add(alias)
      return true
    })
    kept.push(aliases.length === originalAliases.length ? profile : { ...profile, aliases })
  }
  return kept
}

function applyOverrides(
  drafts: Map<string, Draft>,
  overrides: readonly ProfileOverride[],
  problems: string[],
): {
  readonly unmatched: readonly string[]
  readonly rejected: readonly RejectedCapabilityOverride[]
} {
  const seen = new Set<string>()
  const unresolved: ProfileOverride[] = []
  const rejected: RejectedCapabilityOverride[] = []
  for (const edit of overrides) {
    if (seen.has(edit.id)) {
      problems.push(`override ${edit.id}: duplicate override target`)
      continue
    }
    seen.add(edit.id)
    const draft = drafts.get(edit.id)
    if (draft === undefined) {
      unresolved.push(edit)
      continue
    }
    if (draft.origin !== "discovered") {
      applyProfileOverride(draft, edit)
      continue
    }

    const candidate = { ...draft, overridden: new Set(draft.overridden) }
    applyProfileOverride(candidate, edit)
    const reason = discoveredOverrideRejectionReason(candidate, drafts)
    if (reason !== null) {
      rejected.push({ id: edit.id, reason })
    } else {
      drafts.set(edit.id, candidate)
    }
  }

  const unmatched: string[] = []
  for (const edit of unresolved) {
    const owner = [...drafts.values()].find((draft) => draft.aliases.includes(edit.id))
    if (owner === undefined) unmatched.push(edit.id)
    else {
      problems.push(`override ${edit.id}: is an alias of ${owner.id}; target the canonical id`)
    }
  }
  return { unmatched, rejected }
}

function applyProfileOverride(draft: Draft, edit: ProfileOverride): void {
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

function discoveredOverrideRejectionReason(
  candidate: Draft,
  drafts: Map<string, Draft>,
): string | null {
  const contradictions: string[] = []
  checkContradictions(finish(candidate), contradictions)
  const reasons = contradictions.map((problem) => problem.replace(`profile ${candidate.id}: `, ""))

  for (const alias of candidate.aliases) {
    if (alias === candidate.id) {
      reasons.push(`alias ${alias} collides with canonical id ${candidate.id}`)
      continue
    }
    let canonicalOwner: string | undefined
    let aliasOwner: string | undefined
    for (const profile of drafts.values()) {
      if (profile.id === candidate.id) continue
      if (profile.id === alias) {
        canonicalOwner = profile.id
        break
      }
      if (aliasOwner === undefined && profile.aliases.includes(alias)) aliasOwner = profile.id
    }
    if (canonicalOwner !== undefined) {
      reasons.push(`alias ${alias} collides with canonical id ${canonicalOwner}`)
    } else if (aliasOwner !== undefined) {
      reasons.push(`alias ${alias} is already an alias of ${aliasOwner}`)
    }
  }
  return reasons.length === 0 ? null : reasons.join("; ")
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
