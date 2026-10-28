CREATE TABLE "paper_cost_basis" (
	"account_id" text NOT NULL,
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"strategy_id" text NOT NULL,
	"quantity" numeric NOT NULL,
	"amount" numeric NOT NULL,
	CONSTRAINT "paper_cost_basis_account_id_market_symbol_strategy_id_pk" PRIMARY KEY("account_id","market","symbol","strategy_id"),
	CONSTRAINT "paper_basis_amounts" CHECK ("paper_cost_basis"."quantity" >= 0 AND "paper_cost_basis"."quantity" = trunc("paper_cost_basis"."quantity") AND "paper_cost_basis"."quantity" < 'Infinity'::numeric AND "paper_cost_basis"."amount" >= 0 AND "paper_cost_basis"."amount" < 'Infinity'::numeric AND ("paper_cost_basis"."quantity" > 0 OR "paper_cost_basis"."amount" = 0))
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"account_id" text NOT NULL,
	"fill_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"model" text DEFAULT 'quote-proxy-v1' NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"notional" numeric NOT NULL,
	"costs" numeric NOT NULL,
	"realized_pnl" numeric NOT NULL,
	"quote_timestamp" timestamp with time zone NOT NULL,
	"quote_observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "paper_fills_account_id_fill_id_pk" PRIMARY KEY("account_id","fill_id"),
	CONSTRAINT "paper_fill_amounts" CHECK ("paper_fills"."quantity" > 0 AND "paper_fills"."quantity" = trunc("paper_fills"."quantity") AND "paper_fills"."quantity" < 'Infinity'::numeric AND "paper_fills"."price" > 0 AND "paper_fills"."price" < 'Infinity'::numeric AND "paper_fills"."notional" = "paper_fills"."price" * "paper_fills"."quantity" AND "paper_fills"."costs" >= 0 AND "paper_fills"."costs" < 'Infinity'::numeric AND "paper_fills"."realized_pnl" > '-Infinity'::numeric AND "paper_fills"."realized_pnl" < 'Infinity'::numeric),
	CONSTRAINT "paper_fill_identity" CHECK ("paper_fills"."request_hash" ~ '^[a-f0-9]{64}$' AND "paper_fills"."model" = 'quote-proxy-v1')
);
--> statement-breakpoint
ALTER TABLE "paper_reservations" DROP CONSTRAINT "paper_reservation_amounts";--> statement-breakpoint
ALTER TABLE "paper_order_intents" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ALTER COLUMN "state" SET DATA TYPE text USING "state"::text;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ALTER COLUMN "state" SET DEFAULT 'INTENT_RECORDED';--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD COLUMN "filled_quantity" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD COLUMN "filled_notional" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD COLUMN "paid_costs" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_cost_basis" ADD CONSTRAINT "paper_cost_basis_account_id_paper_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_account_id_intent_id_paper_order_intents_account_id_intent_id_fk" FOREIGN KEY ("account_id","intent_id") REFERENCES "public"."paper_order_intents"("account_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD CONSTRAINT "paper_intent_state_check" CHECK ("paper_order_intents"."state" IN ('INTENT_RECORDED','READY','PARTIALLY_FILLED','FILLED','RISK_REJECTED','ABORTED'));--> statement-breakpoint
ALTER TABLE "paper_order_intents" ADD CONSTRAINT "paper_intent_filled_amounts" CHECK ("paper_order_intents"."filled_quantity" >= 0 AND "paper_order_intents"."filled_quantity" = trunc("paper_order_intents"."filled_quantity") AND "paper_order_intents"."filled_quantity" <= ("paper_order_intents"."candidate"->>'quantity')::numeric AND "paper_order_intents"."filled_notional" >= 0 AND "paper_order_intents"."filled_notional" < 'Infinity'::numeric AND "paper_order_intents"."paid_costs" >= 0 AND "paper_order_intents"."paid_costs" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "paper_reservations" ADD CONSTRAINT "paper_reservation_amounts" CHECK ("paper_reservations"."quantity" >= 0 AND (NOT "paper_reservations"."active" OR "paper_reservations"."quantity" > 0) AND "paper_reservations"."quantity" = trunc("paper_reservations"."quantity") AND "paper_reservations"."quantity" < 'Infinity'::numeric AND "paper_reservations"."cash_amount" >= 0 AND "paper_reservations"."cash_amount" < 'Infinity'::numeric AND "paper_reservations"."sell_quantity" >= 0 AND "paper_reservations"."sell_quantity" < 'Infinity'::numeric AND "paper_reservations"."cost_bps" >= 0 AND "paper_reservations"."cost_bps" < 10000 AND (("paper_reservations"."cash_amount" > 0 AND "paper_reservations"."sell_quantity" = 0) OR ("paper_reservations"."cash_amount" = 0 AND "paper_reservations"."sell_quantity" = "paper_reservations"."quantity")));
--> statement-breakpoint
CREATE FUNCTION paper_fee(amount numeric, bps numeric, unit numeric) RETURNS numeric LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (div(amount * bps, 10000 * unit) + CASE WHEN mod(amount * bps, 10000 * unit) > 0 THEN 1 ELSE 0 END) * unit;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_paper_intent_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.account_id, NEW.intent_id, NEW.dedupe_key, NEW.request_hash, NEW.candidate, NEW.signal, NEW.recorded_epoch, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.account_id, OLD.intent_id, OLD.dedupe_key, OLD.request_hash, OLD.candidate, OLD.signal, OLD.recorded_epoch, OLD.created_at)
    OR NEW.version <> OLD.version + 1
    OR NOT ((OLD.state = 'INTENT_RECORDED' AND NEW.state IN ('READY', 'RISK_REJECTED', 'ABORTED'))
      OR (OLD.state IN ('READY', 'PARTIALLY_FILLED') AND NEW.state IN ('PARTIALLY_FILLED', 'FILLED', 'ABORTED'))) THEN
    RAISE EXCEPTION 'PAPER_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('PARTIALLY_FILLED', 'FILLED') THEN
    IF NEW.filled_quantity <= OLD.filled_quantity OR NEW.filled_notional <= OLD.filled_notional OR NEW.paid_costs < OLD.paid_costs THEN
      RAISE EXCEPTION 'PAPER_FILL_TOTAL_MISMATCH' USING ERRCODE = '55000';
    END IF;
  ELSIF ROW(NEW.filled_quantity, NEW.filled_notional, NEW.paid_costs) IS DISTINCT FROM ROW(OLD.filled_quantity, OLD.filled_notional, OLD.paid_costs) THEN
    RAISE EXCEPTION 'PAPER_FILL_TOTAL_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('READY', 'PARTIALLY_FILLED') AND NOT EXISTS (SELECT 1 FROM paper_reservations WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id AND active) THEN
    RAISE EXCEPTION 'PAPER_RESERVATION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_paper_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request jsonb;
  order_state text;
  filled numeric;
  notional numeric;
  paid numeric;
  unit numeric;
  amount numeric;
  fee numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NOT OLD.active OR ROW(NEW.account_id, NEW.intent_id, NEW.valuation_price, NEW.cost_bps, NEW.valid_until)
      IS DISTINCT FROM ROW(OLD.account_id, OLD.intent_id, OLD.valuation_price, OLD.cost_bps, OLD.valid_until) THEN
      RAISE EXCEPTION 'PAPER_RESERVATION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NOT NEW.active AND ROW(NEW.quantity, NEW.cash_amount, NEW.sell_quantity) IS NOT DISTINCT FROM ROW(OLD.quantity, OLD.cash_amount, OLD.sell_quantity) THEN
      RETURN NEW;
    END IF;
    IF NEW.quantity >= OLD.quantity THEN
      RAISE EXCEPTION 'PAPER_RESERVATION_MISMATCH' USING ERRCODE = '55000';
    END IF;
  END IF;
  SELECT candidate, state, filled_quantity, filled_notional, paid_costs INTO request, order_state, filled, notional, paid
    FROM paper_order_intents WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  IF request IS NULL OR NOT (NEW.valuation_price > 0 AND NEW.valuation_price < 'Infinity'::numeric)
    OR NEW.quantity <> (request->>'quantity')::numeric - filled OR NEW.valuation_price < (request->>'limitPrice')::numeric
    OR (TG_OP = 'INSERT' AND (order_state <> 'INTENT_RECORDED' OR NOT NEW.active))
    OR (TG_OP = 'UPDATE' AND (order_state NOT IN ('PARTIALLY_FILLED', 'FILLED') OR NEW.active <> (NEW.quantity > 0))) THEN
    RAISE EXCEPTION 'PAPER_RESERVATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  unit := CASE WHEN request->'instrument'->>'market' = 'KR' THEN 1 ELSE 0.01 END;
  amount := NEW.quantity * NEW.valuation_price;
  fee := paper_fee(notional + amount, NEW.cost_bps, unit) - paid;
  IF paid <> paper_fee(notional, NEW.cost_bps, unit) THEN
    RAISE EXCEPTION 'PAPER_COST_MISMATCH' USING ERRCODE = '55000';
  END IF;
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
CREATE OR REPLACE FUNCTION check_paper_ready_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent paper_order_intents%ROWTYPE;
  resource paper_reservations%ROWTYPE;
  total_quantity numeric;
  total_notional numeric;
  total_costs numeric;
BEGIN
  SELECT * INTO intent FROM paper_order_intents WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  SELECT * INTO resource FROM paper_reservations WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  SELECT coalesce(sum(quantity), 0), coalesce(sum(notional), 0), coalesce(sum(costs), 0)
    INTO total_quantity, total_notional, total_costs FROM paper_fills WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  IF (intent.state IN ('READY', 'PARTIALLY_FILLED') AND resource.active IS DISTINCT FROM true)
    OR (intent.state NOT IN ('READY', 'PARTIALLY_FILLED') AND resource.active IS TRUE)
    OR (intent.state = 'READY' AND intent.filled_quantity <> 0)
    OR (intent.state = 'PARTIALLY_FILLED' AND NOT (intent.filled_quantity > 0 AND intent.filled_quantity < (intent.candidate->>'quantity')::numeric))
    OR (intent.state = 'FILLED' AND intent.filled_quantity <> (intent.candidate->>'quantity')::numeric)
    OR (intent.state IN ('INTENT_RECORDED', 'RISK_REJECTED') AND intent.filled_quantity <> 0)
    OR (resource.active AND resource.quantity <> (intent.candidate->>'quantity')::numeric - intent.filled_quantity)
    OR ROW(intent.filled_quantity, intent.filled_notional, intent.paid_costs) IS DISTINCT FROM ROW(total_quantity, total_notional, total_costs) THEN
    RAISE EXCEPTION 'PAPER_READY_RESOURCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_paper_fills BEFORE UPDATE OR DELETE OR TRUNCATE ON paper_fills FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_fill_intent_commit AFTER INSERT ON paper_fills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_ready_resource();
--> statement-breakpoint
CREATE FUNCTION guard_paper_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent paper_order_intents%ROWTYPE;
  resource paper_reservations%ROWTYPE;
  unit numeric;
BEGIN
  PERFORM 1 FROM paper_accounts WHERE id = NEW.account_id FOR UPDATE;
  SELECT * INTO intent FROM paper_order_intents WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  SELECT * INTO resource FROM paper_reservations WHERE account_id = NEW.account_id AND intent_id = NEW.intent_id;
  unit := CASE WHEN intent.candidate->'instrument'->>'market' = 'KR' THEN 1 ELSE 0.01 END;
  IF intent.state NOT IN ('READY', 'PARTIALLY_FILLED') OR resource.active IS DISTINCT FROM true
    OR NEW.quantity > resource.quantity OR mod(NEW.price, unit) <> 0
    OR (intent.candidate->>'side' = 'BUY' AND NEW.price > (intent.candidate->>'limitPrice')::numeric)
    OR (intent.candidate->>'side' = 'SELL' AND NEW.price < (intent.candidate->>'limitPrice')::numeric)
    OR NEW.costs <> paper_fee(intent.filled_notional + NEW.notional, resource.cost_bps, unit) - intent.paid_costs
    OR intent.decision->>'checkedAt' IS NULL
    OR NEW.quote_timestamp < (intent.decision->>'checkedAt')::timestamptz
    OR NEW.quote_observed_at < (intent.decision->>'checkedAt')::timestamptz
    OR NEW.created_at >= resource.valid_until THEN
    RAISE EXCEPTION 'PAPER_FILL_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_fill_guard BEFORE INSERT ON paper_fills FOR EACH ROW EXECUTE FUNCTION guard_paper_fill();
