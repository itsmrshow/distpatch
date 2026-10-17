import { z } from "zod"
import { canonicalIdFromRepo } from "../inventory"
import type { CanonicalModelId } from "../schema"
import type {
  RejectedRouteModel,
  RouteDiscoveryResult,
  RouteModelDescriptor,
  RouteModelSource,
} from "./route-discovery"

/**
 * DockerLM / llama-swap route-model discovery adapter.
 *
 * Reads the host's own OpenAI-compatible `GET {base}/models` (base conventionally ends in `/v1`,
 * as `DOCKERLM_BASE_URL` does). Each entry may carry the host's already-resolved, normalized
 * metadata under `meta.llamaswap`:
 *
 *   model_identity      `semantic_model`, `base_model`, `derivative_model`
 *   artifact            repository, files, format, quantization
 *   runtime             name, version
 *   model_capabilities  context_tokens, text_input, text_output, image_input, embedding
 *   routing             model_type, endpoint
 *   provenance          semantic_model_source, artifact_source, resolution_method, confidence
 *
 * The host did the identity work (and states its provenance), so this adapter never scrapes
 * filesystems, never connects over SSH and never queries Hugging Face: it validates and maps.
 *
 * Trust rules, all fail-safe:
 * - an entry **without** `meta.llamaswap` is kept as an *unresolved* route (no semantic id);
 * - an entry whose metadata is present but malformed is **rejected** (skipped, last-known-good
 *   kept by reconciliation);
 * - a semantic id is used only when it is a valid `vendor/model` repository id **and**
 *   `provenance.confidence` is `verified`; it is lowercased to the canonical form (HF casing is
 *   provenance), and anything else leaves the route unresolved;
 * - a listing that is unreadable, or lists nothing, rejects the whole discovery (an outage must
 *   not look like "every model was removed").
 *
 * Off the inference request path: only `bin/capabilities sync` constructs and calls this.
 */

export const DOCKERLM_SOURCE_ID = "dockerlm"

export class RouteDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RouteDiscoveryError"
  }
}

const str = z.string().optional()
const flag = z.boolean().nullable().optional()

const llamaSwapMeta = z.looseObject({
  model_identity: z.looseObject({
    semantic_model: z.string().min(1),
    base_model: z.string().nullable().optional(),
    derivative_model: z.string().nullable().optional(),
  }),
  artifact: z
    .looseObject({
      repository: str,
      repo: str,
      files: z.array(z.string()).optional(),
      format: str,
      quantization: str,
    })
    .optional(),
  runtime: z.looseObject({ name: str, version: str }).optional(),
  model_capabilities: z
    .looseObject({
      context_tokens: z.number().int().positive().nullable().optional(),
      text_input: flag,
      text_output: flag,
      image_input: flag,
      embedding: flag,
    })
    .optional(),
  routing: z.looseObject({ model_type: str, endpoint: str }).optional(),
  provenance: z
    .looseObject({
      semantic_model_source: str,
      artifact_source: str,
      resolution_method: str,
      confidence: str,
    })
    .optional(),
})

const listing = z.looseObject({ data: z.array(z.unknown()) })

function canonicalOrNull(repo: string | null | undefined): CanonicalModelId | null {
  if (repo === null || repo === undefined) return null
  try {
    return canonicalIdFromRepo(repo)
  } catch {
    return null
  }
}

const describe = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")

/** Pure: the OpenAI-compatible list → descriptors plus the entries that were refused. */
export function parseLlamaSwapModelList(payload: unknown): RouteDiscoveryResult {
  const parsed = listing.safeParse(payload)
  if (!parsed.success) {
    throw new RouteDiscoveryError('model listing is not an object with a "data" array')
  }
  if (parsed.data.data.length === 0) {
    throw new RouteDiscoveryError("model listing is empty; refusing to treat it as removal")
  }

  const descriptors: RouteModelDescriptor[] = []
  const rejected: RejectedRouteModel[] = []
  const seen = new Set<string>()

  for (const entry of parsed.data.data) {
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >
    const id = typeof record.id === "string" ? record.id.trim() : ""
    if (id === "") {
      rejected.push({ routeModelId: null, reason: 'entry has no string "id"' })
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)

    const raw = (record.meta as { llamaswap?: unknown } | null | undefined)?.llamaswap
    if (raw === undefined || raw === null) {
      descriptors.push({
        routeModelId: id,
        semanticModelId: null,
        baseModelId: null,
        derivativeModelId: null,
        capabilities: {},
      })
      continue
    }
    const meta = llamaSwapMeta.safeParse(raw)
    if (!meta.success) {
      rejected.push({ routeModelId: id, reason: `meta.llamaswap invalid: ${describe(meta.error)}` })
      continue
    }
    const m = meta.data
    const semantic = canonicalOrNull(m.model_identity.semantic_model)
    if (semantic === null) {
      rejected.push({
        routeModelId: id,
        reason: "meta.llamaswap.model_identity.semantic_model is not a vendor/model repository id",
      })
      continue
    }
    const verified = m.provenance?.confidence === "verified"
    const base = canonicalOrNull(m.model_identity.base_model)
    const derivative = canonicalOrNull(m.model_identity.derivative_model?.split(" (")[0])
    const cap = m.model_capabilities ?? {}
    const artifact = {
      repository: m.artifact?.repository ?? m.artifact?.repo,
      files: m.artifact?.files,
      format: m.artifact?.format,
      quantization: m.artifact?.quantization,
    }

    descriptors.push({
      routeModelId: id,
      // Unverified identity is not identity: the route stays, unresolved.
      semanticModelId: verified ? semantic : null,
      baseModelId: verified ? base : null,
      derivativeModelId: verified ? derivative : null,
      artifact: stripUndefined(artifact),
      runtime: stripUndefined({ name: m.runtime?.name, version: m.runtime?.version }),
      capabilities: {
        textInput: cap.text_input ?? null,
        textOutput: cap.text_output ?? null,
        imageInput: cap.image_input ?? null,
        embedding: cap.embedding ?? null,
        contextTokens: cap.context_tokens ?? null,
      },
      routing: stripUndefined({ modelType: m.routing?.model_type, endpoint: m.routing?.endpoint }),
      provenance: stripUndefined({
        semanticModelSource: m.provenance?.semantic_model_source,
        artifactSource: m.provenance?.artifact_source,
        resolutionMethod: m.provenance?.resolution_method,
        confidence: m.provenance?.confidence,
      }),
    })
  }

  return {
    descriptors: descriptors.sort((a, b) => (a.routeModelId < b.routeModelId ? -1 : 1)),
    rejected,
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export interface LlamaSwapDiscoveryOptions {
  /** The OpenAI-compatible base, e.g. `http://host:8000/v1` (`DOCKERLM_BASE_URL`). */
  readonly baseUrl: string
  readonly id?: string
  /** Semantic tags this host contributes. A local host is `["local"]`. */
  readonly tags?: readonly string[]
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export function createLlamaSwapDiscoverySource(
  options: LlamaSwapDiscoveryOptions,
): RouteModelSource {
  const doFetch = options.fetch ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`
  return {
    id: options.id ?? DOCKERLM_SOURCE_ID,
    tags: options.tags ?? ["local"],
    discover: async () => {
      let response: Response
      try {
        response = await doFetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
      } catch (error) {
        // The URL is the operator's LAN address: report the failure class, never the address.
        throw new RouteDiscoveryError(
          `route discovery request failed (${error instanceof Error ? error.name : "error"})`,
        )
      }
      if (!response.ok) {
        throw new RouteDiscoveryError(`route discovery answered HTTP ${response.status}`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new RouteDiscoveryError("route discovery answer is not JSON")
      }
      return parseLlamaSwapModelList(body)
    },
  }
}
