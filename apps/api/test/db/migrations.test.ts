import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getTestDb } from "../helpers/db.js";

describe("migrações", () => {
  it("cria todas as tabelas esperadas", async () => {
    const db = await getTestDb();
    const result = await db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = result.rows.map((r) => r.tablename);
    for (const t of [
      "users",
      "refresh_tokens",
      "gospel_cards",
      "posts",
      "post_likes",
      "reports",
      "moderation_log",
      "outbox",
      "idempotency_keys",
      "pending_password_resets",
      "used_recovery_sessions",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("cria as enums esperadas", async () => {
    const db = await getTestDb();
    const result = await db.execute<{ typname: string }>(
      sql`SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`,
    );
    const names = result.rows.map((r) => r.typname);
    for (const t of [
      "role",
      "post_status",
      "post_category",
      "report_status",
      "moderation_action",
      "outbox_status",
    ]) {
      expect(names).toContain(t);
    }
  });
});
