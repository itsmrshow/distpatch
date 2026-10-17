CREATE TABLE "capability_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_model_id" text NOT NULL,
	"canonical_model_id" text,
	"metric" text NOT NULL,
	"raw_value" double precision NOT NULL,
	"unit" text NOT NULL,
	"benchmark" text NOT NULL,
	"benchmark_version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"provenance" jsonb NOT NULL,
	CONSTRAINT "capability_observations_fingerprint_key" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "capability_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"compiler_version" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"publication_state" text NOT NULL,
	"payload" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	CONSTRAINT "capability_snapshots_revision_key" UNIQUE("revision")
);
--> statement-breakpoint
CREATE INDEX "capability_observations_canonical_metric_idx" ON "capability_observations" USING btree ("canonical_model_id","metric","observed_at");--> statement-breakpoint
CREATE INDEX "capability_observations_source_model_idx" ON "capability_observations" USING btree ("source","source_model_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_snapshots_single_published_idx" ON "capability_snapshots" USING btree ("publication_state") WHERE "capability_snapshots"."publication_state" = 'published';--> statement-breakpoint
CREATE INDEX "capability_snapshots_state_published_idx" ON "capability_snapshots" USING btree ("publication_state","published_at","generated_at");