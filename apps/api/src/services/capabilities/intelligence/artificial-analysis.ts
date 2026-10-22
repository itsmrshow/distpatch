import { z } from "zod"
import { redactValue } from "../../../logging/redact"
import { createExternalIdentityResolver, type ExternalIdentityResolver } from "./identity"
import {
  type CapabilityEvidenceSource,
  type EvidenceFetchResult,
  observationFingerprint,
  type SourceObservation,
} from "./types"

/**
 * Artificial Analysis external capability evidence adapter (`artificial-analysis`).
 *
 * **Off the inference request path.** Invoked only by manual sync (`bin/capabilities sync`) or
 * future background maintenance.
 *
 * Security invariants:
 * - Authenticates via `x-api-key`.
 * - Never logs, throws, or stores the API key or request headers in observations or error messages.
 * - All error messages pass through `redactValue(...)` before surfacing.
 */

export const ARTIFICIAL_ANALYSIS_SOURCE_ID = "artificial-analysis"
export const ARTIFICIAL_ANALYSIS_DEFAULT_BASE_URL = "https://artificialanalysis.ai"
export const ARTIFICIAL_ANALYSIS_FREE_PATH = "/api/v2/language/models/free"
export const ARTIFICIAL_ANALYSIS_PRO_PATH = "/api/v2/language/models"

export class ArtificialAnalysisError extends Error {
  readonly code:
    | "missing_api_key"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "http_error"
    | "invalid_json"
    | "invalid_schema"
  readonly status: number | null
  readonly retryAfterSeconds: number | null

  constructor(
    code: ArtificialAnalysisError["code"],
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(redactValue(message))
    this.name = "ArtificialAnalysisError"
    this.code = code
    this.status = options.status ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

const FiniteNullableNumber = z.number().nullable().optional()

const ModelCreatorSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  country: z.string().nullable().optional(),
})

const EvaluationsSchema = z.looseObject({
  artificial_analysis_intelligence_index: FiniteNullableNumber,
  artificial_analysis_coding_index: FiniteNullableNumber,
  artificial_analysis_agentic_index: FiniteNullableNumber,
  artificial_analysis_finance_and_accounting_index: FiniteNullableNumber,
  artificial_analysis_strategy_and_ops_index: FiniteNullableNumber,
  artificial_analysis_legal_index: FiniteNullableNumber,
  artificial_analysis_healthcare_and_medical_index: FiniteNullableNumber,
  artificial_analysis_engineering_index: FiniteNullableNumber,
  artificial_analysis_economics_index: FiniteNullableNumber,
  gpqa_diamond: FiniteNullableNumber,
  hle: FiniteNullableNumber,
  scicode: FiniteNullableNumber,
  aa_lcr: FiniteNullableNumber,
  ifbench: FiniteNullableNumber,
  mmmu_pro: FiniteNullableNumber,
  tau2_telecom: FiniteNullableNumber,
  tau_banking: FiniteNullableNumber,
  terminalbench_hard: FiniteNullableNumber,
  terminalbench_v2_1: FiniteNullableNumber,
  terminalbench_v4_0: FiniteNullableNumber,
})

const PricingSchema = z.looseObject({
  price_1m_input_tokens: FiniteNullableNumber,
  price_1m_output_tokens: FiniteNullableNumber,
  price_1m_cache_hit_tokens: FiniteNullableNumber,
  price_1m_cache_write_tokens: FiniteNullableNumber,
  price_1m_blended_3_to_1: FiniteNullableNumber,
})

const PerformanceSchema = z.looseObject({
  median_output_tokens_per_second: FiniteNullableNumber,
  median_time_to_first_token_seconds: FiniteNullableNumber,
  median_time_to_first_answer_token_seconds: FiniteNullableNumber,
  median_end_to_end_response_time_seconds: FiniteNullableNumber,
})

export const ArtificialAnalysisModelRecordSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  release_date: z.string().nullable().optional(),
  model_creator: ModelCreatorSchema.nullable().optional(),
  evaluations: EvaluationsSchema,
  pricing: PricingSchema.nullable().optional(),
  performance: PerformanceSchema.nullable().optional(),
  context_window_tokens: z.number().int().positive().nullable().optional(),
  openrouter_api_id: z.string().nullable().optional(),
  huggingface_url: z.string().nullable().optional(),
})

export type ArtificialAnalysisModelRecord = z.infer<typeof ArtificialAnalysisModelRecordSchema>

const PaginationSchema = z.looseObject({
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total_pages: z.number().int().nonnegative(),
  has_more: z.boolean(),
})

export const ArtificialAnalysisPageResponseSchema = z.looseObject({
  tier: z.string().min(1).optional(),
  intelligence_index_version: z.union([z.number(), z.string().min(1)]).optional(),
  pagination: PaginationSchema.optional(),
  data: z.array(ArtificialAnalysisModelRecordSchema),
})
export type ArtificialAnalysisPageResponse = z.infer<typeof ArtificialAnalysisPageResponseSchema>

interface MetricSpec {
  readonly metric: string
  readonly benchmark: string
  readonly unit: string
  readonly min: number
  readonly max: number
  readonly extract: (record: ArtificialAnalysisModelRecord) => number | null | undefined
  readonly versionedByIntelligenceIndex?: boolean
}

const METRIC_SPECS: readonly MetricSpec[] = [
  {
    metric: "intelligence_index",
    benchmark: "artificial_analysis_intelligence_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_intelligence_index,
    versionedByIntelligenceIndex: true,
  },
  {
    metric: "coding_index",
    benchmark: "artificial_analysis_coding_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_coding_index,
    versionedByIntelligenceIndex: true,
  },
  {
    metric: "agentic_index",
    benchmark: "artificial_analysis_agentic_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_agentic_index,
    versionedByIntelligenceIndex: true,
  },
  {
    metric: "finance_and_accounting_index",
    benchmark: "artificial_analysis_finance_and_accounting_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_finance_and_accounting_index,
  },
  {
    metric: "strategy_and_ops_index",
    benchmark: "artificial_analysis_strategy_and_ops_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_strategy_and_ops_index,
  },
  {
    metric: "legal_index",
    benchmark: "artificial_analysis_legal_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_legal_index,
  },
  {
    metric: "healthcare_and_medical_index",
    benchmark: "artificial_analysis_healthcare_and_medical_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_healthcare_and_medical_index,
  },
  {
    metric: "engineering_index",
    benchmark: "artificial_analysis_engineering_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_engineering_index,
  },
  {
    metric: "economics_index",
    benchmark: "artificial_analysis_economics_index",
    unit: "index_100",
    min: 0,
    max: 100,
    extract: (r) => r.evaluations.artificial_analysis_economics_index,
  },
  // Pro-tier standalone evaluations (recorded when present; absent on Free tier)
  {
    metric: "gpqa_diamond",
    benchmark: "gpqa_diamond",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.gpqa_diamond,
  },
  {
    metric: "hle",
    benchmark: "hle",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.hle,
  },
  {
    metric: "scicode",
    benchmark: "scicode",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.scicode,
  },
  {
    metric: "aa_lcr",
    benchmark: "aa_lcr",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.aa_lcr,
  },
  {
    metric: "ifbench",
    benchmark: "ifbench",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.ifbench,
  },
  {
    metric: "mmmu_pro",
    benchmark: "mmmu_pro",
    unit: "ratio_0_1",
    min: 0,
    max: 1,
    extract: (r) => r.evaluations.mmmu_pro,
  },
  // Performance metrics
  {
    metric: "median_output_tokens_per_second",
    benchmark: "artificial_analysis_performance",
    unit: "tokens_per_second",
    min: 0,
    max: 100_000,
    extract: (r) => r.performance?.median_output_tokens_per_second,
  },
  {
    metric: "median_time_to_first_token_seconds",
    benchmark: "artificial_analysis_performance",
    unit: "seconds",
    min: 0,
    max: 3_600,
    extract: (r) => r.performance?.median_time_to_first_token_seconds,
  },
  {
    metric: "median_time_to_first_answer_token_seconds",
    benchmark: "artificial_analysis_performance",
    unit: "seconds",
    min: 0,
    max: 3_600,
    extract: (r) => r.performance?.median_time_to_first_answer_token_seconds,
  },
  {
    metric: "median_end_to_end_response_time_seconds",
    benchmark: "artificial_analysis_performance",
    unit: "seconds",
    min: 0,
    max: 3_600,
    extract: (r) => r.performance?.median_end_to_end_response_time_seconds,
  },
  // Pricing observations (stored as evidence; not converted into a provider-independent semantic score)
  {
    metric: "price_1m_input_tokens",
    benchmark: "artificial_analysis_pricing",
    unit: "usd_per_1m_tokens",
    min: 0,
    max: 100_000,
    extract: (r) => r.pricing?.price_1m_input_tokens,
  },
  {
    metric: "price_1m_output_tokens",
    benchmark: "artificial_analysis_pricing",
    unit: "usd_per_1m_tokens",
    min: 0,
    max: 100_000,
    extract: (r) => r.pricing?.price_1m_output_tokens,
  },
  {
    metric: "price_1m_cache_hit_tokens",
    benchmark: "artificial_analysis_pricing",
    unit: "usd_per_1m_tokens",
    min: 0,
    max: 100_000,
    extract: (r) => r.pricing?.price_1m_cache_hit_tokens,
  },
  {
    metric: "price_1m_cache_write_tokens",
    benchmark: "artificial_analysis_pricing",
    unit: "usd_per_1m_tokens",
    min: 0,
    max: 100_000,
    extract: (r) => r.pricing?.price_1m_cache_write_tokens,
  },
]

export interface ArtificialAnalysisSourceOptions {
  /** API key (`AA_API_KEY` or `ARTIFICIAL_ANALYSIS_API_KEY`). Never logged or stored. */
  readonly apiKey?: string | null
  readonly baseUrl?: string
  /** Optional explicit endpoint path; defaults to auto-detecting `/api/v2/language/models` then `/api/v2/language/models/free` on 403. */
  readonly endpointPath?: string
  readonly fetchImpl?: typeof fetch
  readonly identityResolver?: ExternalIdentityResolver
  readonly now?: () => Date
  readonly maxPages?: number
  readonly timeoutMs?: number
}

/**
 * Resolves the Artificial Analysis API key from explicit options or `process.env` (`AA_API_KEY`
 * first, then `ARTIFICIAL_ANALYSIS_API_KEY`). Never logs or returns the key in errors.
 */
export function resolveArtificialAnalysisApiKey(
  env: Record<string, string | undefined> = process.env,
  explicitKey?: string | null,
): string | null {
  const candidate = explicitKey ?? env.AA_API_KEY ?? env.ARTIFICIAL_ANALYSIS_API_KEY ?? null
  if (candidate === null) return null
  const trimmed = candidate.trim()
  return trimmed.length > 0 ? trimmed : null
}

function safeSourceUrl(slug: string): string {
  const sanitized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
  return `https://artificialanalysis.ai/models/${sanitized || "unknown"}`
}

function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Parses and converts a validated Artificial Analysis page payload into Distpatch
 * `SourceObservation[]`. Exported for deterministic unit testing over fixture payloads.
 */
export function parseArtificialAnalysisPayload(
  rawPayload: unknown,
  options: {
    readonly identityResolver?: ExternalIdentityResolver
    readonly ingestedAt?: Date
    readonly observedAt?: Date
  } = {},
): {
  readonly page: ArtificialAnalysisPageResponse
  readonly observations: readonly SourceObservation[]
  readonly matchedCanonicalIds: readonly string[]
  readonly unresolvedSourceModelIds: readonly string[]
} {
  const parsed = ArtificialAnalysisPageResponseSchema.safeParse(rawPayload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue ? issue.path.join(".") || "(root)" : "(root)"
    throw new ArtificialAnalysisError(
      "invalid_schema",
      `Artificial Analysis payload failed schema validation at ${where}: ${issue?.message ?? "invalid payload"}`,
    )
  }

  const page = parsed.data
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const ingestedAt = options.ingestedAt ?? new Date()
  // Artificial Analysis publishes continuously maintained indexes with no per-measurement timestamp,
  // so an observation is dated when it was fetched; `release_date` is model metadata, not evidence age.
  const observedAt = options.observedAt ?? ingestedAt
  const indexVersion =
    page.intelligence_index_version !== undefined
      ? String(page.intelligence_index_version)
      : "unversioned"
  const tier = page.tier ?? null

  const observations: SourceObservation[] = []
  const matchedSet = new Set<string>()
  const unresolvedSet = new Set<string>()
  const seenFingerprints = new Set<string>()

  for (const record of page.data) {
    const slug = record.slug.trim()
    const candidates = [
      slug,
      ...(record.openrouter_api_id ? [record.openrouter_api_id] : []),
      record.id,
    ]
    const canonicalModelId = resolver.resolve(ARTIFICIAL_ANALYSIS_SOURCE_ID, candidates)
    if (canonicalModelId !== null) {
      matchedSet.add(canonicalModelId)
    } else {
      unresolvedSet.add(slug)
    }

    const sourceRef = safeSourceUrl(slug)
    const provenance: Record<string, unknown> = {
      aaModelId: record.id,
      slug,
      name: record.name,
      creatorId: record.model_creator?.id ?? null,
      creatorName: record.model_creator?.name ?? null,
      releaseDate: record.release_date ?? null,
      tier,
      intelligenceIndexVersion: indexVersion,
      ...(record.openrouter_api_id ? { openrouterApiId: record.openrouter_api_id } : {}),
    }

    for (const spec of METRIC_SPECS) {
      const val = spec.extract(record)
      if (val === null || val === undefined) continue
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new ArtificialAnalysisError(
          "invalid_schema",
          `Artificial Analysis model ${slug} metric ${spec.metric} has non-finite value`,
        )
      }
      if (val < spec.min || val > spec.max) {
        throw new ArtificialAnalysisError(
          "invalid_schema",
          `Artificial Analysis model ${slug} metric ${spec.metric} value ${val} is outside [${spec.min}, ${spec.max}]`,
        )
      }

      const benchmarkVersion = spec.versionedByIntelligenceIndex ? indexVersion : "v2"
      const fingerprint = observationFingerprint({
        source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
        sourceModelId: slug,
        metric: spec.metric,
        benchmark: spec.benchmark,
        benchmarkVersion,
        rawValue: val,
        unit: spec.unit,
      })
      if (seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)

      observations.push({
        source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
        sourceModelId: slug,
        canonicalModelId,
        metric: spec.metric,
        rawValue: val,
        unit: spec.unit,
        benchmark: spec.benchmark,
        benchmarkVersion,
        fingerprint,
        observedAt,
        ingestedAt,
        sourceRef,
        provenance,
      })
    }
  }

  return {
    page,
    observations,
    matchedCanonicalIds: [...matchedSet].sort(),
    unresolvedSourceModelIds: [...unresolvedSet].sort(),
  }
}

export function createArtificialAnalysisSource(
  options: ArtificialAnalysisSourceOptions = {},
): CapabilityEvidenceSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const now = options.now ?? (() => new Date())
  const baseUrl = (options.baseUrl ?? ARTIFICIAL_ANALYSIS_DEFAULT_BASE_URL).replace(/\/$/, "")
  const maxPages = options.maxPages ?? 20
  const timeoutMs = options.timeoutMs ?? 30_000

  const fetchPage = async (
    path: string,
    pageNumber: number,
    apiKey: string,
  ): Promise<{
    readonly status: number
    readonly headers: Headers
    readonly bodyText: string
  }> => {
    const url = `${baseUrl}${path}${path.includes("?") ? "&" : "?"}page=${pageNumber}`
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const bodyText = await response.text()
      return { status: response.status, headers: response.headers, bodyText }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ArtificialAnalysisError(
        "http_error",
        `Artificial Analysis request to ${path} failed: ${reason}`,
      )
    }
  }

  return {
    id: ARTIFICIAL_ANALYSIS_SOURCE_ID,
    fetch: async (): Promise<EvidenceFetchResult> => {
      const apiKey = resolveArtificialAnalysisApiKey(process.env, options.apiKey)
      if (!apiKey) {
        throw new ArtificialAnalysisError(
          "missing_api_key",
          "Artificial Analysis API key is not configured (expected AA_API_KEY or ARTIFICIAL_ANALYSIS_API_KEY)",
        )
      }

      const ingestedAt = now()
      let chosenPath = options.endpointPath ?? ARTIFICIAL_ANALYSIS_PRO_PATH

      let firstRes = await fetchPage(chosenPath, 1, apiKey)
      if (firstRes.status === 403 && options.endpointPath === undefined) {
        // Free-tier keys receive 403 on `/api/v2/language/models`; fall back cleanly to `/free`.
        chosenPath = ARTIFICIAL_ANALYSIS_FREE_PATH
        firstRes = await fetchPage(chosenPath, 1, apiKey)
      }

      const checkStatus = (res: { status: number; headers: Headers; bodyText: string }) => {
        if (res.status >= 200 && res.status < 300) return
        const retryAfter = parseHeaderInt(res.headers, "retry-after")
        if (res.status === 401) {
          throw new ArtificialAnalysisError(
            "unauthorized",
            "Artificial Analysis rejected the API key (HTTP 401)",
            { status: 401 },
          )
        }
        if (res.status === 403) {
          throw new ArtificialAnalysisError(
            "forbidden",
            `Artificial Analysis refused access to ${chosenPath} (HTTP 403)`,
            { status: 403 },
          )
        }
        if (res.status === 429) {
          throw new ArtificialAnalysisError(
            "rate_limited",
            `Artificial Analysis rate limit exceeded (HTTP 429${retryAfter !== null ? `, retry after ${retryAfter}s` : ""})`,
            { status: 429, retryAfterSeconds: retryAfter },
          )
        }
        throw new ArtificialAnalysisError(
          "http_error",
          `Artificial Analysis answered HTTP ${res.status} on ${chosenPath}`,
          { status: res.status },
        )
      }

      checkStatus(firstRes)

      const parseJson = (text: string): unknown => {
        try {
          return JSON.parse(text)
        } catch {
          throw new ArtificialAnalysisError(
            "invalid_json",
            `Artificial Analysis returned invalid JSON on ${chosenPath}`,
          )
        }
      }

      const allObservations: SourceObservation[] = []
      const seenFingerprints = new Set<string>()
      const seenRecordIds = new Set<string>()
      const matchedSet = new Set<string>()
      const unresolvedSet = new Set<string>()

      let pagesFetched = 0
      let recordsRetrieved = 0
      let detectedTier: string | null = firstRes.headers.get("x-aa-tier")
      let lastHeaders = firstRes.headers

      const processPageResponse = (res: { status: number; headers: Headers; bodyText: string }) => {
        checkStatus(res)
        lastHeaders = res.headers
        const raw = parseJson(res.bodyText)
        const parsedPage = parseArtificialAnalysisPayload(raw, {
          identityResolver: resolver,
          ingestedAt,
          observedAt: ingestedAt,
        })
        pagesFetched += 1
        if (parsedPage.page.tier) {
          detectedTier = parsedPage.page.tier
        }
        for (const rec of parsedPage.page.data) {
          if (!seenRecordIds.has(rec.id)) {
            seenRecordIds.add(rec.id)
            recordsRetrieved += 1
          }
        }
        for (const id of parsedPage.matchedCanonicalIds) matchedSet.add(id)
        for (const slug of parsedPage.unresolvedSourceModelIds) unresolvedSet.add(slug)
        for (const obs of parsedPage.observations) {
          if (seenFingerprints.has(obs.fingerprint)) continue
          seenFingerprints.add(obs.fingerprint)
          allObservations.push(obs)
        }
        return parsedPage.page
      }

      let currentPage = processPageResponse(firstRes)
      let nextPageNumber = 2
      let pagesRemaining = 0
      while (
        currentPage.pagination?.has_more === true &&
        nextPageNumber <= (currentPage.pagination.total_pages || maxPages) &&
        pagesFetched < maxPages
      ) {
        const nextRes = await fetchPage(chosenPath, nextPageNumber, apiKey)
        currentPage = processPageResponse(nextRes)
        nextPageNumber += 1
      }

      // Incomplete pagination is a failed fetch, not a partial success: publishing a snapshot
      // compiled from this partial feed plus retained historical rows would look like an ordinary
      // successful ingestion in the metadata while silently mixing old and current evidence.
      if (currentPage.pagination?.has_more === true) {
        pagesRemaining =
          (currentPage.pagination.total_pages || 0) >= nextPageNumber
            ? (currentPage.pagination.total_pages ?? 0) - (nextPageNumber - 1)
            : 1
        throw new ArtificialAnalysisError(
          "http_error",
          `Artificial Analysis pagination incomplete after ${maxPages} pages (${pagesRemaining} page(s) remain); increase maxPages or raise the API tier`,
        )
      }

      return {
        observations: allObservations,
        metadata: {
          source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
          endpoint: `${baseUrl}${chosenPath}`,
          tier: detectedTier,
          pagesFetched,
          recordsRetrieved,
          observationsEmitted: allObservations.length,
          matchedModels: [...matchedSet].sort(),
          unresolvedSourceModelIds: [...unresolvedSet].sort(),
          rateLimit: {
            limit: parseHeaderInt(lastHeaders, "x-ratelimit-limit"),
            remaining: parseHeaderInt(lastHeaders, "x-ratelimit-remaining"),
            reset: lastHeaders.get("x-ratelimit-reset"),
          },
        },
      }
    },
  }
}
