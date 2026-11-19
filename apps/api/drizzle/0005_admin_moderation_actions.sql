-- E6: acções de administração no registo de auditoria (ADR-015).
--
-- Fica sozinha numa migração: `ADD VALUE` corre dentro da transacção do migrador e o valor
-- novo não pode ser usado na mesma transacção (Postgres ≥ 12 permite o `ADD VALUE`, não o uso).
ALTER TYPE "public"."moderation_action" ADD VALUE 'admin.promoted';--> statement-breakpoint
ALTER TYPE "public"."moderation_action" ADD VALUE 'admin.demoted';
