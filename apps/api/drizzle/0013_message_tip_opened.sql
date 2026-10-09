ALTER TABLE "message_fact" ADD COLUMN "tip_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_fact" ADD COLUMN "is_opened" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- One-time fill of existing rows from `raw`. It handles JSON numbers only and is not `deriveMessage` exactly (a
-- numeric-string `tipAmount` fills 0, half cents round differently); rows are re-derived by the next backfill that
-- reads them. The dev DB had 0 mismatches over 46,756 rows on 2026-10-09.
UPDATE "message_fact" SET
  "tip_cents" = CASE WHEN raw->'isTip' = 'true'::jsonb AND jsonb_typeof(raw->'tipAmount') = 'number' THEN round((raw->>'tipAmount')::numeric * 100)::int ELSE 0 END,
  "is_opened" = coalesce(raw->'isOpened' = 'true'::jsonb, false);
