import { createCapabilityIntelligenceRepository, createDatabase } from "@multi-ai-router/db"
import {
  applyPublishedSnapshotToBootstrap,
  buildCapabilityCatalog,
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  type CompiledCapabilitySnapshotPayload,
  readCapabilityOverridesFile,
  SHIPPED_CAPABILITY_CATALOG,
  type ShippedCatalogInput,
} from "../../src/services/capabilities"
import { selectVirtualModel, virtualModels } from "../../src/services/virtual-models"

/**
 * `bin/calibrate matrix` — what every active virtual policy selects from the effective capability
 * catalog (published capability-intelligence snapshot layered over the static bootstrap catalog, or
 * bootstrap alone when `--bootstrap-only` or no database is available), and how fragile that choice is.
 */

async function loadPublishedSnapshot(): Promise<CompiledCapabilitySnapshotPayload | null> {
  if (process.argv.includes("--bootstrap-only")) return null
  const url = (process.env.DATABASE_URL ?? "").trim()
  if (!url) return null
  const handle = createDatabase({ url, maxConnections: 1 })
  try {
    const pub = await createCapabilityIntelligenceRepository(handle.db).getPublishedSnapshot()
    return (pub?.payload as CompiledCapabilitySnapshotPayload | undefined) ?? null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

function operatorOverrides(): unknown {
  const path = process.env.MODEL_CAPABILITY_OVERRIDES_PATH?.trim() || null
  if (!path) return null
  try {
    return readCapabilityOverridesFile(path)
  } catch (error) {
    process.stderr.write(
      `bin/calibrate matrix: refusing to run with invalid operator overrides (${(error as Error).message})\n`,
    )
    process.exit(1)
  }
}

const published = await loadPublishedSnapshot()
const base = applyPublishedSnapshotToBootstrap(
  SHIPPED_CAPABILITY_CATALOG,
  published,
  operatorOverrides(),
)
const effectiveInput: ShippedCatalogInput = {
  schemaVersion: SHIPPED_CAPABILITY_CATALOG.schemaVersion,
  revision: SHIPPED_CAPABILITY_CATALOG.revision,
  profiles: base.list().map((p) => ({
    id: p.id,
    family: p.family,
    aliases: [...p.aliases],
    tags: [...p.tags],
    enabled: p.enabled,
    hard: { ...p.hard },
    scores: { ...p.scores },
    sources: [...p.sources],
  })),
}
const candidates = effectiveInput.profiles.map((p) => p.id).sort()

type Scores = Partial<Record<CapabilityDimension, number | null>>
function withScore(id: string, dimension: CapabilityDimension, value: number) {
  return buildCapabilityCatalog({
    ...effectiveInput,
    profiles: effectiveInput.profiles.map((p) =>
      p.id === id ? { ...p, scores: { ...(p.scores as Scores), [dimension]: value } } : p,
    ),
  })
}

const out: string[] = [
  `catalog shipped=${base.revision().shipped} snapshot=${published?.revision ?? "none"} effective=${base.revision().effective}`,
  "",
]
for (const descriptor of virtualModels()) {
  const decision = selectVirtualModel(base, descriptor, candidates)
  const [first, second] = decision.ranked
  const weights = Object.entries(descriptor.policy.weights)
    .map(([d, w]) => `${d}:${w}`)
    .join(" ")
  out.push(`## ${descriptor.id}  (${weights})`)
  for (const r of decision.ranked) {
    out.push(
      `  ${r.profileId.padEnd(30)} score ${r.score.toFixed(4)}  coverage ${r.coverage.toFixed(2)}  unknown [${r.unknownDimensions.join(", ")}]`,
    )
  }
  for (const r of decision.rejected) {
    out.push(`  ${r.model.padEnd(30)} rejected: ${r.reasons.map((x) => x.code).join(", ")}`)
  }
  if (first === undefined) {
    out.push("  no eligible model", "")
    continue
  }
  const margin = second === undefined ? null : first.score - second.score
  const winnerProfile = base.get(first.profileId)
  const winnerCompiled = published?.models?.[first.profileId]
  const contributing = Object.entries(descriptor.policy.weights)
    .filter(([d, w]) => (w ?? 0) > 0 && winnerProfile?.scores[d as CapabilityDimension] !== null)
    .map(([d, w]) => {
      const dim = d as CapabilityDimension
      const val = winnerProfile?.scores[dim]
      const src = winnerCompiled?.dimensions[dim]?.sources.join("+") ?? "bootstrap"
      return `${dim}=${val?.toFixed(4)} (w=${w}, src=${src})`
    })
  out.push(
    `  winner ${first.profileId}; runner-up ${second?.profileId ?? "—"}; margin ${margin === null ? "—" : margin.toFixed(4)}${margin !== null && margin === 0 ? " (tie: decided by coverage / preference / id)" : ""}`,
  )
  out.push(
    `  contributing: ${contributing.length === 0 ? "none (0 score tie-break)" : contributing.join(", ")}`,
  )
  out.push(`  decision digest: ${decision.digest}`)
  for (const delta of [0.05, 0.1]) {
    const flips: string[] = []
    for (const p of base.list()) {
      for (const d of CAPABILITY_DIMENSIONS) {
        const v = p.scores[d]
        if (v === null || (descriptor.policy.weights[d] ?? 0) === 0) continue
        for (const sign of [-1, 1]) {
          const nv = Math.min(1, Math.max(0, v + sign * delta))
          if (nv === v) continue
          const w = selectVirtualModel(withScore(p.id, d, nv), descriptor, candidates).selected
          if (w?.profileId !== first.profileId)
            flips.push(`${p.id}.${d}${sign > 0 ? "+" : "-"}${delta} → ${w?.profileId}`)
        }
      }
    }
    out.push(`  ±${delta} flips: ${flips.length === 0 ? "none" : flips.join("; ")}`)
  }

  const hidden: string[] = []
  for (const r of decision.ranked) {
    for (const d of r.unknownDimensions) {
      const w = selectVirtualModel(withScore(r.profileId, d, 1), descriptor, candidates).selected
      if (w?.profileId !== first.profileId) hidden.push(`${r.profileId}.${d}=1 → ${w?.profileId}`)
    }
  }
  out.push(`  unknown-as-1.0 flips: ${hidden.length === 0 ? "none" : hidden.join("; ")}`, "")
}
process.stdout.write(`${out.join("\n")}\n`)
