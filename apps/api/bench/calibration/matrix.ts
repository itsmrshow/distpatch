import {
  buildCapabilityCatalog,
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  SHIPPED_CAPABILITY_CATALOG,
} from "../../src/services/capabilities"
import { selectVirtualModel, virtualModels } from "../../src/services/virtual-models"

/**
 * `bin/calibrate matrix` — what every active virtual policy selects from the shipped catalog, and
 * how fragile that choice is.
 *
 * Candidates: every shipped profile's canonical id. Sensitivity perturbs one known score at a
 * time by ±δ (clamped to [0, 1]) and reports every perturbation that changes the winner; δ = 0.05
 * is about one failed check in a dimension, δ = 0.10 about one failed case. It also reports what
 * happens if each unknown, weighted dimension of a ranked model were known at 1.0 — the most
 * that missing evidence could be hiding.
 */

const shipped = SHIPPED_CAPABILITY_CATALOG
const candidates = shipped.profiles.map((p) => p.id).sort()

type Scores = Partial<Record<CapabilityDimension, number | null>>
function withScore(id: string, dimension: CapabilityDimension, value: number) {
  return buildCapabilityCatalog({
    ...shipped,
    profiles: shipped.profiles.map((p) =>
      p.id === id ? { ...p, scores: { ...(p.scores as Scores), [dimension]: value } } : p,
    ),
  })
}

const base = buildCapabilityCatalog(shipped)
const out: string[] = [`catalog ${base.revision().shipped} ${base.revision().effective}`, ""]

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
  out.push(
    `  winner ${first.profileId}; runner-up ${second?.profileId ?? "—"}; margin ${margin === null ? "—" : margin.toFixed(4)}${margin !== null && margin === 0 ? " (tie: decided by coverage / preference / id)" : ""}`,
  )

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
