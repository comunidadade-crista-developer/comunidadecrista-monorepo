import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCardsCache } from '../cache/cards-cache.js';
import { cardsRepo } from '../repositories/cards.js';
import { createRedis } from '../redis.js';
import pino from 'pino';
import { loadEnv } from "../env.js";
import { createDb } from "./client.js";

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL não está definido.");
  process.exit(1);
}

const cardsFile = fileURLToPath(
  new URL("./seed-data/cards.json", import.meta.url),
);
const cardsData = JSON.parse(readFileSync(cardsFile, "utf-8")) as Array<{
  slug: string;
  title: string;
  gospelReference: string;
  summary: string;
  otReferences: string[];
  ntReferences: string[];
  orderIndex: number;
}>;

const { db, pool } = createDb(env.DATABASE_URL);
const repo = cardsRepo(db);

let created = 0;
let updated = 0;
let allSucceeded = true;

for (const card of cardsData) {
  try {
    const before = await repo.findBySlug(card.slug);
    await repo.upsertBySlug(card);
    if (before) updated += 1;
    else created += 1;
  } catch (err) {
    allSucceeded = false;
    console.error(`Erro a inserir card "${card.slug}":`, err);
  }
}

if (allSucceeded) {
  const redis = createRedis(env.REDIS_URL);
  if (redis) {
    const cache = createCardsCache({
      redis,
      cards: cardsRepo(db),
      logger: pino({ level: 'warn' }),
    });
    const newVersion = await cache.invalidate();
    console.log(`Cache invalidado (versão=${newVersion}).`);
    await redis.quit();
  } else {
    console.warn('REDIS_URL ausente — cache não invalidado.');
  }
} else {
  console.warn('Seed parcial: cache NÃO invalidado (DB pode estar inconsistente).');
}

await pool.end();
console.log(`Seed concluído: ${created} criados, ${updated} actualizados.`);

if (!allSucceeded) process.exit(1);   