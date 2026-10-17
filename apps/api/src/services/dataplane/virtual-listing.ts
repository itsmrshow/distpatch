import { ModelNotFoundError } from "@multi-ai-router/core"
import type { KeyScopeSnapshot } from "../routing"
import {
  isVirtualModelName,
  selectVirtualModel,
  type VirtualModelDescriptor,
  virtualModel,
  virtualModels,
} from "../virtual-models"
import { unknownVirtualModel, type VirtualModelRouting } from "./model-choice"
import type { ReachableModel } from "./models"
import { scopedConcreteModels } from "./semantic-candidates"
import type { RoutingCatalog } from "./types"

/**
 * Distpatch's virtual models on `GET /v1/models` and `GET /v1/models/:id` — additive to the real
 * listing, never a change to it.
 *
 * A virtual entry is **router-owned** (`owned_by: distpatch`): no upstream provider, no
 * `resolved_model` (the concrete model is a policy outcome, not a fixed alias), and no context or
 * output size (whichever concrete model is selected decides those). It is listed for a key only
 * when its policy has at least one eligible concrete candidate under that key's **static** scope —
 * the same candidate set and selector the request path uses — so a cooldown or a spent quota
 * window never makes a virtual model blink in or out of the listing.
 */

export const VIRTUAL_MODEL_OWNER = "distpatch"

/**
 * The real listing as it was — minus any name inside the reserved namespace, which a request could
 * never reach as a concrete model — followed by the active virtual models this key can use.
 */
export function withVirtualModels(
  routing: VirtualModelRouting | undefined,
  catalog: RoutingCatalog,
  scope: KeyScopeSnapshot,
  real: readonly ReachableModel[],
): readonly ReachableModel[] {
  const listed = real.filter((model) => !isVirtualModelName(model.id))
  if (routing === undefined) return listed
  const candidates = scopedConcreteModels(catalog, scope, routing.capabilities, routing.models)
  const usable = virtualModels().filter(
    (descriptor) =>
      selectVirtualModel(routing.capabilities, descriptor, candidates).selected !== null,
  )
  return [...listed, ...usable.map(virtualEntry)]
}

/**
 * The `GET /v1/models/:id` branch that runs before the concrete reachability probe. Null for a
 * name outside the reserved namespace — the caller's concrete probe answers it.
 *
 * @throws ModelNotFoundError for an inactive reserved name, or an active one with no eligible
 *   concrete model under this key — the endpoint's existing "not reachable for this key" answer.
 */
export function virtualModelProbe(
  routing: VirtualModelRouting | undefined,
  catalog: RoutingCatalog,
  scope: KeyScopeSnapshot,
  id: string,
): ReachableModel | null {
  if (!isVirtualModelName(id)) return null
  const descriptor = virtualModel(id)
  if (descriptor === null || routing === undefined) throw unknownVirtualModel(id)
  const candidates = scopedConcreteModels(catalog, scope, routing.capabilities, routing.models)
  if (selectVirtualModel(routing.capabilities, descriptor, candidates).selected === null) {
    throw new ModelNotFoundError(
      `model "${id}" is not reachable: no concrete model in this key's scope satisfies virtual policy ${descriptor.policy.id} v${descriptor.policy.version}`,
    )
  }
  return virtualEntry(descriptor)
}

function virtualEntry(descriptor: VirtualModelDescriptor): ReachableModel {
  return {
    id: descriptor.id,
    owner: VIRTUAL_MODEL_OWNER,
    resolvedModel: null,
    contextTokens: null,
    maxOutputTokens: null,
  }
}
