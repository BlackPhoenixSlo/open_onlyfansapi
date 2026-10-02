-- plan-v5 §2.3/§2.4 (v2.0.0): the idempotency key column, and the v4 -> v5 event-name map applied to stored names.
ALTER TABLE "webhook_delivery" ADD COLUMN "event_id" text;--> statement-breakpoint
UPDATE "webhook_delivery" SET "event_id" = "id";--> statement-breakpoint
ALTER TABLE "webhook_delivery" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
CREATE TEMPORARY TABLE "v5_event_name" ("v4" text PRIMARY KEY, "v5" text NOT NULL);--> statement-breakpoint
INSERT INTO "v5_event_name" VALUES
  ('message.received', 'messages.received'),
  ('message.sent', 'messages.sent'),
  ('ppv.unlocked', 'messages.ppv.unlocked'),
  ('tip.received', 'tips.received'),
  ('subscription.new', 'subscriptions.new'),
  ('subscription.renewed', 'subscriptions.renewed'),
  ('subscription.expired', 'subscriptions.expired'),
  ('account.session_expired', 'accounts.session_expired'),
  ('post.expired', 'posts.expired');--> statement-breakpoint
-- Endpoint filters: each element, in order.
UPDATE "webhook_endpoint" SET "events" = (
  SELECT array_agg(coalesce(m."v5", u."name") ORDER BY u."n")
  FROM unnest("webhook_endpoint"."events") WITH ORDINALITY AS u("name", "n")
  LEFT JOIN "v5_event_name" m ON m."v4" = u."name"
) WHERE "events" && ARRAY(SELECT "v4" FROM "v5_event_name");--> statement-breakpoint
-- The ledger. dedup_key keeps the v4-form frame id, so frames seen before and after the upgrade still dedupe.
UPDATE "event" SET "type" = m."v5" FROM "v5_event_name" m WHERE "event"."type" = m."v4";--> statement-breakpoint
-- No v4 payload goes out under a v5 name: pending v4 deliveries are dropped; finished ones keep their v4 name.
UPDATE "webhook_delivery" SET "status" = 'dropped'
WHERE "status" = 'pending' AND "event_type" IN (SELECT "v4" FROM "v5_event_name");--> statement-breakpoint
DROP TABLE "v5_event_name";
