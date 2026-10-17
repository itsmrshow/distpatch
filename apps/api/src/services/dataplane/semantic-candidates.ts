import type { ModelCapabilityCatalog } from "../capabilities"
import { listableModelIds, type ModelCatalogStore } from "../models"
import { type KeyScopeSnapshot, resolveScope } from "../routing"
import { isVirtualModelName } from "../virtual-models"
import type { RoutingCatalog } from "./types"

/**
 * The concrete model names a virtual model may choose from under one key: every name an in-scope
 * Account is **configured** to serve, requested-side, exactly as `GET /v1/models` names it
 * (`listableModelIds`: supported models and alias keys, and a subscription's catalog rows), that
 * identifies a capability profile. An uncatalogued name could never be selected — the selector
 * rejects it as `no-profile` — so it is not enumerated, and the per-name support check is spent only
 * on names a policy can rank.
 *
 * Every active virtual model is a chat policy: its selection is sent to a text inference endpoint.
 * A profile that **knows** it cannot take text in or give text out (`hard.textInput === false` or
 * `hard.textOutput === false`) is therefore never a candidate, whatever its scores — policies need
 * not require either fact, so without this it could win on score alone. `null` is unknown, not
 * `false`, and stays a candidate. A fixed request for such a model never reaches this function.
 *
 * Deliberately **static**. Scope is the configured intersection (pools, account lists), and the
 * only status read is the operator's own `disabled`. Live health, cooldowns, quota windows,
 * rate-limit readings, `exhausted` / `needs_reauth` overlays, latency and concurrency are not
 * consulted: they belong to account selection, which still runs — and fails over — after a
 * concrete model is chosen. A semantic choice that flickered with a cooldown would make the same
 * `auto-*` request mean different models minute to minute for reasons the policy never states.
 *
 * An Account that declares no model set (a passthrough) contributes only its alias keys, as on the
 * listing: "serves anything" is not a list of models a policy could rank. Names inside the
 * reserved virtual namespace are never candidates.
 *
 * Pure, synchronous, and over warm memory only — no query, no file, no network.
 */

/** The warm discovery store; a subscription's catalog rows are names it serves. */
export type CandidateModelsCatalog = Pick<ModelCatalogStore, "modelsOf"> | undefined

/** `resolveScope` reads accounts and pools only; the snapshot's clock is never consulted. */
const SCOPE_ONLY_CLOCK = new Date(0)

export function scopedConcreteModels(
  catalog: RoutingCatalog,
  scope: KeyScopeSnapshot,
  capabilities: ModelCapabilityCatalog,
  models: CandidateModelsCatalog = undefined,
): readonly string[] {
  const accounts = catalog.accounts()
  const { diagnostics } = resolveScope(
    {
      accounts: accounts.map((account) => account.snapshot),
      pools: catalog.pools(),
      now: SCOPE_ONLY_CLOCK,
    },
    { sessionKey: "", model: "", keyScope: scope },
  )
  const inScope = new Set(diagnostics.inScopeAccountIds)
  const candidate = (name: string) => {
    if (isVirtualModelName(name)) return false
    const profile = capabilities.resolve(name)
    return profile !== null && profile.hard.textInput !== false && profile.hard.textOutput !== false
  }
  const names = new Set<string>()
  for (const account of accounts) {
    if (!inScope.has(account.id) || account.snapshot.status === "disabled") continue
    const rows = models?.modelsOf(account.id) ?? []
    for (const name of listableModelIds(account.snapshot, rows, candidate)) names.add(name)
  }
  return [...names].sort()
}
