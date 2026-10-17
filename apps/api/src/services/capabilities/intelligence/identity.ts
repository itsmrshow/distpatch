import { CanonicalModelId } from "../schema"
import { SHIPPED_CAPABILITY_CATALOG } from "../shipped"

/**
 * Explicit external-source → Distpatch canonical model identity mapping.
 *
 * Rules:
 * - Distpatch canonical IDs remain `vendor/model`.
 * - Exact lookup only (after trimming and lowercasing).
 * - No Levenshtein distance, no substring matching, no regex family guessing.
 * - Unmapped external models stay `null` (unresolved) in `capability_observations` and never enter
 *   compiled snapshots.
 * - Several external slugs for the same semantic model (for example reasoning/non-reasoning or
 *   provider-hosted variants only when explicitly designated as the canonical release) map only
 *   through this explicit table.
 * - Provider/account wire routing remains completely separate (`routing/model.ts`).
 */

export interface ExternalModelIdentityEntry {
  readonly source: string
  readonly externalId: string
  readonly canonicalId: CanonicalModelId
  readonly note?: string
}

/**
 * Versioned explicit identity mappings per evidence source.
 *
 * For Artificial Analysis, `externalId` matches the exact model `slug` (or `id` / `openrouter_api_id`
 * when explicitly listed here).
 */
export const EXPLICIT_EXTERNAL_MODEL_MAPPINGS: readonly ExternalModelIdentityEntry[] = [
  // Anthropic Claude Sonnet 4.6
  // Artificial Analysis publishes `claude-sonnet-4-6-adaptive` ("Claude Sonnet 4.6 (Max)") as the
  // full flagship profile carrying `intelligence_index`, `coding_index`, and `agentic_index`, while
  // `claude-sonnet-4-6` ("Claude Sonnet 4.6 (Non-reasoning, High)") omits `coding_index` and `agentic_index`.
  {
    source: "artificial-analysis",
    externalId: "claude-sonnet-4-6-adaptive",
    canonicalId: "anthropic/claude-sonnet-4-6",
    note: "Anthropic Claude Sonnet 4.6 flagship AA slug (Intelligence, Coding, Agentic indexes)",
  },
  {
    source: "artificial-analysis",
    externalId: "claude-sonnet-4-6",
    canonicalId: "anthropic/claude-sonnet-4-6",
    note: "Anthropic Claude Sonnet 4.6 non-reasoning AA slug",
  },
  {
    source: "artificial-analysis",
    externalId: "claude-4-6-sonnet",
    canonicalId: "anthropic/claude-sonnet-4-6",
    note: "Anthropic Claude Sonnet 4.6 alternate AA slug",
  },
  {
    source: "artificial-analysis",
    externalId: "anthropic/claude-sonnet-4-6",
    canonicalId: "anthropic/claude-sonnet-4-6",
    note: "Anthropic Claude Sonnet 4.6 canonical/OpenRouter identifier",
  },
  {
    source: "artificial-analysis",
    externalId: "anthropic/claude-sonnet-4.6",
    canonicalId: "anthropic/claude-sonnet-4-6",
    note: "Anthropic Claude Sonnet 4.6 dotted OpenRouter identifier",
  },

  // OpenAI GPT-5.5
  {
    source: "artificial-analysis",
    externalId: "gpt-5-5",
    canonicalId: "openai/gpt-5.5",
    note: "OpenAI GPT-5.5 primary AA slug",
  },
  {
    source: "artificial-analysis",
    externalId: "gpt-5.5",
    canonicalId: "openai/gpt-5.5",
    note: "OpenAI GPT-5.5 dotted slug",
  },
  {
    source: "artificial-analysis",
    externalId: "openai/gpt-5.5",
    canonicalId: "openai/gpt-5.5",
    note: "OpenAI GPT-5.5 canonical/OpenRouter identifier",
  },
  {
    source: "artificial-analysis",
    externalId: "openai/gpt-5-5",
    canonicalId: "openai/gpt-5.5",
    note: "OpenAI GPT-5.5 hyphenated identifier",
  },

  // OpenAI gpt-oss-120b
  {
    source: "artificial-analysis",
    externalId: "gpt-oss-120b",
    canonicalId: "openai/gpt-oss-120b",
    note: "OpenAI gpt-oss-120b primary AA slug",
  },
  {
    source: "artificial-analysis",
    externalId: "openai/gpt-oss-120b",
    canonicalId: "openai/gpt-oss-120b",
    note: "OpenAI gpt-oss-120b canonical/OpenRouter identifier",
  },

  // Xiaomi MiMo V2.6 Distill 9B
  {
    source: "artificial-analysis",
    externalId: "mimo-v2-6-distill-9b",
    canonicalId: "mimo/mimo-v2.6-distill-9b",
    note: "MiMo V2.6 Distill 9B AA slug",
  },
  {
    source: "artificial-analysis",
    externalId: "mimo-v2.6-distill-9b",
    canonicalId: "mimo/mimo-v2.6-distill-9b",
    note: "MiMo V2.6 Distill 9B dotted slug",
  },
  {
    source: "artificial-analysis",
    externalId: "mimo/mimo-v2.6-distill-9b",
    canonicalId: "mimo/mimo-v2.6-distill-9b",
    note: "MiMo V2.6 Distill 9B canonical identifier",
  },

  // Distpatch Local Evaluation Framework (already emits canonical model IDs)
  {
    source: "distpatch-local-eval",
    externalId: "anthropic/claude-sonnet-4-6",
    canonicalId: "anthropic/claude-sonnet-4-6",
  },
  {
    source: "distpatch-local-eval",
    externalId: "openai/gpt-5.5",
    canonicalId: "openai/gpt-5.5",
  },
  {
    source: "distpatch-local-eval",
    externalId: "openai/gpt-oss-120b",
    canonicalId: "openai/gpt-oss-120b",
  },
  {
    source: "distpatch-local-eval",
    externalId: "mimo/mimo-v2.6-distill-9b",
    canonicalId: "mimo/mimo-v2.6-distill-9b",
  },
] as const

export interface ExternalIdentityResolver {
  /**
   * Resolve one external model identifier (or candidate list of exact identifiers from one record,
   * such as `[record.slug, record.openrouter_api_id, record.id]`) to a Distpatch canonical model id,
   * or `null` when unmapped. Never guesses by substring or edit distance.
   */
  resolve(
    source: string,
    externalIdOrCandidates: string | readonly string[],
  ): CanonicalModelId | null
  entries(): readonly ExternalModelIdentityEntry[]
}

export function createExternalIdentityResolver(
  customEntries: readonly ExternalModelIdentityEntry[] = EXPLICIT_EXTERNAL_MODEL_MAPPINGS,
): ExternalIdentityResolver {
  const bySourceAndExternal = new Map<string, CanonicalModelId>()
  const shippedCanonicalIds = new Set(SHIPPED_CAPABILITY_CATALOG.profiles.map((p) => p.id))

  for (const entry of customEntries) {
    const parsedCanonical = CanonicalModelId.parse(entry.canonicalId)
    const key = `${entry.source.trim().toLowerCase()}::${entry.externalId.trim().toLowerCase()}`
    const existing = bySourceAndExternal.get(key)
    if (existing !== undefined && existing !== parsedCanonical) {
      throw new Error(
        `Conflicting external identity mapping for ${key}: ${existing} vs ${parsedCanonical}`,
      )
    }
    bySourceAndExternal.set(key, parsedCanonical)
  }

  // Also allow exact canonical IDs of shipped profiles when an external source already reports them
  // verbatim as `vendor/model`.
  const resolveSingle = (source: string, rawId: string): CanonicalModelId | null => {
    const normalizedSource = source.trim().toLowerCase()
    const normalizedId = rawId.trim().toLowerCase()
    if (!normalizedSource || !normalizedId) return null
    const mapped = bySourceAndExternal.get(`${normalizedSource}::${normalizedId}`)
    if (mapped !== undefined) return mapped
    if (shippedCanonicalIds.has(normalizedId)) return normalizedId
    return null
  }

  return {
    resolve: (source, externalIdOrCandidates) => {
      const candidates =
        typeof externalIdOrCandidates === "string"
          ? [externalIdOrCandidates]
          : externalIdOrCandidates
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue
        const resolved = resolveSingle(source, candidate)
        if (resolved !== null) return resolved
      }
      return null
    },
    entries: () => customEntries,
  }
}
