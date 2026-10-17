import type { ModelCapabilityCatalog } from "../capabilities"
import { type ModelSelectionDecision, selectModel } from "../model-selection"
import type { VirtualModelDescriptor } from "./registry"

/**
 * One virtual model's choice among concrete candidates: the descriptor's own policy and hard
 * requirements, the injected (boot-loaded) capability catalog, and nothing else — no accounts, no
 * health, no quota. Pure and synchronous; the same inputs always give the same decision and digest.
 *
 * The one place a request's virtual model meets `selectModel()`, shared by the request path and
 * the `/v1/models` listing so the two can never disagree about whether a virtual model has a
 * candidate under a key.
 */
export function selectVirtualModel(
  capabilities: ModelCapabilityCatalog,
  descriptor: VirtualModelDescriptor,
  candidates: readonly string[],
): ModelSelectionDecision {
  return selectModel(capabilities, {
    candidates,
    requirements: descriptor.requirements,
    policy: descriptor.policy,
  })
}
