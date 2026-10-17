import { z } from "zod"
import { CanonicalModelId } from "./schema"

/**
 * The normalized route inventory contract: one provider-neutral way for any source (a local
 * OpenAI-compatible host, MLX, llama.cpp, Ollama, OpenRouter, NVIDIA, …) to say *what a route
 * serves*, in separate layers that must never be conflated:
 *
 *   semantic identity   `semantic_model`   what model this is            → capability catalog
 *   lineage             `base_model`       what it was derived from      → catalog `baseModel`
 *                       `derivative_model` set only for a true derivative
 *   artifact identity   `artifact_*`, `quantization`   which weights file → route/artifact layer
 *   runtime identity    `runtime`          which engine runs it          → route/artifact layer
 *   route identity      `exposed_model`    the name clients call         → catalog alias / provider
 *   capabilities        `capabilities`     what the route exposes        → evidence, not the profile
 *   provenance          `provenance`       how each claim was verified   → evidence
 *
 * Quantizing or serving a model through a different runtime does not make a new semantic model; a
 * fine-tune or abliteration does. Hugging Face casing is provenance: the canonical Distpatch id is
 * the same repository id, lowercased.
 *
 * Development/catalog evidence only. Nothing on the inference request path reads an inventory; the
 * shipped catalog is the only runtime artifact, and tests hold the two consistent.
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

/** The layers of one inventory entry, resolved to Distpatch canonical ids. */
export interface ResolvedRouteInventoryEntry {
  readonly route: string
  readonly semanticId: CanonicalModelId
  readonly baseModelId: CanonicalModelId | null
  /** True lineage only: the semantic model differs from its base. */
  readonly derivative: boolean
  readonly generative: boolean
  readonly artifact: {
    readonly repo: string
    readonly files: readonly string[]
    readonly format: string
    readonly quantization: string
  }
  readonly runtime: { readonly name: string; readonly version: string }
}

export function resolveRouteInventoryEntry(
  entry: RouteInventoryEntry,
): ResolvedRouteInventoryEntry {
  const semanticId = canonicalIdFromRepo(entry.semantic_model)
  const baseId = canonicalIdFromRepo(entry.base_model)
  const derivative = baseId !== semanticId
  return {
    route: entry.exposed_model,
    semanticId,
    baseModelId: derivative ? baseId : null,
    derivative,
    generative: entry.capabilities.text_output && !entry.capabilities.embedding,
    artifact: {
      repo: entry.artifact_repo,
      files: entry.artifact_files,
      format: entry.artifact_format,
      quantization: entry.quantization,
    },
    runtime: entry.runtime,
  }
}
