import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GospelCardsSeedFile } from "@comunidade/shared";
import { createCardsCache } from "../cache/cards-cache.js";
import { loadEnv } from "../env.js";
import {
  attachRedisErrorLogging,
  createRedis,
  waitUntilReady,
} from "../redis.js";
import { cardsRepo } from "../repositories/cards.js";
import { createDb } from "./client.js";

const log = {
  warn: (obj: Record<string, unknown>, msg: string) => console.warn(msg, obj),
  info: (obj: Record<string, unknown>, msg: string) => console.log(msg, obj),
};

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL não está definido.");
  process.exit(1);
}

// 1) Validar o ficheiro ANTES de tocar na base de dados.
const cardsFile = fileURLToPath(
  new URL("./seed-data/cards.json", import.meta.url),
);
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(cardsFile, "utf-8"));
} catch {
  console.error("seed-data/cards.json não é JSON válido.");
  process.exit(1);
}
const parsed = GospelCardsSeedFile.safeParse(raw);
if (!parsed.success) {
  console.error("seed-data/cards.json inválido:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`);
  }
  process.exit(1);
}
const cardsData = parsed.data;

const { db, pool } = createDb(env.DATABASE_URL);
const repo = cardsRepo(db);
const redis = createRedis(env.REDIS_URL);
let exitCode = 0;

try {
  const { created, updated } = await repo.upsertMany(cardsData);
  console.log(`Seed concluído: ${created} criados, ${updated} actualizados.`);

  if (!redis) {
    console.warn("REDIS_URL ausente — nada para invalidar.");
  } else {
    attachRedisErrorLogging(redis, log);
    if (!(await waitUntilReady(redis))) {
      throw new Error("redis_unavailable");
    }
    const version = await createCardsCache({
      redis,
      cards: repo,
      logger: log,
    }).invalidate();
    console.log(`Cache invalidada (versão ${version}).`);
  }
} catch (err) {
  exitCode = 1;
  console.error(
    "Seed falhou ou a cache não foi invalidada:",
    err instanceof Error ? err.name : typeof err,
    "— repete `pnpm db:seed` (é idempotente).",
  );
} finally {
  if (redis) await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
}

process.exit(exitCode);
