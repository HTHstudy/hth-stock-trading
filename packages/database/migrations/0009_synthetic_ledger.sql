CREATE TABLE "synthetic_ledger_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"initial" jsonb NOT NULL,
	"initial_hash" text NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "synthetic_ledger_version" CHECK ("synthetic_ledger_accounts"."version" BETWEEN 0 AND 544)
);
--> statement-breakpoint
CREATE TABLE "synthetic_ledger_mutations" (
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"binding_id" uuid NOT NULL,
	"sequence" integer,
	"kind" text NOT NULL,
	"before_hash" text NOT NULL,
	"after_hash" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"receipt_hash" text NOT NULL,
	CONSTRAINT "synthetic_ledger_mutations_account_id_version_pk" PRIMARY KEY("account_id","version"),
	CONSTRAINT "synthetic_ledger_mutation_kind" CHECK (("synthetic_ledger_mutations"."kind"='register' AND "synthetic_ledger_mutations"."sequence" IS NULL) OR ("synthetic_ledger_mutations"."kind"='apply' AND "synthetic_ledger_mutations"."sequence" IS NOT NULL AND "synthetic_ledger_mutations"."sequence" BETWEEN 1 AND 512)),
	CONSTRAINT "synthetic_ledger_mutation_version" CHECK ("synthetic_ledger_mutations"."version" BETWEEN 1 AND 544)
);
--> statement-breakpoint
CREATE TABLE "synthetic_ledger_observations" (
	"account_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"observation" jsonb NOT NULL,
	"observation_hash" text NOT NULL,
	CONSTRAINT "synthetic_ledger_observations_account_id_binding_id_sequence_pk" PRIMARY KEY("account_id","binding_id","sequence"),
	CONSTRAINT "synthetic_ledger_observation_sequence" CHECK ("synthetic_ledger_observations"."sequence" BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE "synthetic_ledger_orders" (
	"account_id" uuid NOT NULL,
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"registration" jsonb NOT NULL,
	"registration_hash" text NOT NULL,
	"created_version" integer NOT NULL,
	"observed_count" integer NOT NULL,
	"observed_hash" text NOT NULL,
	CONSTRAINT "synthetic_ledger_order_account" UNIQUE("account_id","binding_id"),
	CONSTRAINT "synthetic_ledger_order_counts" CHECK ("synthetic_ledger_orders"."created_version" BETWEEN 1 AND 544 AND "synthetic_ledger_orders"."observed_count" BETWEEN 0 AND 512)
);
--> statement-breakpoint
ALTER TABLE "synthetic_ledger_accounts" ADD CONSTRAINT "synthetic_ledger_accounts_account_id_synthetic_binding_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."synthetic_binding_accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_ledger_mutations" ADD CONSTRAINT "synthetic_ledger_mutations_account_id_binding_id_synthetic_ledger_orders_account_id_binding_id_fk" FOREIGN KEY ("account_id","binding_id") REFERENCES "public"."synthetic_ledger_orders"("account_id","binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_ledger_mutations" ADD CONSTRAINT "synthetic_ledger_mutations_account_id_binding_id_sequence_synthetic_ledger_observations_account_id_binding_id_sequence_fk" FOREIGN KEY ("account_id","binding_id","sequence") REFERENCES "public"."synthetic_ledger_observations"("account_id","binding_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_ledger_observations" ADD CONSTRAINT "synthetic_ledger_observations_account_id_binding_id_synthetic_ledger_orders_account_id_binding_id_fk" FOREIGN KEY ("account_id","binding_id") REFERENCES "public"."synthetic_ledger_orders"("account_id","binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_ledger_orders" ADD CONSTRAINT "synthetic_ledger_orders_account_id_synthetic_ledger_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."synthetic_ledger_accounts"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthetic_ledger_orders" ADD CONSTRAINT "synthetic_ledger_orders_account_id_binding_id_synthetic_order_bindings_account_id_binding_id_fk" FOREIGN KEY ("account_id","binding_id") REFERENCES "public"."synthetic_order_bindings"("account_id","binding_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_ledger_application_key" ON "synthetic_ledger_mutations" USING btree ("account_id","binding_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "synthetic_ledger_register_key" ON "synthetic_ledger_mutations" USING btree ("account_id","binding_id") WHERE "synthetic_ledger_mutations"."kind" = 'register';
--> statement-breakpoint
CREATE FUNCTION synthetic_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SYNTHETIC_LEDGER_IMMUTABLE'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_observations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON synthetic_ledger_observations FOR EACH STATEMENT EXECUTE FUNCTION synthetic_ledger_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_mutations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON synthetic_ledger_mutations FOR EACH STATEMENT EXECUTE FUNCTION synthetic_ledger_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_accounts_no_delete BEFORE DELETE OR TRUNCATE ON synthetic_ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION synthetic_ledger_immutable();
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_orders_no_delete BEFORE DELETE OR TRUNCATE ON synthetic_ledger_orders FOR EACH STATEMENT EXECUTE FUNCTION synthetic_ledger_immutable();
--> statement-breakpoint
CREATE FUNCTION synthetic_ledger_account_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.initial IS DISTINCT FROM OLD.initial
    OR NEW.initial_hash IS DISTINCT FROM OLD.initial_hash OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'SYNTHETIC_LEDGER_ACCOUNT_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_accounts_transition BEFORE UPDATE ON synthetic_ledger_accounts FOR EACH ROW EXECUTE FUNCTION synthetic_ledger_account_transition();
--> statement-breakpoint
CREATE FUNCTION synthetic_ledger_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.registration IS DISTINCT FROM OLD.registration OR NEW.registration_hash IS DISTINCT FROM OLD.registration_hash
    OR NEW.created_version IS DISTINCT FROM OLD.created_version OR NEW.observed_count <> OLD.observed_count + 1 THEN
    RAISE EXCEPTION 'SYNTHETIC_LEDGER_ORDER_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER synthetic_ledger_orders_transition BEFORE UPDATE ON synthetic_ledger_orders FOR EACH ROW EXECUTE FUNCTION synthetic_ledger_order_transition();
