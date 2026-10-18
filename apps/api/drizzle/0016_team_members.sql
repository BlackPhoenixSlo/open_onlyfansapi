CREATE TABLE "team_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_account_ids" integer[],
	"features" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_invite_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "allowed_account_ids" integer[];--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "features" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "display_username" text;--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_invite_team_id_idx" ON "team_invite" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_username_unique" UNIQUE("username");