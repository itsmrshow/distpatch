import { z } from "zod"

const repoId = z.string().min(3)
const httpsUrl = z.string().regex(/^https:\/\/\S+$/, "must be an https URL")

/** Schema for the checked-in flat DockerLM inventory evidence fixture; production uses live discovery. */
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
    (entries) => new Set(entries.map((entry) => entry.exposed_model)).size === entries.length,
    "exposed_model must be unique within an inventory",
  )
