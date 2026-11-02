CREATE TYPE "public"."report_category" AS ENUM('spam', 'off_topic', 'offensive', 'doctrine', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_severity" AS ENUM('basic', 'medium', 'high');--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "category" "report_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "severity" "report_severity" DEFAULT 'basic' NOT NULL;--> statement-breakpoint
CREATE INDEX "reports_post_category_status_idx" ON "reports" USING btree ("post_id","category","status");