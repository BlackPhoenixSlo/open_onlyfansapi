DROP INDEX "member_userId_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "member_userId_idx" ON "member" USING btree ("user_id");