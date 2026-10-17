import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm"
import { advisoryLockKey } from "../advisory-lock"
import type { Database } from "../client"
import {
  type CapabilityObservationRow,
  type CapabilitySnapshotPublicationState,
  type CapabilitySnapshotRow,
  capabilityObservations,
  capabilitySnapshots,
} from "../schema/capability-intelligence"

/**
 * Durable repository for the Capability Intelligence Pipeline.
 *
 * **Never called on the inference request path.** Sync, compilation, and publication run in
 * `bin/capabilities` (or an off-path admin/background job); the data plane reads only an
 * in-memory `ModelCapabilityCatalog`.
 *
 * Observations are append-only history deduplicated by `fingerprint`:
 * - Repeating a sync over identical upstream records inserts 0 new rows.
 * - A changed upstream score or new benchmark version produces a new `fingerprint` and appends a
 *   new row without overwriting earlier observations.
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
  /**
   * Append observations idempotently by `fingerprint`. Never overwrites existing rows.
   */
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

  /** Store or update a candidate/rejected snapshot record (never modifies a published snapshot's payload). */
  saveSnapshot(snapshot: CapabilitySnapshotInsert): Promise<CapabilitySnapshotRow>

  /**
   * Atomically publish a validated snapshot by revision: demotes any existing `published` snapshot
   * to `superseded` and marks `revision` as `published` in one transaction.
   */
  publishSnapshot(revision: string, publishedAt: Date): Promise<CapabilitySnapshotRow>

  /** The currently active `published` snapshot, or undefined when none has been published yet. */
  getPublishedSnapshot(): Promise<CapabilitySnapshotRow | undefined>

  /** Latest snapshot by `generated_at` regardless of publication state. */
  getLatestSnapshot(): Promise<CapabilitySnapshotRow | undefined>

  /** Snapshot history ordered newest first. */
  listSnapshots(limit?: number): Promise<CapabilitySnapshotRow[]>
}

export type { CapabilityObservationRow, CapabilitySnapshotPublicationState, CapabilitySnapshotRow }

const SNAPSHOT_PUBLISH_LOCK_CLASS = 0x726f_7574
const SNAPSHOT_PUBLISH_LOCK_KEY = advisoryLockKey("capability_snapshot_publish")

export function createCapabilityIntelligenceRepository(
  db: Database,
): CapabilityIntelligenceRepository {
  return {
    recordObservations: async (rows) => {
      if (rows.length === 0) return { inserted: 0, deduplicated: 0 }
      let inserted = 0
      let deduplicated = 0
      await db.transaction(async (tx) => {
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
            .select({ id: capabilityObservations.id })
            .from(capabilityObservations)
            .where(eq(capabilityObservations.fingerprint, row.fingerprint))
            .limit(1)

          if (existingByFp !== undefined) {
            // Value reverted to an earlier historical fingerprint after an intermediate value B:
            // advance observedAt / ingestedAt on that row so the compiler sees the reverted value as latest.
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
            // Conflict-safe against a concurrent sync that inserted the same fingerprint after the
            // preceding select: that process also advanced the timestamps, so deduplicate.
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
      const existing = await db
        .select({
          id: capabilityObservations.id,
          source: capabilityObservations.source,
          sourceModelId: capabilityObservations.sourceModelId,
          canonicalModelId: capabilityObservations.canonicalModelId,
          provenance: capabilityObservations.provenance,
        })
        .from(capabilityObservations)

      let updated = 0
      await db.transaction(async (tx) => {
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

    saveSnapshot: (snapshot) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
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
      }),

    publishSnapshot: (revision, publishedAt) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SNAPSHOT_PUBLISH_LOCK_CLASS}, ${SNAPSHOT_PUBLISH_LOCK_KEY})`,
        )
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

        // Stale-compile guard: under READ COMMITTED, an overlapping compile that read the older
        // observation set can finish after a newer snapshot has already been published. Reject
        // it rather than letting it regress the active catalog until another compilation runs.
        const [currentPublished] = await tx
          .select({
            revision: capabilitySnapshots.revision,
            generatedAt: capabilitySnapshots.generatedAt,
          })
          .from(capabilitySnapshots)
          .where(eq(capabilitySnapshots.publicationState, "published"))
          .limit(1)
        if (
          currentPublished !== undefined &&
          currentPublished.revision !== revision &&
          currentPublished.generatedAt.getTime() > target.generatedAt.getTime()
        ) {
          throw new Error(
            `Refusing to publish snapshot ${revision} generated at ${target.generatedAt.toISOString()}: a newer snapshot ${currentPublished.revision} (${currentPublished.generatedAt.toISOString()}) is already published`,
          )
        }

        await tx
          .update(capabilitySnapshots)
          .set({ publicationState: "superseded" })
          .where(
            and(
              eq(capabilitySnapshots.publicationState, "published"),
              // Keep idempotent if re-publishing the already active revision.
            ),
          )

        const [published] = await tx
          .update(capabilitySnapshots)
          .set({
            publicationState: "published",
            publishedAt,
          })
          .where(eq(capabilitySnapshots.revision, revision))
          .returning()

        if (published === undefined) {
          throw new Error(`Failed to mark capability snapshot ${revision} as published`)
        }
        return published
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
  }
}
