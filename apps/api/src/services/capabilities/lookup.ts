import type { CatalogRevision, ModelCapabilityCatalog, ModelCapabilityProfile } from "./types"

/**
 * The read side: one `Map` from every canonical id and catalog alias to its profile. Aliases are
 * one hop — an alias names a canonical id, never another alias — so there are no chains to
 * cycle; a name claimed twice (two aliases, or an alias equal to any canonical id) is a collision
 * and is reported rather than resolved by order.
 *
 * Resolution identifies a profile. It never yields a wire name: what goes upstream stays the
 * Account's business (`routing/model.ts`).
 */
export function createCatalogLookup(
  profiles: readonly ModelCapabilityProfile[],
  revision: CatalogRevision,
  problems: string[],
): ModelCapabilityCatalog {
  const byId = new Map<string, ModelCapabilityProfile>()
  for (const profile of profiles) byId.set(profile.id, profile)

  const byName = new Map(byId)
  for (const profile of profiles) {
    for (const alias of profile.aliases) {
      const owner = byName.get(alias)
      if (owner === undefined) {
        byName.set(alias, profile)
        continue
      }
      const what = byId.has(alias) ? "collides with canonical id" : "is already an alias of"
      problems.push(`profile ${profile.id}: alias ${alias} ${what} ${owner.id}`)
    }
  }

  const list = Object.freeze([...profiles])
  return {
    resolve: (model) => byName.get(model.trim().toLowerCase()) ?? null,
    get: (id) => byId.get(id) ?? null,
    list: () => list,
    revision: () => revision,
  }
}
