import { sql } from "drizzle-orm"
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * Capability Intelligence Pipeline durable evidence store.
 *
 * **Off the inference request path by non-negotiable invariant.** Neither table is ever queried by
 * `chooseModel()`, `selectModel()`, or `selectAccounts()`. Background or manual sync (`bin/capabilities`)
 * ingests external benchmark feeds and local evaluation artifacts into `capability_observations`,
 * compiles and validates a candidate snapshot, and atomically publishes it into
 * `capability_snapshots`. The running router holds one immutable in-memory `ModelCapabilityCatalog`.
 *
 * `source`, `metric`, `unit`, and `publication_state` are `text` rather than Postgres enums: adding
 * a new benchmark source (Hugging Face / OpenEvals, OpenRouter metadata, LMArena) or metric should
 * not require a schema migration.
 */

export type CapabilitySnapshotPublicationState =
  | "candidate"
  | "published"
  | "superseded"
  | "rejected"

export const capabilityObservations = pgTable(
  "capability_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Source adapter identifier, e.g. `artificial-analysis`, `distpatch-local-eval`. */
    source: text("source").notNull(),

    /** Stable upstream model identifier as reported by the source (slug, UUID, or route key). */
    sourceModelId: text("source_model_id").notNull(),

    /**
     * Explicit Distpatch canonical model id (`vendor/model`), or NULL when the external model has
     * no explicit identity mapping. Never populated by fuzzy or substring guessing.
     */
    canonicalModelId: text("canonical_model_id"),

    /** Source metric identifier, e.g. `intelligence_index`, `coding_index`, `median_output_tokens_per_second`. */
    metric: text("metric").notNull(),

    /** Numeric measurement in the source's native scale (`0..100`, `0..1`, `tok/s`, `s`, `USD/1M`). */
    rawValue: doublePrecision("raw_value").notNull(),

    /** Unit or scale description (`index_100`, `ratio_0_1`, `tokens_per_second`, `seconds`, `usd_per_1m_tokens`). */
    unit: text("unit").notNull(),

    /** Upstream benchmark or composite index name, e.g. `artificial_analysis_intelligence_index`. */
    benchmark: text("benchmark").notNull(),

    /** Upstream benchmark/suite/methodology version, e.g. `4.1` or `distpatch-calibration-v1`. */
    benchmarkVersion: text("benchmark_version").notNull(),

    /**
     * Deterministic content hash over the upstream observation identity and value so repeated syncs
     * against unchanged upstream data are idempotent (`ON CONFLICT DO NOTHING`) while genuine newer
     * measurements insert new rows; a reappearing older value re-stamps its existing row, so this is
     * a deduplicated log, not an immutable ledger.
     */
    fingerprint: text("fingerprint").notNull(),

    /** When the upstream measurement or release was recorded, or the sync timestamp if unstated. */
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" }).notNull(),

    /** When Distpatch ingested this observation. */
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    /** Safe provenance URL or `repo:<path>` reference (`SourceRef`-compatible). Never contains credentials. */
    sourceRef: text("source_ref").notNull(),

    /** Sanitized provenance metadata (creator, display name, tier, route). Never auth headers or keys. */
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    unique("capability_observations_fingerprint_key").on(table.fingerprint),
    index("capability_observations_canonical_metric_idx").on(
      table.canonicalModelId,
      table.metric,
      table.observedAt,
    ),
    index("capability_observations_source_model_idx").on(
      table.source,
      table.sourceModelId,
      table.observedAt,
    ),
  ],
)

export const capabilitySnapshots = pgTable(
  "capability_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Deterministic content-addressed revision (`sha256:<hex>`). */
    revision: text("revision").notNull(),

    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),

    compilerVersion: text("compiler_version").notNull(),
    normalizerVersion: text("normalizer_version").notNull(),

    /** `sha256:<hex>` digest over all input observations considered by the compiler. */
    evidenceDigest: text("evidence_digest").notNull(),

    /** `candidate` | `published` | `superseded` | `rejected`. */
    publicationState: text("publication_state")
      .$type<CapabilitySnapshotPublicationState>()
      .notNull(),

    /** Compiled per-model capability payload (scores, sources, per-dimension provenance). */
    payload: jsonb("payload").$type<unknown>().notNull(),

    /** Summary metadata (matched models, unresolved count, source counts, validation problems). */
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    unique("capability_snapshots_revision_key").on(table.revision),
    uniqueIndex("capability_snapshots_single_published_idx")
      .on(table.publicationState)
      .where(sql`${table.publicationState} = 'published'`),
    index("capability_snapshots_state_published_idx").on(
      table.publicationState,
      table.publishedAt,
      table.generatedAt,
    ),
  ],
)

export type CapabilityObservationRow = typeof capabilityObservations.$inferSelect
export type NewCapabilityObservationRow = typeof capabilityObservations.$inferInsert
export type CapabilitySnapshotRow = typeof capabilitySnapshots.$inferSelect
export type NewCapabilitySnapshotRow = typeof capabilitySnapshots.$inferInsert
