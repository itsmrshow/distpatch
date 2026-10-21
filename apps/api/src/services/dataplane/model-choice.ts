import {
  InvalidRequestError,
  ModelNotFoundError,
  NoEligibleModelError,
} from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { ModelCapabilityCatalog } from "../capabilities"
import type { ModelSelectionDecision } from "../model-selection"
import type { KeyScopeSnapshot } from "../routing"
import {
  isVirtualModelName,
  selectVirtualModel,
  type VirtualModelDescriptor,
  virtualModel,
  virtualModels,
} from "../virtual-models"
import { type CandidateModelsCatalog, scopedConcreteModels } from "./semantic-candidates"
import type { RoutingCatalog, UpstreamOperation } from "./types"

/**
 * Which concrete model a request routes on — the step between `admitRoutingModel()` and
 * `selectAccounts()` (docs/distpatch/virtual-models.md).
 *
 * A **fixed** request (any name outside the reserved `auto` / `auto-*` namespace) is returned as
 * is: no candidate enumeration, no catalog lookup, no selector — one namespace check. A
 * **virtual** request is resolved here, before account selection ever sees it: the active
 * descriptor's policy and requirements choose among the key's statically configured concrete
 * models (`semantic-candidates.ts`) against the warm in-memory capability catalog. A reserved name
 * that is not active, or one asked of an operation the catalog cannot judge, is refused. So
 * `selectAccounts()` never receives a virtual name.
 */

/** What virtual resolution reads: the warm in-memory capability catalog, and warm discovery. */
export interface VirtualModelRouting {
  readonly capabilities: ModelCapabilityCatalog
  readonly models?: CandidateModelsCatalog
}

export interface VirtualChoice {
  readonly descriptor: VirtualModelDescriptor
  readonly decision: ModelSelectionDecision
}

export interface ModelChoice {
  /** Exactly what the client's body named — and therefore what its raw bytes still say. */
  readonly requestedModel: string
  /**
   * The concrete model Distpatch selected for a virtual request. Null for a fixed request: no
   * semantic selection happened, and the client's own name is what account selection routes on.
   */
  readonly selectedModel: string | null
  readonly virtual: VirtualChoice | null
}

/**
 * @throws ModelNotFoundError for a reserved name that is not an active virtual model.
 * @throws InvalidRequestError for a virtual model on `embeddings`, which no policy can judge.
 * @throws NoEligibleModelError when no concrete candidate satisfies the virtual policy.
 */
export function chooseModel(
  routing: VirtualModelRouting | undefined,
  catalog: RoutingCatalog,
  scope: KeyScopeSnapshot,
  requestedModel: string,
  operation: UpstreamOperation,
): ModelChoice {
  if (!isVirtualModelName(requestedModel)) {
    return { requestedModel, selectedModel: null, virtual: null }
  }
  const descriptor = virtualModel(requestedModel)
  // A router built without a capability catalog has no active virtual model; the namespace is
  // still Distpatch's, so the name is refused rather than routed as if an upstream owned it.
  if (descriptor === null || routing === undefined) throw unknownVirtualModel(requestedModel)
  if (operation === "embeddings") {
    // The catalog has no embedding dimension: an `auto-*` embedding would be a chat policy
    // choosing an embedding model blind.
    throw new InvalidRequestError(
      `Virtual model "${requestedModel}" selects chat models and is not available for embeddings: name a concrete embedding model`,
    )
  }
  const candidates = scopedConcreteModels(catalog, scope, routing.capabilities, routing.models)
  const decision = selectVirtualModel(routing.capabilities, descriptor, candidates)
  if (decision.selected === null) throw noEligibleModel(requestedModel, decision)
  return {
    requestedModel,
    selectedModel: decision.selected.model,
    virtual: { descriptor, decision },
  }
}

export function unknownVirtualModel(model: string): ModelNotFoundError {
  const active = virtualModels()
    .map((descriptor) => descriptor.id)
    .join(", ")
  return new ModelNotFoundError(
    `model "${model}" is not an available Distpatch virtual model (available: ${active})`,
  )
}

/**
 * The decision trace: one structured line per resolved virtual request (nothing for a fixed one),
 * carrying what makes the choice reproducible — the policy and its digest, the catalog revision,
 * the selector version and the decision digest. Model names and counts only; never a prompt, a
 * completion or a credential.
 */
export function traceVirtualChoice(
  logger: Logger | undefined,
  requestId: string,
  correlationId: string,
  choice: ModelChoice,
): void {
  if (choice.virtual === null) return
  const { decision } = choice.virtual
  logger?.info("virtual model selected", {
    component: "model-selection",
    requestId,
    correlationId,
    requestedModel: choice.requestedModel,
    selectedModel: decision.selected?.model ?? null,
    selectedProfile: decision.selected?.profileId ?? null,
    policyId: decision.policy.id,
    policyVersion: decision.policy.version,
    policyDigest: decision.policy.digest,
    catalogRevision: decision.catalogRevision.effective,
    selectorVersion: decision.selectorVersion,
    decisionDigest: decision.digest,
    eligible: decision.ranked.length,
    rejected: decision.rejected.length,
  })
}

/**
 * Names the virtual model, the policy and catalog revision that judged it, and how many candidates
 * failed which rule — enough to act on, and nothing about accounts, providers or credentials.
 */
function noEligibleModel(model: string, decision: ModelSelectionDecision): NoEligibleModelError {
  const counts = new Map<string, number>()
  for (const rejected of decision.rejected) {
    for (const reason of rejected.reasons)
      counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1)
  }
  const reasons = [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, count]) => `${code} ×${count}`)
    .join(", ")
  return new NoEligibleModelError(
    `virtual model "${model}" has no eligible concrete model in this key's scope ` +
      `(policy ${decision.policy.id} v${decision.policy.version}, catalog ${decision.catalogRevision.effective}, ` +
      `${decision.rejected.length} candidate(s)${reasons === "" ? "" : `: ${reasons}`})`,
  )
}
