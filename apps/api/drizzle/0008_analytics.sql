CREATE TABLE "account_workspace" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_coverage" (
	"team_id" text NOT NULL,
	"account_id" integer NOT NULL,
	"chat_id" bigint NOT NULL,
	"fan_username" text,
	"oldest_message_id" bigint,
	"oldest_at" timestamp (3) with time zone,
	"reached_start" boolean NOT NULL,
	"walked_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "chat_coverage_account_id_chat_id_pk" PRIMARY KEY("account_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "message_fact" (
	"team_id" text NOT NULL,
	"account_id" integer NOT NULL,
	"message_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"is_mass" boolean NOT NULL,
	"queue_id" bigint,
	"is_automated" boolean NOT NULL,
	"automated_reason" text,
	"price_cents" integer NOT NULL,
	"is_tip" boolean NOT NULL,
	"media_count" integer NOT NULL,
	"media_key" text,
	"text_hash" text,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "message_fact_account_id_message_id_pk" PRIMARY KEY("account_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "purchase_fact" (
	"team_id" text NOT NULL,
	"account_id" integer NOT NULL,
	"tx_id" text NOT NULL,
	"fan_id" bigint,
	"fan_id_source" text,
	"kind" text,
	"gross_cents" integer,
	"net_cents" integer,
	"currency" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "purchase_fact_account_id_tx_id_pk" PRIMARY KEY("account_id","tx_id")
);
--> statement-breakpoint
ALTER TABLE "account_workspace" ADD CONSTRAINT "account_workspace_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_coverage" ADD CONSTRAINT "chat_coverage_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_fact" ADD CONSTRAINT "message_fact_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_fact" ADD CONSTRAINT "purchase_fact_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_fact_team_account_chat_idx" ON "message_fact" USING btree ("team_id","account_id","chat_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_fact_team_account_created_idx" ON "purchase_fact" USING btree ("team_id","account_id","created_at");