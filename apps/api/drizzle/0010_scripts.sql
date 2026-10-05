CREATE TABLE "script" (
	"team_id" text NOT NULL,
	"hash" text NOT NULL,
	"origin" text DEFAULT 'auto' NOT NULL,
	"normaliser_version" integer NOT NULL,
	"first_seen" timestamp (3) with time zone NOT NULL,
	"last_seen" timestamp (3) with time zone NOT NULL,
	"sample_text" text NOT NULL,
	CONSTRAINT "script_team_id_hash_pk" PRIMARY KEY("team_id","hash")
);
--> statement-breakpoint
ALTER TABLE "chat_coverage" ADD COLUMN "fan_name" text;--> statement-breakpoint
ALTER TABLE "chat_coverage" ADD COLUMN "fan_custom_name" text;--> statement-breakpoint
ALTER TABLE "message_fact" ADD COLUMN "normaliser_version" integer;--> statement-breakpoint
ALTER TABLE "script" ADD CONSTRAINT "script_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;