import { z } from "zod"
import {
  CanonicalModelId,
  CatalogAlias,
  type HardFactsInput,
  type ProfileInput,
  SourceRef,
} from "../schema"

/**
 * Provider-neutral **route-model discovery**.
 *
 * A *route model* is a name a serving endpoint exposes (`qwen3.8-27b` on a local host). Discovery
 * asks an endpoint what each route serves, in layers that are never conflated:
 *
 *   semantic identity   `semanticModelId`  what model this is        → capability catalog profile
 *   lineage             `baseModelId`      what it derives from      → profile `baseModel`
 *   artifact / runtime  `artifact`, `runtime`  which weights, which engine → stored route evidence
 *   route identity      `routeModelId`     the name clients call     → catalog alias
 *   capabilities        `capabilities`     what the route exposes    → profile hard facts
 *   provenance          `provenance`       how identity was verified → profile sources
 *
 * Any source (llama-swap/DockerLM, Ollama, MLX, an OpenAI-compatible server, NVIDIA, …) implements
 * `RouteModelSource` and nothing downstream knows which. Discovery, reconciliation and profile
 * derivation are **off the inference request path**: they run in `bin/capabilities sync` and their
 * result reaches inference only inside the published, immutable catalog snapshot.
 */

const nullableBool = z.boolean().nullable().optional()

export const RouteModelDescriptorSchema = z.strictObject({
  routeModelId: z.string().min(1),
  semanticModelId: CanonicalModelId.nullable(),
  baseModelId: CanonicalModelId.nullable(),
  derivativeModelId: CanonicalModelId.nullable(),
  artifact: z
    .strictObject({
      repository: z.string().optional(),
      files: z.array(z.string()).optional(),
      format: z.string().optional(),
      quantization: z.string().optional(),
    })
    .optional(),
  runtime: z
    .strictObject({ name: z.string().optional(), version: z.string().optional() })
    .optional(),
  capabilities: z.strictObject({
    textInput: nullableBool,
    textOutput: nullableBool,
    imageInput: nullableBool,
    embedding: nullableBool,
    contextTokens: z.number().int().positive().nullable().optional(),
  }),
  routing: z
    .strictObject({ modelType: z.string().optional(), endpoint: z.string().optional() })
    .optional(),
  provenance: z
    .strictObject({
      semanticModelSource: z.string().optional(),
      artifactSource: z.string().optional(),
      resolutionMethod: z.string().optional(),
      confidence: z.string().optional(),
    })
    .optional(),
})
export type RouteModelDescriptor = z.infer<typeof RouteModelDescriptorSchema>

export interface RejectedRouteModel {
  /** The route id when one could be read, so reconciliation can keep its last-known-good row. */
  readonly routeModelId: string | null
  readonly reason: string
}

export interface RouteDiscoveryResult {
  readonly descriptors: readonly RouteModelDescriptor[]
  readonly rejected: readonly RejectedRouteModel[]
}

export interface RouteModelSource {
  /** Stable source id, e.g. `dockerlm`. Rows are keyed by `(source, routeModelId)`. */
  readonly id: string
  /** Semantic tags this source contributes to the models it serves (`local`). */
  readonly tags: readonly string[]
  /** Rejects on outage or an unreadable listing; the caller keeps last-known-good state. */
  discover(): Promise<RouteDiscoveryResult>
}

export type RouteModelStatus = "present" | "absent"

export interface StoredRouteModel {
  readonly source: string
  readonly routeModelId: string
  readonly descriptor: RouteModelDescriptor
  readonly tags: readonly string[]
  readonly status: RouteModelStatus
  readonly firstSeenAt: Date
  readonly lastSeenAt: Date
  readonly absentSince: Date | null
}

export interface RouteReconciliationSummary {
  readonly source: string
  readonly added: readonly string[]
  readonly changed: readonly string[]
  readonly reappeared: readonly string[]
  readonly unchanged: readonly string[]
  readonly absent: readonly string[]
  /** Listed but untrusted: skipped, previous row (if any) left exactly as it was. */
  readonly rejected: readonly RejectedRouteModel[]
}

/** Key-order independent JSON, so equal descriptors compare equal however they were built. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Pure reconciliation of one successful discovery against stored state. Returns only the rows to
 * write.
 *
 * - new route → `present`, first seen now;
 * - changed descriptor or tags (a quant/runtime/identity change) → descriptor updated in place; the
 *   semantic identity changes only if the descriptor's `semanticModelId` itself changed;
 * - previously `absent` route listed again → `present` again;
 * - stored `present` route no longer listed → `absent` (history kept, never deleted), **unless** it
 *   was listed but rejected this time: an untrusted entry is not evidence of removal;
 * - unchanged → no write.
 *
 * A failed discovery never reaches this function, so an outage cannot mark anything absent.
 */
export function reconcileRouteModels(
  stored: readonly StoredRouteModel[],
  source: Pick<RouteModelSource, "id" | "tags">,
  result: RouteDiscoveryResult,
  now: Date,
): { readonly rows: readonly StoredRouteModel[]; readonly summary: RouteReconciliationSummary } {
  const mine = new Map(stored.filter((r) => r.source === source.id).map((r) => [r.routeModelId, r]))
  const tags = [...source.tags].sort()
  const rows: StoredRouteModel[] = []
  const added: string[] = []
  const changed: string[] = []
  const reappeared: string[] = []
  const unchanged: string[] = []
  const absent: string[] = []
  const listed = new Set<string>()

  for (const descriptor of result.descriptors) {
    const id = descriptor.routeModelId
    listed.add(id)
    const previous = mine.get(id)
    if (previous === undefined) {
      added.push(id)
      rows.push({
        source: source.id,
        routeModelId: id,
        descriptor,
        tags,
        status: "present",
        firstSeenAt: now,
        lastSeenAt: now,
        absentSince: null,
      })
      continue
    }
    const same =
      stable(previous.descriptor) === stable(descriptor) &&
      stable([...previous.tags].sort()) === stable(tags)
    if (previous.status === "absent") reappeared.push(id)
    else if (same) {
      unchanged.push(id)
      continue
    } else changed.push(id)
    rows.push({
      ...previous,
      descriptor,
      tags,
      status: "present",
      lastSeenAt: now,
      absentSince: null,
    })
  }

  const untrusted = new Set(
    result.rejected.flatMap((r) => (r.routeModelId === null ? [] : [r.routeModelId])),
  )
  for (const previous of mine.values()) {
    if (previous.status !== "present" || listed.has(previous.routeModelId)) continue
    if (untrusted.has(previous.routeModelId)) continue
    absent.push(previous.routeModelId)
    rows.push({ ...previous, status: "absent", absentSince: now })
  }

  return {
    rows,
    summary: {
      source: source.id,
      added: added.sort(),
      changed: changed.sort(),
      reappeared: reappeared.sort(),
      unchanged: unchanged.sort(),
      absent: absent.sort(),
      rejected: result.rejected,
    },
  }
}

/** An embedding route by any of the three things a source can say about it. */
export function isEmbeddingRoute(descriptor: RouteModelDescriptor): boolean {
  return (
    descriptor.capabilities.embedding === true ||
    descriptor.routing?.modelType === "embedding" ||
    descriptor.routing?.endpoint?.endsWith("/embeddings") === true
  )
}

/**
 * Derives catalog profiles from the **present** route models. One profile per semantic id, however
 * many routes (quants, runtimes) serve it.
 *
 * - Only routes with a verified semantic id make a profile; unresolved routes stay stored evidence.
 * - `baseModel` is set only for a true derivative (semantic ≠ base).
 * - Route names become aliases, never canonical ids, and an alias already claimed (by the bootstrap
 *   catalog, another profile, or any canonical id) is dropped rather than failing the build.
 * - A semantic id the bootstrap catalog already defines is skipped: bootstrap is authoritative.
 * - Hard facts come from what routes *expose*: `true` is kept, `false` text support is kept (an
 *   embedding model emits no text), but an image input a route lacks is *unknown*, not unsupported
 *   (a route without its multimodal projector says nothing about the model). Routes of one model
 *   that disagree leave the fact unknown. Route context windows are route configuration, so
 *   `contextTokens` is never lifted into the semantic profile.
 * - An embedding model is tagged `embedding` plus its source's tags and has `textOutput: false`.
 */
export function deriveDiscoveredProfiles(
  rows: readonly StoredRouteModel[],
  claimedIds: ReadonlySet<string>,
  claimedAliases: ReadonlySet<string>,
): { readonly profiles: readonly ProfileInput[]; readonly skipped: readonly string[] } {
  const present = rows
    .filter((r) => r.status === "present" && r.descriptor.semanticModelId !== null)
    .sort((a, b) => (a.routeModelId < b.routeModelId ? -1 : 1))
  const groups = new Map<string, StoredRouteModel[]>()
  for (const row of present) {
    const id = row.descriptor.semanticModelId as string
    groups.set(id, [...(groups.get(id) ?? []), row])
  }

  const aliasTaken = new Set(claimedAliases)
  const profiles: ProfileInput[] = []
  const skipped: string[] = []
  for (const [id, group] of groups) {
    if (claimedIds.has(id)) {
      skipped.push(id)
      continue
    }
    const aliases: string[] = []
    for (const row of group) {
      const alias = row.routeModelId.trim().toLowerCase()
      if (!CatalogAlias.safeParse(alias).success) continue
      if (aliasTaken.has(alias) || claimedIds.has(alias) || groups.has(alias)) continue
      aliasTaken.add(alias)
      aliases.push(alias)
    }

    const embedding = group.some((r) => isEmbeddingRoute(r.descriptor))
    const bases = new Set(group.map((r) => r.descriptor.baseModelId))
    const base = bases.size === 1 ? (bases.values().next().value ?? null) : null
    const agree = (pick: (d: RouteModelDescriptor) => boolean | null | undefined) => {
      const values = group.map((r) => pick(r.descriptor) ?? null)
      return values.every((v) => v === values[0]) ? (values[0] ?? null) : null
    }
    const hard: HardFactsInput = {
      textInput: agree((d) => d.capabilities.textInput),
      textOutput: embedding ? false : agree((d) => d.capabilities.textOutput),
      imageInput: group.some((r) => r.descriptor.capabilities.imageInput === true) ? true : null,
      ...(embedding ? { toolUse: false, structuredOutput: false } : {}),
    }
    const tags = [
      ...new Set([...(embedding ? ["embedding"] : []), ...group.flatMap((r) => r.tags)]),
    ].sort()
    const sources = [
      ...new Set(
        group.flatMap((r) => {
          const ref = r.descriptor.provenance?.semanticModelSource
          return ref !== undefined && SourceRef.safeParse(ref).success ? [ref] : []
        }),
      ),
    ].sort()

    profiles.push({
      id,
      ...(base !== null && base !== id ? { baseModel: base } : {}),
      aliases,
      tags,
      hard,
      ...(sources.length > 0 ? { sources } : {}),
    })
  }
  return {
    profiles: profiles.sort((a, b) => (a.id < b.id ? -1 : 1)),
    skipped: skipped.sort(),
  }
}
