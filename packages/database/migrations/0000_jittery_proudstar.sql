CREATE TYPE "public"."currency" AS ENUM('KRW', 'USD');--> statement-breakpoint
CREATE TYPE "public"."candle_interval" AS ENUM('1m', '1d');--> statement-breakpoint
CREATE TYPE "public"."market" AS ENUM('KR', 'US');--> statement-breakpoint
CREATE TABLE "candles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"interval" "candle_interval" NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"trading_date" date NOT NULL,
	"open" numeric(30, 10) NOT NULL,
	"high" numeric(30, 10) NOT NULL,
	"low" numeric(30, 10) NOT NULL,
	"close" numeric(30, 10) NOT NULL,
	"volume" numeric(30, 10) NOT NULL,
	"adjusted" boolean NOT NULL,
	"source" text NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candles_ohlcv_check" CHECK ("candles"."low" >= 0 AND "candles"."high" >= "candles"."low" AND "candles"."open" BETWEEN "candles"."low" AND "candles"."high" AND "candles"."close" BETWEEN "candles"."low" AND "candles"."high" AND "candles"."volume" >= 0)
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market" "market" NOT NULL,
	"symbol" text NOT NULL,
	"currency" "currency" NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "instruments_currency_check" CHECK (("instruments"."market" = 'KR' AND "instruments"."currency" = 'KRW') OR ("instruments"."market" = 'US' AND "instruments"."currency" = 'USD'))
);
--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candles_identity_idx" ON "candles" USING btree ("instrument_id","interval","timestamp","adjusted","source");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_market_symbol_idx" ON "instruments" USING btree ("market","symbol");