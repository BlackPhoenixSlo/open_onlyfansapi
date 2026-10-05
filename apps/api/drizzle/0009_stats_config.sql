CREATE TABLE "stats_config" (
	"team_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reply_cap_seconds" integer DEFAULT 43200 NOT NULL,
	"sla_seconds" integer DEFAULT 900 NOT NULL,
	"min_reply_chars" integer DEFAULT 15 NOT NULL,
	"open_gap_seconds" integer DEFAULT 604800 NOT NULL,
	"open_reply_seconds" integer DEFAULT 86400 NOT NULL,
	"convert_seconds" integer DEFAULT 259200 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stats_config" ADD CONSTRAINT "stats_config_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;