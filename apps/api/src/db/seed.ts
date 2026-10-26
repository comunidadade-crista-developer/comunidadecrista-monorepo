import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cardsRepo } from "../repositories/cards.js";
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

for (const card of cardsData) {
  try {
    const before = await repo.findBySlug(card.slug);
    await repo.upsertBySlug(card);
    if (before) updated += 1;
    else created += 1;
  } catch (err) {
    console.error(`Erro a inserir card "${card.slug}":`, err);
    process.exit(1);
  }
}

await pool.end();
console.log(`Seed concluído: ${created} criados, ${updated} actualizados.`);
