CREATE TABLE "paper_strategy_revisions" (
	"account_id" text NOT NULL,
	"strategy_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb,
	"value_hash" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_strategy_revisions_account_id_strategy_id_revision_pk" PRIMARY KEY("account_id","strategy_id","revision"),
	CONSTRAINT "paper_strategy_history_value" CHECK ("paper_strategy_revisions"."revision" > 0 AND "paper_strategy_revisions"."revision" < 9007199254740990 AND "paper_strategy_revisions"."value_hash" ~ '^[a-f0-9]{64}$' AND "paper_strategy_revisions"."actor" IN ('owner','system'))
);
--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD COLUMN "definition_hash" text;--> statement-breakpoint
ALTER TABLE "paper_strategy_revisions" ADD CONSTRAINT "paper_strategy_revisions_account_id_strategy_id_paper_strategies_account_id_strategy_id_fk" FOREIGN KEY ("account_id","strategy_id") REFERENCES "public"."paper_strategies"("account_id","strategy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD CONSTRAINT "paper_strategy_revision" CHECK ("paper_strategies"."revision" >= 0 AND "paper_strategies"."revision" < 9007199254740990);--> statement-breakpoint
ALTER TABLE "paper_strategies" ADD CONSTRAINT "paper_strategy_definition_hash" CHECK ("paper_strategies"."definition_hash" IS NULL OR "paper_strategies"."definition_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
CREATE TRIGGER immutable_paper_strategy_history BEFORE UPDATE OR DELETE OR TRUNCATE ON paper_strategy_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE TRIGGER retain_paper_strategies BEFORE DELETE OR TRUNCATE ON paper_strategies FOR EACH STATEMENT EXECUTE FUNCTION reject_paper_history_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_paper_strategy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'PAPER_STRATEGY_REVISION_INVALID' USING ERRCODE = '55000'; END IF;
  ELSIF ROW(NEW.account_id, NEW.strategy_id) IS DISTINCT FROM ROW(OLD.account_id, OLD.strategy_id) OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'PAPER_STRATEGY_REVISION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paper_strategy_revision_guard BEFORE INSERT OR UPDATE ON paper_strategies FOR EACH ROW EXECUTE FUNCTION guard_paper_strategy_revision();
--> statement-breakpoint
CREATE FUNCTION check_paper_strategy_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_strategy paper_strategies%ROWTYPE;
  history paper_strategy_revisions%ROWTYPE;
  stopped boolean;
BEGIN
  SELECT * INTO current_strategy FROM paper_strategies WHERE account_id = NEW.account_id AND strategy_id = NEW.strategy_id;
  SELECT * INTO history FROM paper_strategy_revisions WHERE account_id = NEW.account_id AND strategy_id = NEW.strategy_id ORDER BY revision DESC LIMIT 1;
  SELECT a.stopped INTO stopped FROM paper_accounts a WHERE id = NEW.account_id;
  IF stopped IS DISTINCT FROM true OR history.revision IS NULL OR ROW(current_strategy.revision, current_strategy.version, current_strategy.enabled, current_strategy.definition)
    IS DISTINCT FROM ROW(history.revision, history.version, history.enabled, history.definition) THEN
    RAISE EXCEPTION 'PAPER_STRATEGY_HISTORY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_strategy_history_commit AFTER INSERT OR UPDATE ON paper_strategies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_strategy_history();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER paper_strategy_current_commit AFTER INSERT ON paper_strategy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_paper_strategy_history();
