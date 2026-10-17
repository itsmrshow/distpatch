import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm"
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
    resolve: (source: string, sourceModelId: string) => string | null,
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

const BATCH_SIZE = 200

export function createCapabilityIntelligenceRepository(
  db: Database,
): CapabilityIntelligenceRepository {
  return {
    recordObservations: async (rows) => {
      if (rows.length === 0) return { inserted: 0, deduplicated: 0 }
      let inserted = 0
      await db.transaction(async (tx) => {
        for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
          const slice = rows.slice(offset, offset + BATCH_SIZE)
          const written = await tx
            .insert(capabilityObservations)
            .values(
              slice.map((row) => ({
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
              })),
            )
            .onConflictDoNothing({ target: capabilityObservations.fingerprint })
            .returning({ id: capabilityObservations.id })
          inserted += written.length
        }
      })
      return { inserted, deduplicated: rows.length - inserted }
    },

    resolveObservationIdentities: async (resolve) => {
      const existing = await db
        .select({
          id: capabilityObservations.id,
          source: capabilityObservations.source,
          sourceModelId: capabilityObservations.sourceModelId,
          canonicalModelId: capabilityObservations.canonicalModelId,
        })
        .from(capabilityObservations)

      let updated = 0
      await db.transaction(async (tx) => {
        for (const row of existing) {
          const next = resolve(row.source, row.sourceModelId)
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

    saveSnapshot: async (snapshot) => {
      const existing = await db
        .select()
        .from(capabilitySnapshots)
        .where(eq(capabilitySnapshots.revision, snapshot.revision))
        .limit(1)
      if (existing[0] !== undefined) {
        if (existing[0].publicationState === "published") return existing[0]
        const [updated] = await db
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
          .where(eq(capabilitySnapshots.revision, snapshot.revision))
          .returning()
        return updated as CapabilitySnapshotRow
      }
      const [created] = await db
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
    },

    publishSnapshot: (revision, publishedAt) =>
      db.transaction(async (tx) => {
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
