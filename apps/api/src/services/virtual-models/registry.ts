import { ModelRequirements, SelectionPolicy } from "../model-selection"
import { splitContextTag } from "../routing/context-tag"

/**
 * Distpatch's virtual models: router-owned names (`auto`, `auto-*`) that stand for a **policy**,
 * not for a model (docs/distpatch/virtual-models.md).
 *
 * Each descriptor pairs a versioned M2B {@link SelectionPolicy} with explicit hard
 * {@link ModelRequirements}. Resolution feeds both, plus the concrete names the presenting key can
 * route, to `selectModel()`; the winner — a concrete model — is what account selection sees. The
 * registry says nothing about providers, accounts, credentials, quota or health, and carries no
 * model ranking of its own: which model wins is decided by the capability catalog's data alone.
 *
 * Static, frozen and validated once at module load. Changing a policy's semantics bumps that
 * policy's `version`; adding, removing or re-meaning a descriptor bumps
 * {@link VIRTUAL_MODEL_REGISTRY_VERSION}.
 */

export const VIRTUAL_MODEL_REGISTRY_VERSION = 1

export interface VirtualModelDescriptor {
  /** The name a client sends, exactly. */
  readonly id: string
  /** One line for docs and logs: what this virtual model is for. */
  readonly intent: string
  readonly policy: SelectionPolicy
  readonly requirements: ModelRequirements
}

/**
 * Names inside the reserved namespace that are deliberately **not** active.
 *
 * - `auto-free`: "free" is usually a property of the route (which provider, which account, which
 *   plan), not of the model — the same weights are paid on one host and free on another. Account
 *   selection has no route-level "free only" constraint today, and the semantic selector must not
 *   learn about accounts to fake one, so the name stays reserved.
 * - `auto-moe`: multi-model fan-out and merge belongs to the Auto-MoE milestone (#15).
 */
export const RESERVED_VIRTUAL_MODEL_IDS: readonly string[] = Object.freeze([
  "auto-free",
  "auto-moe",
])

/**
 * True for every name Distpatch owns: `auto`, anything starting `auto-`, case-insensitively, with
 * or without a trailing context tag (`auto[1m]`). Such a name never reaches account selection
 * unresolved — an active one is resolved, anything else is refused as not found.
 */
export function isVirtualModelName(model: string): boolean {
  const base = (splitContextTag(model)?.base ?? model).toLowerCase()
  return base === "auto" || base.startsWith("auto-")
}

/** The active descriptor named exactly `model`, or null. No case folding, no aliases, no fuzz. */
export function virtualModel(model: string): VirtualModelDescriptor | null {
  return BY_ID.get(model) ?? null
}

/** Every active virtual model, in id order. */
export function virtualModels(): readonly VirtualModelDescriptor[] {
  return ACTIVE
}

/**
 * Weights are relative importance over the catalog's preference dimensions. Unknown scores earn
 * no credit (`model-selection.md`); nothing here substitutes for a measured score.
 */
const ACTIVE: readonly VirtualModelDescriptor[] = Object.freeze(
  [
    define({
      id: "auto",
      intent: "Balanced general-purpose quality",
      weights: { general: 40, reasoning: 30, agentic: 15, tool_use: 15 },
    }),
    define({
      id: "auto-fast",
      intent: "Low latency by static speed class, keeping useful general capability",
      weights: { speed: 65, general: 35 },
    }),
    define({
      id: "auto-task",
      intent: "Reliable task execution and agentic tool use",
      weights: { agentic: 35, tool_use: 30, general: 20, reasoning: 15 },
      requirements: { toolUse: true },
    }),
    define({
      id: "auto-research",
      intent: "Reasoning over long context",
      weights: { reasoning: 35, long_context: 30, general: 20, tool_use: 15 },
    }),
    define({
      id: "auto-plan",
      intent: "Planning: reasoning and agentic structure over long context",
      weights: { reasoning: 40, agentic: 25, long_context: 20, general: 15 },
    }),
    define({
      id: "auto-review",
      intent: "Review and judging, code included",
      weights: { review: 40, reasoning: 25, coding: 20, general: 15 },
    }),
    define({
      id: "auto-max",
      intent: "Highest semantic quality, regardless of speed or cost",
      weights: {
        general: 25,
        reasoning: 25,
        coding: 15,
        agentic: 15,
        review: 10,
        long_context: 10,
      },
    }),
    define({
      id: "auto-local",
      intent: "Local inference only (profiles tagged `local`), ranked like `auto`",
      weights: { general: 40, reasoning: 30, agentic: 15, tool_use: 15 },
      requirements: { requireTags: ["local"] },
    }),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
)

const BY_ID: ReadonlyMap<string, VirtualModelDescriptor> = new Map(ACTIVE.map((d) => [d.id, d]))

interface DescriptorSource {
  readonly id: string
  readonly intent: string
  readonly weights: Record<string, number>
  readonly requirements?: Record<string, unknown>
}

/** Validated through the same Zod schemas `selectModel` documents, then deeply frozen. */
function define(source: DescriptorSource): VirtualModelDescriptor {
  if (!isVirtualModelName(source.id)) throw new Error(`virtual model ${source.id}: not reserved`)
  if (RESERVED_VIRTUAL_MODEL_IDS.includes(source.id)) {
    throw new Error(`virtual model ${source.id}: reserved as inactive`)
  }
  return deepFreeze({
    id: source.id,
    intent: source.intent,
    // The policy id is the virtual id: a recorded decision names the virtual model it served.
    policy: SelectionPolicy.parse({ id: source.id, version: 1, weights: source.weights }),
    requirements: ModelRequirements.parse(source.requirements ?? {}),
  })
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
