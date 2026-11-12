CREATE TABLE "order_review_events" (
	"stream_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"receipt_hash" text NOT NULL,
	CONSTRAINT "order_review_events_stream_id_operation_id_pk" PRIMARY KEY("stream_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "order_review_streams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"scope" text NOT NULL,
	"reference_hash" text NOT NULL,
	"initial_observation" jsonb NOT NULL,
	"initial_observation_hash" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"observation" jsonb NOT NULL,
	"observation_hash" text NOT NULL,
	"state_hash" text NOT NULL,
	"event_count" integer NOT NULL,
	"last_receipt_hash" text,
	CONSTRAINT "order_review_source" CHECK ("order_review_streams"."source" = 'synthetic-fixture'),
	CONSTRAINT "order_review_event_bound" CHECK ("order_review_streams"."event_count" >= 0 AND "order_review_streams"."event_count" <= 512),
	CONSTRAINT "order_review_version" CHECK ("order_review_streams"."version" >= 0),
	CONSTRAINT "order_review_status" CHECK ("order_review_streams"."status" IN ('ready','quarantined'))
);
--> statement-breakpoint
ALTER TABLE "order_review_events" ADD CONSTRAINT "order_review_events_stream_id_order_review_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."order_review_streams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_review_sequence" ON "order_review_events" USING btree ("stream_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_review_identity" ON "order_review_streams" USING btree ("scope","reference_hash");