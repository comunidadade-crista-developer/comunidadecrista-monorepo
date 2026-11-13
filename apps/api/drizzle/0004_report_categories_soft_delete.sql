-- E4-a: denúncias por categoria/severidade, retirada de denúncia sem apagar, soft delete de
-- posts, motivos de revisão e hash do pedido nas chaves de idempotência.
--
-- Nota: `ADD VALUE` corre dentro da transacção do migrador; o valor novo ('withdrawn') não
-- é usado nesta migração (Postgres ≥ 12 permite-o desde que não seja usado na mesma tx).
ALTER TYPE "public"."report_status" ADD VALUE 'withdrawn';--> statement-breakpoint
CREATE TYPE "public"."report_category" AS ENUM('spam', 'off_topic', 'offensive', 'doctrine', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_severity" AS ENUM('basic', 'medium', 'high');--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
-- As denúncias existentes migram como 'other' (o `reason` já está preenchido). O DEFAULT é
-- só para o backfill: depois sai, e a categoria passa a ser obrigatória em todos os inserts.
ALTER TABLE "reports" ADD COLUMN "category" "report_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "severity" "report_severity" GENERATED ALWAYS AS (CASE "reports"."category" WHEN 'offensive' THEN 'medium'::"report_severity" WHEN 'doctrine' THEN 'high'::"report_severity" ELSE 'basic'::"report_severity" END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_other_requires_reason" CHECK ("reports"."category" <> 'other' OR ("reports"."reason" IS NOT NULL AND btrim("reports"."reason") <> ''));--> statement-breakpoint
CREATE INDEX "reports_post_category_status_idx" ON "reports" USING btree ("post_id","category","status");--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "review_flags" text[];--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" text;
