CREATE TABLE "route_model_inventory" (
	"source" text NOT NULL,
	"route_model_id" text NOT NULL,
	"descriptor" jsonb NOT NULL,
	"tags" jsonb NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"absent_since" timestamp with time zone,
	CONSTRAINT "route_model_inventory_source_route_model_id_pk" PRIMARY KEY("source","route_model_id")
);