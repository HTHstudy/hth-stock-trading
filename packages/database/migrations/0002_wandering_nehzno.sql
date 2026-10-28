CREATE TYPE "public"."paper_intent_state" AS ENUM('INTENT_RECORDED', 'READY', 'RISK_REJECTED', 'ABORTED');--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"stopped" boolean DEFAULT true NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"reason" text DEFAULT 'INITIAL_STOP' NOT NULL,
	"limits" jsonb,
	"ledger" jsonb NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	CONSTRAINT "paper_account_mode" CHECK ("paper_accounts"."mode" = 'paper'),
	CONSTRAINT "paper_account_versions" CHECK ("paper_accounts"."version" >= 0 AND "paper_accounts"."version" < 9007199254740991 AND "paper_accounts"."epoch" >= 0 AND "paper_accounts"."epoch" < 9007199254740991),
	CONSTRAINT "paper_lease_pair" CHECK (("paper_accounts"."lease_token" IS NULL) = ("paper_accounts"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "paper_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"intent_id" text,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_order_intents" (
	"account_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"candidate" jsonb NOT NULL,
	"signal" jsonb NOT NULL,
	"recorded_epoch" bigint NOT NULL,
	"state" "paper_intent_state" DEFAULT 'INTENT_RECORDED' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"decision" jsonb,
	"codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_order_intents_account_id_intent_id_pk" PRIMARY KEY("account_id","intent_id"),
	CONSTRAINT "paper_intent_hashes" CHECK ("paper_order_intents"."request_hash" ~ '^[a-f0-9]{64}$' AND "paper_order_intents"."dedupe_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "paper_intent_versions" CHECK ("paper_order_intents"."version" >= 0 AND "paper_order_intents"."version" < 9007199254740991 AND "paper_order_intents"."recorded_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paper_reservations" (
	"account_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"quantity" numeric NOT NULL,
	"valuation_price" numeric NOT NULL,
	"cash_amount" numeric NOT NULL,
	"sell_quantity" numeric NOT NULL,
	"cost_bps" numeric NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	CONSTRAINT "paper_reservations_account_id_intent_id_pk" PRIMARY KEY("account_id","intent_id"),
	CONSTRAINT "paper_reservation_amounts" CHECK ("paper_reservations"."quantity" > 0 AND "paper_reservations"."quantity" = trunc("paper_reservations"."quantity") AND "paper_reservations"."quantity" < 'Infinity'::numeric AND "paper_reservations"."cash_amount" >= 0 AND "paper_reservations"."cash_amount" < 'Infinity'::numeric AND "paper_reservations"."sell_quantity" >= 0 AND "paper_reservations"."sell_quantity" < 'Infinity'::numeric AND "paper_reservations"."cost_bps" >= 0 AND "paper_reservations"."cost_bps" < 10000 AND (("paper_reservations"."cash_amount" > 0 AND "paper_reservations"."sell_quantity" = 0) OR ("paper_reservations"."cash_amount" = 0 AND "paper_reservations"."sell_quantity" = "paper_reservations"."quantity")))
);
--> statement-breakpoint
CREATE TABLE "paper_strategies" (
	"account_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "paper_strategies_account_id_strategy_id_pk" PRIMARY KEY("account_id","strategy_id")
);
--> statement-breakpoint
ALTER TABLE "paper_events" ADD CONSTRAINT "paper_events_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_events" ADD CONSTRAINT "paper_events_account_id_intent_id_paper_order_intents_account_id_intent_id_fk" FOREIGN KEY ("account_id","intent_id") REFERENCES "public"."paper_order_intents"("account_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD CONSTRAINT "paper_order_intents_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_reservations" ADD CONSTRAINT "paper_reservations_account_id_intent_id_paper_order_intents_account_id_intent_id_fk" FOREIGN KEY ("account_id","intent_id") REFERENCES "public"."paper_order_intents"("account_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD CONSTRAINT "paper_strategies_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_intent_dedupe" ON "paper_order_intents" USING btree ("account_id","dedupe_key");
--> statement-breakpoint
CREATE FUNCTION reject_paper_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAPER_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_paper_events BEFORE UPDATE OR DELETE OR TRUNCATE ON paper_events FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE TRIGGER retain_paper_intents BEFORE DELETE OR TRUNCATE ON paper_order_intents FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE TRIGGER retain_paper_reservations BEFORE DELETE OR TRUNCATE ON paper_reservations FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_paper_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.account_id, NEW.intent_id, NEW.dedupe_key, NEW.request_hash, NEW.candidate, NEW.signal, NEW.recorded_epoch, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.account_id, OLD.intent_id, OLD.dedupe_key, OLD.request_hash, OLD.candidate, OLD.signal, OLD.recorded_epoch, OLD.created_at)
    OR NEW.version <> OLD.version + 1
    OR NOT ((OLD.state = 'INTENT_RECORDED' AND NEW.state IN ('READY', 'RISK_REJECTED', 'ABORTED')) OR (OLD.state = 'READY' AND NEW.state = 'ABORTED')) THEN
    RAISE EXCEPTION 'PAPER_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'READY' AND NOT EXISTS (SELECT 1 FROM paper_reservations WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id AND active) THEN
    RAISE EXCEPTION 'PAPER_RESERVATION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_intent_transition BEFORE UPDATE ON paper_order_intents FOR EACH ROW EXECUTE FUNCTION guard_paper_intent_transition();
--> statement-breakpoint
CREATE FUNCTION guard_paper_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request jsonb;
  order_state paper_intent_state;
  unit numeric;
  amount numeric;
  fee numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT OLD.active OR NEW.active OR ROW(NEW.account_id, NEW.intent_id, NEW.quantity, NEW.valuation_price, NEW.cash_amount, NEW.sell_quantity, NEW.cost_bps, NEW.valid_until)
      IS DISTINCT FROM ROW(OLD.account_id, OLD.intent_id, OLD.quantity, OLD.valuation_price, OLD.cash_amount, OLD.sell_quantity, OLD.cost_bps, OLD.valid_until) THEN
      RAISE EXCEPTION 'PAPER_RESERVATION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT candidate, state INTO request, order_state FROM paper_order_intents WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  IF request IS NULL OR order_state <> 'INTENT_RECORDED' OR NOT NEW.active OR NOT (NEW.valuation_price > 0 AND NEW.valuation_price < 'Infinity'::numeric)
    OR NEW.quantity <> (request->>'quantity')::numeric OR NEW.valuation_price < (request->>'limitPrice')::numeric THEN
    RAISE EXCEPTION 'PAPER_RESERVATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  unit := CASE WHEN request->'instrument'->>'market' = 'KR' THEN 1 ELSE 0.01 END;
  amount := NEW.quantity * NEW.valuation_price;
  fee := (div(amount * NEW.cost_bps, 10000 * unit) + CASE WHEN mod(amount * NEW.cost_bps, 10000 * unit) > 0 THEN 1 ELSE 0 END) * unit;
  IF request->>'side' = 'BUY' THEN
    IF NEW.cash_amount <> amount + fee OR NEW.sell_quantity <> 0 THEN
      RAISE EXCEPTION 'PAPER_CASH_RESERVATION_MISMATCH' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.cash_amount <> 0 OR NEW.sell_quantity <> NEW.quantity THEN
    RAISE EXCEPTION 'PAPER_SELL_RESERVATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_reservation_guard BEFORE INSERT OR UPDATE ON paper_reservations FOR EACH ROW EXECUTE FUNCTION guard_paper_reservation();
--> statement-breakpoint
CREATE FUNCTION check_paper_ready_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_state paper_intent_state;
  resource_active boolean;
BEGIN
  SELECT state INTO current_state FROM paper_order_intents WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  SELECT active INTO resource_active FROM paper_reservations WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  IF (current_state = 'READY' AND resource_active IS DISTINCT FROM true) OR (current_state <> 'READY' AND resource_active IS TRUE) THEN
    RAISE EXCEPTION 'PAPER_READY_RESOURCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_intent_resource_commit AFTER INSERT OR UPDATE ON paper_order_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_ready_resource();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_reservation_intent_commit AFTER INSERT OR UPDATE ON paper_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_ready_resource();
