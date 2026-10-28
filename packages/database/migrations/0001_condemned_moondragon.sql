CREATE TABLE "candle_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"interval" "candle_interval" NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"adjusted" boolean NOT NULL,
	"source" text NOT NULL,
	"value_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candle_revisions_hash_check" CHECK ("candle_revisions"."value_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "historical_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_datasets_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "historical_datasets_hash_check" CHECK ("historical_datasets"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "candle_revisions" ADD CONSTRAINT "candle_revisions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candle_revisions_identity_idx" ON "candle_revisions" USING btree ("instrument_id","interval","timestamp","adjusted","source","value_hash");
--> statement-breakpoint
CREATE FUNCTION reject_historical_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_HISTORICAL_DATA' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_candle_revisions BEFORE UPDATE OR DELETE OR TRUNCATE ON candle_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_historical_mutation();
--> statement-breakpoint
CREATE TRIGGER immutable_historical_datasets BEFORE UPDATE OR DELETE OR TRUNCATE ON historical_datasets FOR EACH STATEMENT EXECUTE FUNCTION reject_historical_mutation();
