CREATE TABLE "request_log" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"api_key_id" text,
	"user_id" text,
	"account_id" integer,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"endpoint" text NOT NULL,
	"query" text,
	"ip" text NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"req_bytes" integer NOT NULL,
	"resp_bytes" integer NOT NULL,
	"error_code" text,
	"req_headers" jsonb NOT NULL,
	"req_body" text,
	"resp_body" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_log_team_created_idx" ON "request_log" USING btree ("team_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "request_log_team_key_created_idx" ON "request_log" USING btree ("team_id","api_key_id","created_at" desc);