import { createHash } from "node:crypto"
import type { CapabilityDimension } from "../schema"

/**
 * Capability Intelligence Pipeline types.
 *
 * **Off the inference request path.** Nothing in this module is called during `chooseModel()`,
 * `selectModel()`, or `selectAccounts()`.
 */

export interface SourceObservation {
  readonly source: string
  readonly sourceModelId: string
  readonly canonicalModelId: string | null
  readonly metric: string
  readonly rawValue: number
  readonly unit: string
  readonly benchmark: string
  readonly benchmarkVersion: string
  readonly fingerprint: string
  readonly observedAt: Date
  readonly ingestedAt: Date
  readonly sourceRef: string
  readonly provenance: Record<string, unknown>
}

export interface EvidenceFetchMetadata {
  readonly source: string
  readonly endpoint: string
  readonly tier: string | null
  readonly pagesFetched: number
  readonly recordsRetrieved: number
  readonly observationsEmitted: number
  readonly matchedModels: readonly string[]
  readonly unresolvedSourceModelIds: readonly string[]
  readonly rateLimit: {
    readonly limit: number | null
    readonly remaining: number | null
    readonly reset: string | null
  }
}

export interface EvidenceFetchResult {
  readonly observations: readonly SourceObservation[]
  readonly metadata: EvidenceFetchMetadata
}

export interface CapabilityEvidenceSource {
  readonly id: string
  fetch(): Promise<EvidenceFetchResult>
}

export interface CompiledDimensionEvidence {
  readonly dimension: CapabilityDimension
  readonly score: number | null
  readonly rawValue: number | null
  readonly unit: string | null
  readonly sources: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly benchmark: string | null
  readonly benchmarkVersion: string | null
  readonly observedAt: string | null
  readonly ingestedAt: string | null
  readonly stale: boolean
  readonly provenanceDigest: string
}

export interface CompiledModelIntelligence {
  readonly id: string
  readonly dimensions: Readonly<Record<CapabilityDimension, CompiledDimensionEvidence>>
  readonly scores: Readonly<Partial<Record<CapabilityDimension, number | null>>>
  readonly sources: readonly string[]
  readonly coverage: number
  readonly provenanceDigest: string
}

export interface CompiledCapabilitySnapshotPayload {
  readonly schemaVersion: 1
  readonly revision: string
  readonly generatedAt: string
  readonly compilerVersion: string
  readonly normalizerVersion: string
  readonly evidenceDigest: string
  readonly models: Readonly<Record<string, CompiledModelIntelligence>>
}

/**
 * Deterministic fingerprint for one upstream observation so repeated syncs over unchanged records
 * deduplicate (`ON CONFLICT (fingerprint) DO NOTHING`) while genuine metric/version updates append
 * as new historical rows.
 */
export function observationFingerprint(input: {
  readonly source: string
  readonly sourceModelId: string
  readonly metric: string
  readonly benchmark: string
  readonly benchmarkVersion: string
  readonly rawValue: number
  readonly unit: string
}): string {
  const canonical = JSON.stringify({
    source: input.source,
    sourceModelId: input.sourceModelId.trim().toLowerCase(),
    metric: input.metric,
    benchmark: input.benchmark,
    benchmarkVersion: input.benchmarkVersion,
    rawValue: Number(input.rawValue.toFixed(6)),
    unit: input.unit,
  })
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}
