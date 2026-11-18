CREATE TABLE "order_attempt_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"context" jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"version" integer NOT NULL,
	"head_hash" text NOT NULL,
	CONSTRAINT "order_attempt_account_version" CHECK ("order_attempt_accounts"."version" BETWEEN 0 AND 512)
);
--> statement-breakpoint
CREATE TABLE "order_attempt_events" (
	"account_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"intent_key" uuid,
	"client_key" uuid,
	"signal_key" uuid,
	"attempt_key" uuid,
	"claimed_intent" uuid,
	"resolved_attempt" uuid,
	"event" jsonb NOT NULL,
	"event_hash" text NOT NULL,
	CONSTRAINT "order_attempt_events_account_id_sequence_pk" PRIMARY KEY("account_id","sequence"),
	CONSTRAINT "order_attempt_events_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "order_attempt_event_sequence" CHECK ("order_attempt_events"."sequence" BETWEEN 1 AND 512),
	CONSTRAINT "order_attempt_event_kind" CHECK ("order_attempt_events"."kind" IN ('open','pause','heartbeat','intent','attempt','result'))
);
--> statement-breakpoint
ALTER TABLE "order_attempt_events" ADD CONSTRAINT "order_attempt_events_account_id_order_attempt_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."order_attempt_accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_intent_key" ON "order_attempt_events" USING btree ("intent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_client_key" ON "order_attempt_events" USING btree ("client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_signal_key" ON "order_attempt_events" USING btree ("account_id","signal_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_key" ON "order_attempt_events" USING btree ("attempt_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_single_claim" ON "order_attempt_events" USING btree ("claimed_intent");--> statement-breakpoint
CREATE UNIQUE INDEX "order_attempt_single_result" ON "order_attempt_events" USING btree ("resolved_attempt");--> statement-breakpoint
CREATE FUNCTION order_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ORDER_ATTEMPT_IMMUTABLE'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_attempt_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON order_attempt_events FOR EACH STATEMENT EXECUTE FUNCTION order_attempt_immutable();
--> statement-breakpoint
CREATE TRIGGER order_attempt_accounts_retain BEFORE DELETE OR TRUNCATE ON order_attempt_accounts FOR EACH STATEMENT EXECUTE FUNCTION order_attempt_immutable();
--> statement-breakpoint
CREATE FUNCTION order_attempt_account_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.context IS DISTINCT FROM OLD.context
    OR NEW.context_hash IS DISTINCT FROM OLD.context_hash OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'ORDER_ATTEMPT_ACCOUNT_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_attempt_account_guard BEFORE UPDATE ON order_attempt_accounts FOR EACH ROW EXECUTE FUNCTION order_attempt_account_transition();
