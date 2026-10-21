import type { CapabilityIntelligenceRepository, RouteModelInventoryRow } from "@multi-ai-router/db"
import { redactValue } from "../../../logging/redact"
import { createSnapshotRefresh } from "../../snapshots/refresh"
import type { CapabilityCatalogWithUnmatchedOverrides, RejectedCapabilityOverride } from "../build"
import type { ShippedCatalogInput } from "../schema"
import { SHIPPED_CAPABILITY_CATALOG } from "../shipped"
import type { CatalogRevision, ModelCapabilityCatalog, ModelCapabilityProfile } from "../types"
import {
  applyPublishedSnapshotToBootstrap,
  type CompiledCapabilitySnapshotResult,
  compileCapabilitySnapshot,
} from "./compiler"
import { createExternalIdentityResolver, type ExternalIdentityResolver } from "./identity"
import {
  RouteModelDescriptorSchema,
  type RouteModelSource,
  type RouteReconciliationSummary,
  reconcileRouteModels,
  type StoredRouteModel,
} from "./route-discovery"
import type {
  CapabilityEvidenceSource,
  CompiledCapabilitySnapshotPayload,
  EvidenceFetchMetadata,
  SourceObservation,
} from "./types"

export type RouteDiscoveryReport =
  | { readonly source: string; readonly ok: true; readonly summary: RouteReconciliationSummary }
  | { readonly source: string; readonly ok: false; readonly error: string }

class CapabilitySyncAlreadyRunningError extends Error {
  constructor() {
    super("Capability intelligence sync is already in progress")
    this.name = "CapabilitySyncAlreadyRunningError"
  }
}

/** A stored row whose descriptor no longer validates is skipped, never fatal. */
function storedRouteModelFromRow(row: RouteModelInventoryRow): StoredRouteModel[] {
  const descriptor = RouteModelDescriptorSchema.safeParse(row.descriptor)
  if (!descriptor.success) return []
  return [
    {
      source: row.source,
      routeModelId: row.routeModelId,
      descriptor: descriptor.data,
      tags: row.tags,
      status: row.status,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      absentSince: row.absentSince,
    },
  ]
}

function routeModelToRow(row: StoredRouteModel): RouteModelInventoryRow {
  return { ...row, descriptor: row.descriptor, tags: [...row.tags] }
}

/**
 * Capability Intelligence Pipeline lifecycle and warm runtime catalog store.
 *
 * Lifecycle (`syncCapabilityIntelligence` / `compileAndPublishFromDatabase`):
 *   fetch -> validate source payload -> store observations -> resolve identities ->
 *   compile candidate snapshot -> validate candidate -> publish atomically ->
 *   router adopts immutable snapshot.
 *
 * Failure semantics:
 * - If any stage fails (source fetch, schema validation, Postgres write, compilation, candidate
 *   validation, or atomic publication), the previously published snapshot in Postgres and the
 *   currently held in-memory `ModelCapabilityCatalog` remain active (last-known-good).
 * - External source outages or database failures never stop inference.
 * - Request-path callers (`resolve`, `get`, `list`, `revision`) read only the held in-memory
 *   `ModelCapabilityCatalog` reference synchronously.
 */

export interface CapabilitySyncResult {
  readonly sources: readonly EvidenceFetchMetadata[]
  readonly routeDiscovery: readonly RouteDiscoveryReport[]
  readonly insertedObservations: number
  readonly deduplicatedObservations: number
  readonly identityUpdates: number
  readonly compiled: CompiledCapabilitySnapshotResult
  readonly publishedRevision: string
  readonly publishedAt: string
}

export interface SyncCapabilityIntelligenceOptions {
  readonly repository: CapabilityIntelligenceRepository
  readonly sources: readonly CapabilityEvidenceSource[]
  /** Route-model discovery sources (`bin/capabilities sync`); never consulted by inference. */
  readonly routeSources?: readonly RouteModelSource[]
  readonly bootstrap?: ShippedCatalogInput
  readonly identityResolver?: ExternalIdentityResolver
  readonly now?: () => Date
  readonly staleDays?: number
  /** Optional warm store to refresh immediately after atomic publication. */
  readonly onPublished?: () => Promise<void>
}

export async function syncCapabilityIntelligence(
  options: SyncCapabilityIntelligenceOptions,
): Promise<CapabilitySyncResult> {
  const { repository, sources } = options
  const resolver = options.identityResolver ?? createExternalIdentityResolver()
  const now = options.now ?? (() => new Date())

  const syncRun = await repository.withSyncLock(async () => {
    const metadataList: EvidenceFetchMetadata[] = []
    const fetchedObservations: SourceObservation[] = []

    // 0. Route-model discovery (`GET /v1/models` of configured hosts). Independent of evidence
    //    fetching and never fatal: an outage or unreadable listing leaves stored route state — and so
    //    the catalog derived from it — exactly as it was (last-known-good), and is reported instead.
    const routeDiscovery: RouteDiscoveryReport[] = []
    for (const source of options.routeSources ?? []) {
      try {
        const result = await source.discover()
        const summary = await repository.reconcileRouteModels((storedRows) => {
          const stored = storedRows.flatMap(storedRouteModelFromRow)
          const reconciled = reconcileRouteModels(stored, source, result, now())
          return {
            rows: reconciled.rows.map(routeModelToRow),
            result: reconciled.summary,
          }
        })
        routeDiscovery.push({ source: source.id, ok: true, summary })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        routeDiscovery.push({ source: source.id, ok: false, error: redactValue(message) })
      }
    }

    // 1. Fetch & validate source payloads (fails closed before touching published state if any source fails)
    for (const source of sources) {
      const result = await source.fetch()
      metadataList.push(result.metadata)
      fetchedObservations.push(...result.observations)
    }

    // 2. Store observations idempotently in Postgres
    const writeResult = await repository.recordObservations(fetchedObservations)

    // 3. Re-resolve identities across stored observations in case mappings were added
    const identityUpdates = await repository.resolveObservationIdentities(
      (src, extId, provenance) => {
        const candidates = [
          extId,
          typeof provenance.slug === "string" ? provenance.slug : "",
          typeof provenance.openrouterApiId === "string" ? provenance.openrouterApiId : "",
          typeof provenance.aaModelId === "string" ? provenance.aaModelId : "",
        ].filter((c) => c.length > 0)
        return resolver.resolve(src, candidates)
      },
    )

    // 4–7. Compile candidate, validate, publish atomically, and notify warm store
    const published = await compileAndPublishCapabilitySnapshot({
      repository,
      bootstrap: options.bootstrap,
      now,
      staleDays: options.staleDays,
      onPublished: options.onPublished,
    })

    return {
      sources: metadataList,
      routeDiscovery,
      insertedObservations: writeResult.inserted,
      deduplicatedObservations: writeResult.deduplicated,
      identityUpdates,
      compiled: published.compiled,
      publishedRevision: published.publishedRevision,
      publishedAt: published.publishedAt,
    }
  })
  if (!syncRun.acquired) throw new CapabilitySyncAlreadyRunningError()
  return syncRun.value
}

export interface CompileAndPublishOptions {
  readonly repository: CapabilityIntelligenceRepository
  readonly bootstrap?: ShippedCatalogInput
  readonly now?: () => Date
  readonly staleDays?: number
  readonly onPublished?: () => Promise<void>
}

export async function compileAndPublishCapabilitySnapshot(
  options: CompileAndPublishOptions,
): Promise<{
  readonly compiled: CompiledCapabilitySnapshotResult
  readonly publishedRevision: string
  readonly publishedAt: string
}> {
  const { repository } = options
  const now = options.now ?? (() => new Date())

  const { publishedSnapshot: publishedRow, result } =
    await repository.publishSnapshotWithCurrentEvidence(
      async ({ observations: storedRows, routeModels: storedRouteRows }) => {
        // Capture time only after the repository has acquired the publication lock and read evidence.
        const timestamp = now()
        const observations: SourceObservation[] = storedRows.map((row) => ({
          source: row.source,
          sourceModelId: row.sourceModelId,
          canonicalModelId: row.canonicalModelId,
          metric: row.metric,
          rawValue: row.rawValue,
          unit: row.unit,
          benchmark: row.benchmark,
          benchmarkVersion: row.benchmarkVersion,
          fingerprint: row.fingerprint,
          observedAt: row.observedAt,
          ingestedAt: row.ingestedAt,
          sourceRef: row.sourceRef,
          provenance: row.provenance,
        }))

        // 4 & 5. Compile candidate snapshot and validate against bootstrap catalog
        const routeModels = storedRouteRows.flatMap(storedRouteModelFromRow)
        const compiled = compileCapabilitySnapshot(observations, {
          bootstrap: options.bootstrap,
          generatedAt: timestamp,
          staleDays: options.staleDays,
          routeModels,
        })

        return {
          snapshot: {
            revision: compiled.snapshot.revision,
            generatedAt: timestamp,
            compilerVersion: compiled.snapshot.compilerVersion,
            normalizerVersion: compiled.snapshot.normalizerVersion,
            evidenceDigest: compiled.snapshot.evidenceDigest,
            publicationState: "candidate",
            payload: compiled.snapshot,
            summary: compiled.summary,
          },
          result: { compiled, timestamp },
        }
      },
    )
  const { compiled, timestamp } = result

  // The repository transaction has committed before notifying the warm runtime store.
  if (options.onPublished) {
    await options.onPublished()
  }

  return {
    compiled,
    publishedRevision: publishedRow.revision,
    publishedAt: (publishedRow.publishedAt ?? timestamp).toISOString(),
  }
}

/**
 * Warm in-memory capability catalog store (`CapabilityCatalogStore`).
 *
 * Implements `ModelCapabilityCatalog` directly so every request-path consumer (`chooseModel`,
 * `selectModel`, `withVirtualModels`) reads a single immutable reference (`current`) with zero
 * async overhead, zero DB queries, and zero network calls.
 *
 * Off-request-path `refresh()` loads the latest `published` snapshot from Postgres, layers it
 * between the static bootstrap catalog and the boot-validated operator overrides, validates the
 * merged catalog, and atomically swaps `current`. If Postgres is unreachable or the stored
 * snapshot payload is invalid, `refresh()` rejects while retaining the last-known-good `current`
 * catalog untouched.
 */
export interface CapabilityCatalogStore extends ModelCapabilityCatalog {
  unmatchedOverrideIds(): readonly string[]
  rejectedOverrides(): readonly RejectedCapabilityOverride[]
  refresh(): Promise<void>
  refreshAfterMutation(): Promise<void>
  start(): void
  stop(): void
  loadedAt(): Date | null
  publishedSnapshotRevision(): string | null
}

export interface CapabilityCatalogStoreDeps {
  /** Initial boot-validated catalog (`bootstrap + operatorOverrides`), available before Postgres starts. */
  readonly initialCatalog: CapabilityCatalogWithUnmatchedOverrides
  readonly bootstrap?: ShippedCatalogInput
  readonly overrides?: unknown
  readonly loadPublishedSnapshot: () => Promise<
    | {
        readonly revision: string
        readonly payload: unknown
      }
    | undefined
  >
  readonly refreshIntervalMs: number
  readonly now?: () => Date
  readonly jitter?: (intervalMs: number) => number
  readonly onRefreshError?: (reason: string) => void
  readonly onAdopted?: (
    revision: string | null,
    unmatchedOverrideIds: readonly string[],
    rejectedOverrides: readonly RejectedCapabilityOverride[],
  ) => void
}

function defaultJitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}

function rejectedOverridesEqual(
  left: readonly RejectedCapabilityOverride[],
  right: readonly RejectedCapabilityOverride[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (rejected, index) =>
        rejected.id === right[index]?.id && rejected.reason === right[index]?.reason,
    )
  )
}

export function createCapabilityCatalogStore(
  deps: CapabilityCatalogStoreDeps,
): CapabilityCatalogStore {
  const bootstrap = deps.bootstrap ?? SHIPPED_CAPABILITY_CATALOG
  const parsedOverrides = deps.overrides ?? null
  const now = deps.now ?? (() => new Date())
  const jitter = deps.jitter ?? defaultJitter

  let current: ModelCapabilityCatalog = deps.initialCatalog
  let currentUnmatchedOverrideIds = deps.initialCatalog.unmatchedOverrideIds()
  let currentRejectedOverrides = deps.initialCatalog.rejectedOverrides()
  let activeSnapshotRevision: string | null = null
  let loadedAt: Date | null = null
  let timer: Timer | undefined

  const { refresh, refreshAfterMutation } = createSnapshotRefresh(
    async () => {
      const row = await deps.loadPublishedSnapshot()
      if (row === undefined) {
        return {
          catalog: applyPublishedSnapshotToBootstrap(bootstrap, null, parsedOverrides),
          snapshotRevision: null as string | null,
        }
      }
      const nextCatalog = applyPublishedSnapshotToBootstrap(
        bootstrap,
        row.payload as CompiledCapabilitySnapshotPayload,
        parsedOverrides,
      )
      return {
        catalog: nextCatalog,
        snapshotRevision: row.revision,
      }
    },
    (next) => {
      // Atomic pointer swap: in-flight requests holding a reference or calling methods see either
      // the previous immutable catalog or the new immutable state, never a half-built state.
      const nextUnmatchedOverrideIds = next.catalog.unmatchedOverrideIds()
      const nextRejectedOverrides = next.catalog.rejectedOverrides()
      const revisionChanged = activeSnapshotRevision !== next.snapshotRevision
      const unmatchedChanged =
        currentUnmatchedOverrideIds.length !== nextUnmatchedOverrideIds.length ||
        currentUnmatchedOverrideIds.some((id, index) => id !== nextUnmatchedOverrideIds[index])
      const rejectedChanged = !rejectedOverridesEqual(
        currentRejectedOverrides,
        nextRejectedOverrides,
      )
      current = next.catalog
      currentUnmatchedOverrideIds = nextUnmatchedOverrideIds
      currentRejectedOverrides = nextRejectedOverrides
      activeSnapshotRevision = next.snapshotRevision
      loadedAt = now()
      if (revisionChanged || unmatchedChanged || rejectedChanged) {
        deps.onAdopted?.(
          activeSnapshotRevision,
          currentUnmatchedOverrideIds,
          currentRejectedOverrides,
        )
      }
    },
  )

  const schedule = (): void => {
    timer = setTimeout(() => {
      void refresh().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        deps.onRefreshError?.(redactValue(message))
      })
      if (timer !== undefined) schedule()
    }, jitter(deps.refreshIntervalMs))
    timer.unref?.()
  }

  return {
    resolve: (model: string): ModelCapabilityProfile | null => current.resolve(model),
    get: (id): ModelCapabilityProfile | null => current.get(id),
    list: (): readonly ModelCapabilityProfile[] => current.list(),
    revision: (): CatalogRevision => current.revision(),
    unmatchedOverrideIds: () => currentUnmatchedOverrideIds,
    rejectedOverrides: () => currentRejectedOverrides,
    refresh,
    refreshAfterMutation,
    start: () => {
      if (timer === undefined) schedule()
    },
    stop: () => {
      clearTimeout(timer)
      timer = undefined
    },
    loadedAt: () => loadedAt,
    publishedSnapshotRevision: () => activeSnapshotRevision,
  }
}
