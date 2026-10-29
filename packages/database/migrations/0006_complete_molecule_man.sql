ALTER TABLE "paper_accounts" ADD COLUMN "data_source" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_account_source" CHECK ("paper_accounts"."data_source" IN ('unverified', 'synthetic-only', 'toss-readonly'));
--> statement-breakpoint
UPDATE paper_accounts SET stopped = true, epoch = epoch + 1, version = version + 1, reason = 'SOURCE_UNVERIFIED';
--> statement-breakpoint
INSERT INTO paper_events (account_id, kind, details)
SELECT id, 'PAPER_STOPPED', jsonb_build_object('reason', 'SOURCE_UNVERIFIED', 'source', 'unverified') FROM paper_accounts;
--> statement-breakpoint
CREATE FUNCTION guard_paper_account_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.data_source) IS DISTINCT FROM ROW(OLD.id, OLD.data_source) THEN
    RAISE EXCEPTION 'PAPER_SOURCE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.data_source = 'unverified' AND NEW.stopped IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAPER_SOURCE_UNVERIFIED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_account_source_guard BEFORE INSERT OR UPDATE ON paper_accounts FOR EACH ROW EXECUTE FUNCTION guard_paper_account_source();
--> statement-breakpoint
CREATE FUNCTION guard_paper_intent_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source text;
BEGIN
  SELECT data_source INTO source FROM paper_accounts WHERE id = NEW.account_id;
  IF source IS NULL OR source = 'unverified'
    OR (source = 'toss-readonly' AND (NEW.signal->>'source') IS DISTINCT FROM 'toss')
    OR (source = 'synthetic-only' AND COALESCE(NEW.signal->>'source', '') NOT LIKE 'synthetic-%') THEN
    RAISE EXCEPTION 'PAPER_SOURCE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_intent_source_guard BEFORE INSERT OR UPDATE OF account_id, signal ON paper_order_intents FOR EACH ROW EXECUTE FUNCTION guard_paper_intent_source();
