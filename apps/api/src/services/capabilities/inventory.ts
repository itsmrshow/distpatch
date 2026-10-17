import { z } from "zod"
import { CanonicalModelId } from "./schema"

/**
 * Schema of the flat, normalized route-inventory **document**
 * (`evidence/model-inventory/dockerlm.json`) and the canonical-id normalization shared with route
 * discovery.
 *
 * That document is a fixture / evidence example only. The operational source is live discovery
 * (`GET /v1/models` → `intelligence/llamaswap-discovery.ts` → provider-neutral
 * `RouteModelDescriptor`, `intelligence/route-discovery.ts`); nobody copies this file anywhere.
 * Tests hold the document and the discovery fixture consistent. Nothing on the inference request
 * path reads either.
 *
 * Hugging Face casing is provenance: the canonical Distpatch id is the same repository id,
 * lowercased.
 */

const repoId = z.string().min(3)
const httpsUrl = z.string().regex(/^https:\/\/\S+$/, "must be an https URL")

export const RouteInventoryEntry = z.strictObject({
  exposed_model: z.string().min(1),
  semantic_model: repoId,
  base_model: repoId,
  derivative_model: z.string().min(1).nullable(),
  artifact_repo: repoId,
  artifact_files: z.array(z.string().min(1)).min(1),
  artifact_format: z.string().min(1),
  quantization: z.string().min(1),
  runtime: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  capabilities: z.strictObject({
    context_tokens: z.number().int().positive(),
    text_input: z.boolean(),
    text_output: z.boolean(),
    image_input: z.boolean(),
    embedding: z.boolean(),
  }),
  provenance: z.strictObject({
    resolution_method: z.string().min(1),
    semantic_model_source: httpsUrl,
    artifact_source: httpsUrl,
    confidence: z.enum(["verified", "inferred"]),
  }),
})
export type RouteInventoryEntry = z.infer<typeof RouteInventoryEntry>

export const RouteInventory = z
  .array(RouteInventoryEntry)
  .refine(
    (entries) => new Set(entries.map((e) => e.exposed_model)).size === entries.length,
    "exposed_model must be unique within an inventory",
  )

/** Lowercase `vendor/model`; HF repository casing is kept only in provenance URLs. */
export function canonicalIdFromRepo(repo: string): CanonicalModelId {
  return CanonicalModelId.parse(repo.trim().toLowerCase())
}
