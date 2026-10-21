import { createCapabilityIntelligenceRepository, createDatabase } from "@multi-ai-router/db"
import {
  CAPABILITY_DIMENSIONS,
  type CapabilityDimension,
  type CompiledCapabilitySnapshotPayload,
  readCapabilityOverridesFile,
  SHIPPED_CAPABILITY_CATALOG,
} from "../../src/services/capabilities"
import { selectVirtualModel, virtualModels } from "../../src/services/virtual-models"
import { createMatrixCatalog, matrixCandidates, scoreSource, withMatrixScore } from "./matrix-core"

/**
 * `bin/calibrate matrix` — what every active virtual policy selects from the effective capability
 * catalog the runtime would build (static bootstrap ← published capability-intelligence snapshot ←
 * MODEL_CAPABILITY_OVERRIDES_PATH), and how fragile that choice is. It needs DATABASE_URL to read
 * the published snapshot and exits non-zero when that read fails; `--bootstrap-only` describes the
 * bootstrap (plus overrides) deliberately. Candidates are every text-capable catalog profile, not
 * only the models currently routable on some account.
 */

async function loadPublishedSnapshot(): Promise<CompiledCapabilitySnapshotPayload | null> {
  if (process.argv.includes("--bootstrap-only")) return null
  const url = (process.env.DATABASE_URL ?? "").trim()
  if (!url) {
    process.stderr.write(
      "bin/calibrate matrix: DATABASE_URL is required; use --bootstrap-only to describe the static bootstrap catalog.\n",
    )
    process.exit(1)
  }
  const handle = createDatabase({ url, maxConnections: 1 })
  try {
    const pub = await createCapabilityIntelligenceRepository(handle.db).getPublishedSnapshot()
    return (pub?.payload as CompiledCapabilitySnapshotPayload | undefined) ?? null
  } catch (error) {
    process.stderr.write(
      `bin/calibrate matrix: cannot read published capability snapshot from the configured DATABASE_URL: ${(error as Error).message}\nUse --bootstrap-only to describe the static bootstrap catalog deliberately.\n`,
    )
    process.exit(1)
  } finally {
    await handle.close()
  }
}

function operatorOverrides(): unknown {
  const path = process.env.MODEL_CAPABILITY_OVERRIDES_PATH
  if (path === undefined) return null
  if (path.length === 0) {
    process.stderr.write(
      "bin/calibrate matrix: invalid MODEL_CAPABILITY_OVERRIDES_PATH (must contain at least one character)\n",
    )
    process.exit(1)
  }
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
const { base, effectiveInput } = createMatrixCatalog(
  SHIPPED_CAPABILITY_CATALOG,
  published,
  operatorOverrides(),
)
const candidates = matrixCandidates(effectiveInput)
const out: string[] = [
  `catalog shipped=${base.revision().shipped} snapshot=${published?.revision ?? "none"} effective=${base.revision().effective}`,
  "",
  "Candidates: every text-capable catalog profile (including disabled profiles), not only profiles currently routable for each request.",
  "",
]
for (const descriptor of virtualModels()) {
  const decision = selectVirtualModel(base, descriptor, candidates)
  const [first, second] = decision.ranked
  const weights = Object.entries(descriptor.policy.weights)
    .map(([d, w]) => `${d}:${w}`)
    .join(" ")
  out.push(`## ${descriptor.id}  (${weights})`)
  for (const r of decision.ranked)
    out.push(
      `  ${r.profileId.padEnd(30)} score ${r.score.toFixed(4)}  coverage ${r.coverage.toFixed(2)}  unknown [${r.unknownDimensions.join(", ")}]`,
    )
  for (const r of decision.rejected)
    out.push(`  ${r.model.padEnd(30)} rejected: ${r.reasons.map((x) => x.code).join(", ")}`)
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
      const src = scoreSource(
        winnerProfile?.overridden ?? [],
        dim,
        val ?? null,
        winnerCompiled?.scores?.[dim],
        winnerCompiled?.dimensions[dim]?.sources,
      )
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
    for (const p of base.list())
      for (const d of CAPABILITY_DIMENSIONS) {
        const v = p.scores[d]
        if (v === null || (descriptor.policy.weights[d] ?? 0) === 0) continue
        for (const sign of [-1, 1]) {
          const nv = Math.min(1, Math.max(0, v + sign * delta))
          if (nv === v) continue
          const w = selectVirtualModel(
            withMatrixScore(effectiveInput, p.id, d, nv),
            descriptor,
            candidates,
          ).selected
          if (w?.profileId !== first.profileId)
            flips.push(`${p.id}.${d}${sign > 0 ? "+" : "-"}${delta} → ${w?.profileId}`)
        }
      }
    out.push(`  ±${delta} flips: ${flips.length === 0 ? "none" : flips.join("; ")}`)
  }
  const hidden: string[] = []
  for (const ranked of decision.ranked) {
    for (const dimension of ranked.unknownDimensions) {
      const flipped = selectVirtualModel(
        withMatrixScore(effectiveInput, ranked.profileId, dimension, 1),
        descriptor,
        candidates,
      ).selected
      if (flipped?.profileId !== first.profileId)
        hidden.push(`${ranked.profileId}.${dimension}=1 → ${flipped?.profileId}`)
    }
  }
  out.push(`  unknown-as-1.0 flips: ${hidden.length === 0 ? "none" : hidden.join("; ")}`, "")
}
process.stdout.write(`${out.join("\n")}\n`)
