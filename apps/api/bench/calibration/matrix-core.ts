import {
  applyPublishedSnapshotToBootstrap,
  buildCapabilityCatalog,
  type CapabilityDimension,
  type ShippedCatalogInput,
} from "../../src/services/capabilities"

export function createMatrixCatalog(
  bootstrap: ShippedCatalogInput,
  published: unknown | null,
  overrides: unknown,
) {
  const base = applyPublishedSnapshotToBootstrap(bootstrap, published, overrides)
  const effectiveInput: ShippedCatalogInput = {
    schemaVersion: bootstrap.schemaVersion,
    revision: bootstrap.revision,
    profiles: base.list().map((profile) => ({
      id: profile.id,
      family: profile.family,
      baseModel: profile.baseModel,
      aliases: [...profile.aliases],
      tags: [...profile.tags],
      enabled: profile.enabled,
      hard: { ...profile.hard },
      scores: { ...profile.scores },
      sources: [...profile.sources],
    })),
  }
  const rebuilt = buildCapabilityCatalog(effectiveInput)
  if (base.revision().effective !== rebuilt.revision().effective)
    throw new Error("matrix catalog reconstruction changed the effective catalog")
  return { base, effectiveInput, rebuilt }
}

export function withMatrixScore(
  input: ShippedCatalogInput,
  id: string,
  dimension: CapabilityDimension,
  value: number,
) {
  return buildCapabilityCatalog({
    ...input,
    profiles: input.profiles.map((profile) =>
      profile.id === id
        ? { ...profile, scores: { ...profile.scores, [dimension]: value } }
        : profile,
    ),
  })
}

export function matrixCandidates(input: ShippedCatalogInput): string[] {
  return input.profiles
    .filter((p) => p.hard?.textInput !== false && p.hard?.textOutput !== false)
    .map((p) => p.id)
    .sort()
}
export function scoreSource(
  overridden: readonly string[],
  dimension: string,
  effectiveValue: number | null,
  compiledValue: number | null | undefined,
  compiledSources: readonly string[] | undefined,
): string {
  if (overridden.includes(`scores.${dimension}`)) return "operator-override"
  if (compiledValue !== undefined && compiledValue === effectiveValue && compiledValue !== null) {
    return compiledSources?.join("+") || "bootstrap"
  }
  return "bootstrap"
}
