import { readFile } from "node:fs/promises"
import {
  createCapabilityIntelligenceRepository,
  createCapabilitySyncLockPool,
  createDatabase,
  runMigrations,
} from "@multi-ai-router/db"
import { redactValue } from "../logging/redact"
import {
  ARTIFICIAL_ANALYSIS_SOURCE_ID,
  applyPublishedSnapshotToBootstrap,
  type CapabilityEvidenceSource,
  compileAndPublishCapabilitySnapshot,
  createArtificialAnalysisSource,
  createExternalIdentityResolver,
  createLlamaSwapDiscoverySource,
  createLocalEvaluationSource,
  LOCAL_EVAL_SOURCE_ID,
  parseArtificialAnalysisPayload,
  type RouteModelSource,
  readCapabilityOverridesFile,
  SHIPPED_CAPABILITY_CATALOG,
  syncCapabilityIntelligence,
} from "../services/capabilities"

/**
 * `bin/capabilities` — Capability Intelligence Pipeline manual CLI.
 *
 *   bin/capabilities sync [--fixture <path>] [--no-local-eval] [--route-fixture <path>] [--no-route-discovery]
 *   bin/capabilities compile
 *   bin/capabilities status
 *   bin/capabilities show
 *
 * Off the inference request path. Connects to `DATABASE_URL`, runs idempotent migrations, and
 * manages capability observations and published snapshots. Never prints or logs API keys.
 */

const USAGE = `usage:
  bin/capabilities sync [--fixture <path>] [--no-local-eval] [--route-fixture <path>] [--no-route-discovery]
  bin/capabilities compile
  bin/capabilities status
  bin/capabilities show`

function fail(message: string, code = 1): never {
  process.stderr.write(`${redactValue(message)}\n`)
  process.exit(code)
}

function databaseUrl(): string {
  const url = (process.env.DATABASE_URL ?? "").trim()
  if (url === "") {
    fail(
      "DATABASE_URL is not set — set it in .env or the environment before running bin/capabilities",
    )
  }
  return url
}

function flagValue(args: readonly string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

function createFixtureArtificialAnalysisSource(fixturePath: string): CapabilityEvidenceSource {
  const resolver = createExternalIdentityResolver()
  return {
    id: ARTIFICIAL_ANALYSIS_SOURCE_ID,
    fetch: async () => {
      const text = await readFile(fixturePath, "utf8")
      const raw = JSON.parse(text) as unknown
      const now = new Date()
      const parsed = parseArtificialAnalysisPayload(raw, {
        identityResolver: resolver,
        ingestedAt: now,
        observedAt: now,
      })
      return {
        observations: parsed.observations,
        metadata: {
          source: ARTIFICIAL_ANALYSIS_SOURCE_ID,
          endpoint: `fixture://${fixturePath}`,
          tier: parsed.page.tier ?? "fixture",
          pagesFetched: 1,
          recordsRetrieved: parsed.page.data.length,
          observationsEmitted: parsed.observations.length,
          matchedModels: parsed.matchedCanonicalIds,
          unresolvedSourceModelIds: parsed.unresolvedSourceModelIds,
          rateLimit: { limit: null, remaining: null, reset: null },
        },
      }
    },
  }
}

/**
 * Route-model discovery sources for a manual sync: the DockerLM host named by `DOCKERLM_BASE_URL`
 * (its own `GET {base}/models`, the same variable `bin/calibrate` and `provider-smoke` read), or a
 * saved `/v1/models` body via `--route-fixture`. `--no-route-discovery` skips it. An unset
 * variable simply means no discovery: the catalog keeps whatever was last discovered.
 */
function routeSources(args: readonly string[]): RouteModelSource[] {
  if (args.includes("--no-route-discovery")) return []
  const fixture = flagValue(args, "--route-fixture")
  if (fixture !== null) {
    return [
      createLlamaSwapDiscoverySource({
        baseUrl: "fixture:",
        fetch: (async () =>
          new Response(await readFile(fixture, "utf8"))) as unknown as typeof fetch,
      }),
    ]
  }
  const baseUrl = process.env.DOCKERLM_BASE_URL?.trim()
  return baseUrl ? [createLlamaSwapDiscoverySource({ baseUrl })] : []
}

const [verb, ...args] = process.argv.slice(2)
if (verb !== "sync" && verb !== "compile" && verb !== "status" && verb !== "show") {
  fail(USAGE, 2)
}

const url = databaseUrl()
await runMigrations({ url, connectTimeoutSeconds: 10 })
const handle = createDatabase({ url, maxConnections: 1 })
const syncLock =
  verb === "sync" ? createCapabilitySyncLockPool({ url, maxConnections: 1 }) : undefined
const repository = createCapabilityIntelligenceRepository(handle.db, syncLock)

try {
  if (verb === "sync") {
    const fixturePath = flagValue(args, "--fixture")
    const includeLocalEval = !args.includes("--no-local-eval")
    const sources: CapabilityEvidenceSource[] = [
      fixturePath !== null
        ? createFixtureArtificialAnalysisSource(fixturePath)
        : createArtificialAnalysisSource(),
      ...(includeLocalEval ? [createLocalEvaluationSource()] : []),
    ]

    const result = await syncCapabilityIntelligence({
      repository,
      sources,
      routeSources: routeSources(args),
    })

    const catalogIds = result.compiled.catalog.list().map((p) => p.id)
    const aaMeta = result.sources.find((s) => s.source === ARTIFICIAL_ANALYSIS_SOURCE_ID)
    const aaMatched = new Set(aaMeta?.matchedModels ?? [])
    const unmatchedShippedInAa = catalogIds.filter((id) => !aaMatched.has(id))

    const output = {
      status: "ok",
      publishedRevision: result.publishedRevision,
      publishedAt: result.publishedAt,
      catalogEffectiveRevision: result.compiled.catalog.revision().effective,
      compilerVersion: result.compiled.summary.compilerVersion,
      normalizerVersion: result.compiled.summary.normalizerVersion,
      evidenceDigest: result.compiled.summary.evidenceDigest,
      insertedObservations: result.insertedObservations,
      deduplicatedObservations: result.deduplicatedObservations,
      identityUpdates: result.identityUpdates,
      scoredModels: result.compiled.summary.scoredModels,
      staleDimensions: result.compiled.summary.staleDimensions,
      discoveredModels: result.compiled.summary.discoveredModels,
      skippedDiscoveredModels: result.compiled.summary.skippedDiscoveredModels,
      routeDiscovery: result.routeDiscovery,
      sources: result.sources.map((s) => ({
        source: s.source,
        endpoint: s.endpoint,
        tier: s.tier,
        pagesFetched: s.pagesFetched,
        recordsRetrieved: s.recordsRetrieved,
        observationsEmitted: s.observationsEmitted,
        matchedModels: s.matchedModels,
        ...(s.rejections === undefined ? {} : { rejections: s.rejections }),
        ...(s.source === ARTIFICIAL_ANALYSIS_SOURCE_ID
          ? { unmatchedDistpatchModels: unmatchedShippedInAa }
          : {}),
        unresolvedCount: s.unresolvedSourceModelIds.length,
        unresolvedSample: s.unresolvedSourceModelIds.slice(0, 25),
        rateLimit: s.rateLimit,
      })),
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else if (verb === "compile") {
    const result = await compileAndPublishCapabilitySnapshot({ repository })
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          publishedRevision: result.publishedRevision,
          publishedAt: result.publishedAt,
          catalogEffectiveRevision: result.compiled.catalog.revision().effective,
          summary: result.compiled.summary,
        },
        null,
        2,
      )}\n`,
    )
  } else if (verb === "status") {
    const [published, latest, allObs, unresolvedObs, routeRows] = await Promise.all([
      repository.getPublishedSnapshot(),
      repository.getLatestSnapshot(),
      repository.listObservations(),
      repository.listUnresolvedObservations(),
      repository.listRouteModels(),
    ])
    const bySource: Record<string, number> = {}
    for (const o of allObs) {
      bySource[o.source] = (bySource[o.source] ?? 0) + 1
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          publishedSnapshot: published
            ? {
                revision: published.revision,
                publishedAt: published.publishedAt?.toISOString() ?? null,
                generatedAt: published.generatedAt.toISOString(),
                compilerVersion: published.compilerVersion,
                normalizerVersion: published.normalizerVersion,
                evidenceDigest: published.evidenceDigest,
                summary: published.summary,
              }
            : null,
          latestSnapshot: latest
            ? {
                revision: latest.revision,
                publicationState: latest.publicationState,
                generatedAt: latest.generatedAt.toISOString(),
              }
            : null,
          observations: {
            total: allObs.length,
            resolved: allObs.length - unresolvedObs.length,
            unresolved: unresolvedObs.length,
            bySource,
            bySourceKnownKeys: [ARTIFICIAL_ANALYSIS_SOURCE_ID, LOCAL_EVAL_SOURCE_ID],
          },
          routeModels: {
            present: routeRows.filter((r) => r.status === "present").length,
            absent: routeRows.filter((r) => r.status === "absent").length,
            bySource: Object.fromEntries(
              [...new Set(routeRows.map((r) => r.source))].map((s) => [
                s,
                routeRows.filter((r) => r.source === s).length,
              ]),
            ),
          },
        },
        null,
        2,
      )}\n`,
    )
  } else if (verb === "show") {
    const published = await repository.getPublishedSnapshot()
    const overridesPath = process.env.MODEL_CAPABILITY_OVERRIDES_PATH?.trim() || null
    const overrides = overridesPath ? readCapabilityOverridesFile(overridesPath) : null
    const catalog = applyPublishedSnapshotToBootstrap(
      SHIPPED_CAPABILITY_CATALOG,
      published?.payload ?? null,
      overrides,
    )
    process.stdout.write(
      `${JSON.stringify(
        {
          revision: catalog.revision(),
          publishedSnapshotRevision: published?.revision ?? null,
          profiles: catalog.list(),
        },
        null,
        2,
      )}\n`,
    )
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  fail(`bin/capabilities ${verb} failed: ${message}`)
} finally {
  await syncLock?.close()
  await handle.close()
}
