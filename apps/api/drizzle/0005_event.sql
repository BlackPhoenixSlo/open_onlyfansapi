CREATE TABLE "event" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"type" text NOT NULL,
	"amount_cents" integer,
	"dedup_key" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_created_idx" ON "event" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_dedup_idx" ON "event" USING btree ("dedup_key") WHERE "event"."dedup_key" is not null;