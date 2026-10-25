import 'dotenv/config';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDb, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

type Instance = { db: Database; pool: Pool };
let instance: Instance | null = null;

export async function getTestDb(): Promise<Database> {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL não definido. Cria apps/api/.env (copia de .env.example) ou define a variável no ambiente.',
      );
    }
    await runMigrations(url);
    instance = createDb(url);
  }
  return instance.db;
}

export async function truncateAll(): Promise<void> {
  const db = await getTestDb();
  await db.execute(sql`
    TRUNCATE TABLE
      refresh_tokens, post_likes, reports, moderation_log, outbox, idempotency_keys,
      posts, users, gospel_cards
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestDb(): Promise<void> {
  if (instance) {
    await instance.pool.end();
    instance = null;
  }
}