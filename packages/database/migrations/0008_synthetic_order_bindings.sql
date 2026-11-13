CREATE TABLE "synthetic_binding_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"broker_id" text NOT NULL,
	"environment" text NOT NULL,
	"scope" text NOT NULL,
	"version" integer NOT NULL,
	"intent_count" integer NOT NULL,
	"binding_count" integer NOT NULL,
	"event_count" integer NOT NULL,
	"last_receipt_hash" text,
	"state_hash" text NOT NULL,
	CONSTRAINT "synthetic_binding_environment" CHECK ("synthetic_binding_accounts"."environment" = 'synthetic-fixture'),
	CONSTRAINT "synthetic_binding_counts" CHECK ("synthetic_binding_accounts"."intent_count" BETWEEN 0 AND 256 AND "synthetic_binding_accounts"."binding_count" BETWEEN 0 AND "synthetic_binding_accounts"."intent_count" AND "synthetic_binding_accounts"."event_count" BETWEEN 0 AND 512 AND "synthetic_binding_accounts"."version" = "synthetic_binding_accounts"."intent_count" + "synthetic_binding_accounts"."binding_count")
);
--> statement-breakpoint
CREATE TABLE "synthetic_binding_events" (
	"account_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"binding_id" uuid,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"receipt_hash" text NOT NULL,
	CONSTRAINT "synthetic_binding_events_account_id_operation_id_pk" PRIMARY KEY("account_id","operation_id"),
	CONSTRAINT "synthetic_binding_event_bound" CHECK ("synthetic_binding_events"."sequence" BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE "synthetic_binding_intents" (
	"account_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_version" integer NOT NULL,
	CONSTRAINT "synthetic_binding_intents_account_id_intent_id_pk" PRIMARY KEY("account_id","intent_id"),
	CONSTRAINT "synthetic_binding_intent_hash" UNIQUE("account_id","intent_id","payload_hash"),
	CONSTRAINT "synthetic_binding_intent_version_bound" CHECK ("synthetic_binding_intents"."created_version" BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE "synthetic_order_bindings" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"intent_hash" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"order_reference" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"created_version" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "synthetic_binding_account_id" UNIQUE("account_id","binding_id"),
	CONSTRAINT "synthetic_binding_version_bound" CHECK ("synthetic_order_bindings"."created_version" BETWEEN 1 AND 512)
);
--> statement-breakpoint
ALTER TABLE "synthetic_binding_events" ADD CONSTRAINT "synthetic_binding_events_account_id_synthetic_binding_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."synthetic_binding_accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_binding_events" ADD CONSTRAINT "synthetic_binding_events_account_id_binding_id_synthetic_order_bindings_account_id_binding_id_fk" FOREIGN KEY ("account_id","binding_id") REFERENCES "public"."synthetic_order_bindings"("account_id","binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_binding_intents" ADD CONSTRAINT "synthetic_binding_intents_account_id_synthetic_binding_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."synthetic_binding_accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_order_bindings" ADD CONSTRAINT "synthetic_order_bindings_account_id_intent_id_intent_hash_synthetic_binding_intents_account_id_intent_id_payload_hash_fk" FOREIGN KEY ("account_id","intent_id","intent_hash") REFERENCES "public"."synthetic_binding_intents"("account_id","intent_id","payload_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_scope" ON "synthetic_binding_accounts" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_event_sequence" ON "synthetic_binding_events" USING btree ("account_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_intent_signal" ON "synthetic_binding_intents" USING btree ("account_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_intent_version" ON "synthetic_binding_intents" USING btree ("account_id","created_version");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_intent" ON "synthetic_order_bindings" USING btree ("account_id","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_signal" ON "synthetic_order_bindings" USING btree ("account_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_order" ON "synthetic_order_bindings" USING btree ("account_id","order_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_binding_version" ON "synthetic_order_bindings" USING btree ("account_id","created_version");
--> statement-breakpoint
CREATE FUNCTION synthetic_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SYNTHETIC_BINDING_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER synthetic_binding_intents_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON synthetic_binding_intents FOR EACH STATEMENT EXECUTE FUNCTION synthetic_binding_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_order_bindings_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON synthetic_order_bindings FOR EACH STATEMENT EXECUTE FUNCTION synthetic_binding_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_binding_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON synthetic_binding_events FOR EACH STATEMENT EXECUTE FUNCTION synthetic_binding_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_binding_accounts_no_delete BEFORE DELETE OR TRUNCATE ON synthetic_binding_accounts FOR EACH STATEMENT EXECUTE FUNCTION synthetic_binding_immutable();
--> statement-breakpoint
CREATE FUNCTION synthetic_binding_account_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.broker_id IS DISTINCT FROM OLD.broker_id
    OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.version < OLD.version OR NEW.intent_count < OLD.intent_count
    OR NEW.binding_count < OLD.binding_count OR NEW.event_count < OLD.event_count THEN
    RAISE EXCEPTION 'SYNTHETIC_BINDING_ACCOUNT_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER synthetic_binding_accounts_transition BEFORE UPDATE ON synthetic_binding_accounts FOR EACH ROW EXECUTE FUNCTION synthetic_binding_account_transition();
