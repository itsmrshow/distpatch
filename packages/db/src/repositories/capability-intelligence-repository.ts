import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { advisoryLockKey } from "../advisory-lock"
import type { Database, DatabaseExecutor } from "../client"
import {
  type CapabilityObservationRow,
  type CapabilitySnapshotPublicationState,
  type CapabilitySnapshotRow,
  capabilityObservations,
  capabilitySnapshots,
  type RouteModelInventoryRow,
  routeModelInventory,
} from "../schema/capability-intelligence"

/**
 * Durable repository for the Capability Intelligence Pipeline.
 *
 * **Never called on the inference request path.** Sync, compilation, and publication run in
 * `bin/capabilities` (or an off-path admin/background job); the data plane reads only an
 * in-memory `ModelCapabilityCatalog`.
 *
 * Observations are a fingerprint-deduplicated log (not an immutable ledger):
 * - Repeating a sync over identical upstream records inserts 0 new rows.
 * - A changed upstream score or new benchmark version produces a new `fingerprint` and inserts a
 *   new row, leaving earlier rows untouched.
 * - A value that *reappears* after an intermediate value B re-stamps its existing row only when
 *   its observation order advances; a delayed replay cannot move that fingerprint backwards.
 * - Identity resolution rewrites `canonical_model_id` in place.
 *
 * Snapshot publication is atomic: promoting a candidate snapshot demotes any previously
 * `published` row to `superseded` and marks the target row `published` inside one database
 * transaction. A failed validation or failed transaction leaves the previous `published` row
 * untouched as the last-known-good snapshot.
 */

export interface CapabilityObservationInsert {
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

export interface CapabilityObservationInsertResult {
  readonly inserted: number
  readonly deduplicated: number
}

export interface CapabilitySnapshotInsert {
  readonly revision: string
  readonly generatedAt: Date
  readonly compilerVersion: string
  readonly normalizerVersion: string
  readonly evidenceDigest: string
  readonly publicationState: CapabilitySnapshotPublicationState
  readonly payload: unknown
  readonly summary: Record<string, unknown>
  readonly publishedAt?: Date | null
}

export interface CapabilityIntelligenceRepository {
  /** Record fingerprint-deduplicated observations; newer recurrences restamp historical fingerprints. */
  recordObservations(
    rows: readonly CapabilityObservationInsert[],
  ): Promise<CapabilityObservationInsertResult>

  /**
   * Re-bind `canonical_model_id` on existing observations when the explicit identity mapping table
   * is updated, so historical observations can be recompiled without re-fetching.
   */
  resolveObservationIdentities(
    resolve: (
      source: string,
      sourceModelId: string,
      provenance: Record<string, unknown>,
    ) => string | null,
  ): Promise<number>

  /** All observations ordered deterministically (`observed_at` asc, `ingested_at` asc, `fingerprint` asc). */
  listObservations(): Promise<CapabilityObservationRow[]>

  /** Observations that mapped to a canonical model id. */
  listResolvedObservations(): Promise<CapabilityObservationRow[]>

  /** Observations whose external model id had no explicit mapping. */
  listUnresolvedObservations(): Promise<CapabilityObservationRow[]>

  /**
   * Compile and publish from one evidence read while holding the publication lock. The callback
   * runs inside that transaction after observations and route models are read.
   */
  publishSnapshotWithCurrentEvidence<T>(
    build: (evidence: {
      readonly observations: readonly CapabilityObservationRow[]
      readonly routeModels: readonly RouteModelInventoryRow[]
    }) => Promise<{ readonly snapshot: CapabilitySnapshotInsert; readonly result: T }>,
  ): Promise<{ readonly publishedSnapshot: CapabilitySnapshotRow; readonly result: T }>

  /** The currently active `published` snapshot, or undefined when none has been published yet. */
  getPublishedSnapshot(): Promise<CapabilitySnapshotRow | undefined>

  /** Latest snapshot by `generated_at` regardless of publication state. */
  getLatestSnapshot(): Promise<CapabilitySnapshotRow | undefined>

  /** Snapshot history ordered newest first. */
  listSnapshots(limit?: number): Promise<CapabilitySnapshotRow[]>

  /** Every reconciled route-model row, present and absent, ordered by `(source, route_model_id)`. */
  listRouteModels(): Promise<RouteModelInventoryRow[]>

  /**
   * Reconcile a route listing against the latest stored inventory and write the result atomically.
   */
  reconcileRouteModels<T>(
    reconcile: (stored: readonly RouteModelInventoryRow[]) => {
      readonly rows: readonly RouteModelInventoryRow[]
      readonly result: T
    },
  ): Promise<T>
}

export type {
  CapabilityObservationRow,
  CapabilitySnapshotPublicationState,
  CapabilitySnapshotRow,
  RouteModelInventoryRow,
}

const SNAPSHOT_PUBLISH_LOCK_CLASS = 0x726f_7574
const SNAPSHOT_PUBLISH_LOCK_KEY = advisoryLockKey("capability_snapshot_publish")

async function saveSnapshotInTransaction(
  tx: DatabaseExecutor,
  snapshot: CapabilitySnapshotInsert,
): Promise<CapabilitySnapshotRow> {
  const existing = await tx
    .select()
    .from(capabilitySnapshots)
    .where(eq(capabilitySnapshots.revision, snapshot.revision))
    .limit(1)
  if (existing[0] !== undefined) {
    if (existing[0].publicationState === "published") return existing[0]
    const [updated] = await tx
      .update(capabilitySnapshots)
      .set({
        generatedAt: snapshot.generatedAt,
        compilerVersion: snapshot.compilerVersion,
        normalizerVersion: snapshot.normalizerVersion,
        evidenceDigest: snapshot.evidenceDigest,
        publicationState: snapshot.publicationState,
        payload: snapshot.payload,
        summary: snapshot.summary,
        publishedAt: snapshot.publishedAt ?? existing[0].publishedAt,
      })
      .where(
        and(
          eq(capabilitySnapshots.revision, snapshot.revision),
          ne(capabilitySnapshots.publicationState, "published"),
        ),
      )
      .returning()
    return (updated ?? existing[0]) as CapabilitySnapshotRow
  }

  const [created] = await tx
    .insert(capabilitySnapshots)
    .values({
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      publishedAt: snapshot.publishedAt ?? null,
      compilerVersion: snapshot.compilerVersion,
      normalizerVersion: snapshot.normalizerVersion,
      evidenceDigest: snapshot.evidenceDigest,
      publicationState: snapshot.publicationState,
      payload: snapshot.payload,
      summary: snapshot.summary,
    })
    .returning()
  return created as CapabilitySnapshotRow
}

async function publishSnapshotInTransaction(
  tx: DatabaseExecutor,
  revision: string,
  publishedAt: Date,
): Promise<CapabilitySnapshotRow> {
  const [target] = await tx
    .select()
    .from(capabilitySnapshots)
    .where(eq(capabilitySnapshots.revision, revision))
    .limit(1)
  if (target === undefined) {
    throw new Error(`Cannot publish unknown capability snapshot revision ${revision}`)
  }
  if (target.publicationState === "rejected") {
    throw new Error(`Cannot publish rejected capability snapshot revision ${revision}`)
  }
  if (target.publicationState === "published") return target

  await tx
    .update(capabilitySnapshots)
    .set({ publicationState: "superseded" })
    .where(eq(capabilitySnapshots.publicationState, "published"))

  const [published] = await tx
    .update(capabilitySnapshots)
    .set({ publicationState: "published", publishedAt })
    .where(eq(capabilitySnapshots.revision, revision))
    .returning()
  if (published === undefined) {
    throw new Error(`Failed to mark capability snapshot ${revision} as published`)
  }
  return published
}

async function saveRouteModelsInTransaction(
  tx: DatabaseExecutor,
  rows: readonly RouteModelInventoryRow[],
): Promise<void> {
  for (const row of rows) {
    await tx
      .insert(routeModelInventory)
      .values(row)
      .onConflictDoUpdate({
        target: [routeModelInventory.source, routeModelInventory.routeModelId],
        set: {
          descriptor: row.descriptor,
          tags: row.tags,
          status: row.status,
          lastSeenAt: row.lastSeenAt,
          absentSince: row.absentSince,
        },
      })
  }
}

export function createCapabilityIntelligenceRepository(
  db: Database,
): CapabilityIntelligenceRepository {
  return {
    recordObservations: async (rows) => {
      if (rows.length === 0) return { inserted: 0, deduplicated: 0 }
      let inserted = 0
      let deduplicated = 0
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
        for (const row of rows) {
          // Find the latest stored observation for this (source, sourceModelId, metric)
          const [latest] = await tx
            .select({
              id: capabilityObservations.id,
              fingerprint: capabilityObservations.fingerprint,
              observedAt: capabilityObservations.observedAt,
              ingestedAt: capabilityObservations.ingestedAt,
            })
            .from(capabilityObservations)
            .where(
              and(
                eq(capabilityObservations.source, row.source),
                eq(capabilityObservations.sourceModelId, row.sourceModelId),
                eq(capabilityObservations.metric, row.metric),
              ),
            )
            .orderBy(
              desc(capabilityObservations.observedAt),
              desc(capabilityObservations.ingestedAt),
              desc(capabilityObservations.fingerprint),
            )
            .limit(1)

          if (latest?.fingerprint === row.fingerprint) {
            // Latest reading already has this exact value/version — unchanged sync, deduplicate.
            deduplicated += 1
            continue
          }

          const [existingByFp] = await tx
            .select({
              id: capabilityObservations.id,
              observedAt: capabilityObservations.observedAt,
              ingestedAt: capabilityObservations.ingestedAt,
            })
            .from(capabilityObservations)
            .where(eq(capabilityObservations.fingerprint, row.fingerprint))
            .limit(1)

          if (existingByFp !== undefined) {
            // A historical fingerprint may reappear, but a delayed replay must never move its
            // timestamp backwards or make it appear newer than evidence already committed.
            const observedAt = row.observedAt.getTime()
            const existingObservedAt = existingByFp.observedAt.getTime()
            const ingestedAt = row.ingestedAt.getTime()
            const existingIngestedAt = existingByFp.ingestedAt.getTime()
            if (
              observedAt < existingObservedAt ||
              (observedAt === existingObservedAt && ingestedAt <= existingIngestedAt)
            ) {
              deduplicated += 1
              continue
            }

            await tx
              .update(capabilityObservations)
              .set({
                canonicalModelId: row.canonicalModelId,
                observedAt: row.observedAt,
                ingestedAt: row.ingestedAt,
                sourceRef: row.sourceRef,
                provenance: row.provenance,
              })
              .where(eq(capabilityObservations.id, existingByFp.id))
            inserted += 1
            continue
          }

          await tx
            .insert(capabilityObservations)
            .values({
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
            })
            // Conflict-safe if an out-of-band insert races the preflight select.
            .onConflictDoNothing({ target: capabilityObservations.fingerprint })
            .returning({ id: capabilityObservations.id })
            .then((written) => {
              if (written.length === 0) deduplicated += 1
              else inserted += 1
            })
        }
      })
      return { inserted, deduplicated }
    },

    resolveObservationIdentities: async (resolve) => {
      let updated = 0
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
        const existing = await tx
          .select({
            id: capabilityObservations.id,
            source: capabilityObservations.source,
            sourceModelId: capabilityObservations.sourceModelId,
            canonicalModelId: capabilityObservations.canonicalModelId,
            provenance: capabilityObservations.provenance,
          })
          .from(capabilityObservations)

        for (const row of existing) {
          const next = resolve(row.source, row.sourceModelId, row.provenance)
          if (next === row.canonicalModelId) continue
          await tx
            .update(capabilityObservations)
            .set({ canonicalModelId: next })
            .where(eq(capabilityObservations.id, row.id))
          updated += 1
        }
      })
      return updated
    },

    listObservations: () =>
      db
        .select()
        .from(capabilityObservations)
        .orderBy(
          asc(capabilityObservations.observedAt),
          asc(capabilityObservations.ingestedAt),
          asc(capabilityObservations.fingerprint),
        ),

    listResolvedObservations: () =>
      db
        .select()
        .from(capabilityObservations)
        .where(isNotNull(capabilityObservations.canonicalModelId))
        .orderBy(
          asc(capabilityObservations.observedAt),
          asc(capabilityObservations.ingestedAt),
          asc(capabilityObservations.fingerprint),
        ),

    listUnresolvedObservations: () =>
      db
        .select()
        .from(capabilityObservations)
        .where(isNull(capabilityObservations.canonicalModelId))
        .orderBy(
          asc(capabilityObservations.source),
          asc(capabilityObservations.sourceModelId),
          asc(capabilityObservations.metric),
        ),

    publishSnapshotWithCurrentEvidence: (build) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
        const observations = await tx
          .select()
          .from(capabilityObservations)
          .orderBy(
            asc(capabilityObservations.observedAt),
            asc(capabilityObservations.ingestedAt),
            asc(capabilityObservations.fingerprint),
          )
        const routeModels = await tx
          .select()
          .from(routeModelInventory)
          .orderBy(asc(routeModelInventory.source), asc(routeModelInventory.routeModelId))
        const built = await build({ observations, routeModels })
        await saveSnapshotInTransaction(tx, built.snapshot)
        const publishedSnapshot = await publishSnapshotInTransaction(
          tx,
          built.snapshot.revision,
          built.snapshot.generatedAt,
        )
        return { publishedSnapshot, result: built.result }
      }),

    getPublishedSnapshot: async () => {
      const rows = await db
        .select()
        .from(capabilitySnapshots)
        .where(eq(capabilitySnapshots.publicationState, "published"))
        .orderBy(desc(capabilitySnapshots.publishedAt), desc(capabilitySnapshots.generatedAt))
        .limit(1)
      return rows[0]
    },

    getLatestSnapshot: async () => {
      const rows = await db
        .select()
        .from(capabilitySnapshots)
        .orderBy(desc(capabilitySnapshots.generatedAt), desc(capabilitySnapshots.publishedAt))
        .limit(1)
      return rows[0]
    },

    listSnapshots: (limit = 20) =>
      db
        .select()
        .from(capabilitySnapshots)
        .orderBy(desc(capabilitySnapshots.generatedAt), desc(capabilitySnapshots.publishedAt))
        .limit(limit),

    listRouteModels: () =>
      db
        .select()
        .from(routeModelInventory)
        .orderBy(asc(routeModelInventory.source), asc(routeModelInventory.routeModelId)),

    reconcileRouteModels: (reconcile) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
        const stored = await tx
          .select()
          .from(routeModelInventory)
          .orderBy(asc(routeModelInventory.source), asc(routeModelInventory.routeModelId))
        const { rows, result } = reconcile(stored)
        await saveRouteModelsInTransaction(tx, rows)
        return result
      }),
  }
}
