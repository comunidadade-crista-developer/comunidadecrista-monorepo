CREATE TYPE "public"."deletion_posts_mode" AS ENUM('anonymize', 'delete');--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "author_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "suspended_status" "post_status";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_posts_mode" "deletion_posts_mode";--> statement-breakpoint
CREATE INDEX "users_deletion_requested_idx" ON "users" USING btree ("deletion_requested_at");