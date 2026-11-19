import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db/client.js";

export async function lockAdminRoster(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-roster'))`);
}
