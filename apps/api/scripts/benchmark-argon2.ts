import { randomUUID } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { hash, verify } from "@node-rs/argon2";
import { loadEnv } from "../src/env.js";

/**
 * Mede o argon2id com os parâmetros reais (ARGON2_* do ambiente) no CPU onde corre. Serve para a
 * Etapa 5 do deploy: o Render gratuito não tem shell, por isso corre-se uma vez como início
 * temporário do serviço (ver docs/runbooks/servico-render.md, «Benchmark do argon2») e lê-se o log.
 *
 * Não toca na base de dados nem no Redis e não imprime segredos: usa palavras-passe aleatórias
 * geradas na hora. Pode testar variantes sem mexer no ambiente:
 *   --memory-kb=19456 --time-cost=2 --parallelism=1 --rounds=10
 */

/** Alvo por hash (ms) no CPU de produção. */
const TARGET_MS = 500;
/** Mínimos de produção: os mesmos de src/env.ts (a API recusa arrancar abaixo). */
const MIN_MEMORY_KB = 19_456;
const MIN_TIME_COST = 2;
const CONCURRENCY = 4;
const CONCURRENT_ROUNDS = 2;
const VERIFY_ROUNDS = 3;

const { values } = parseArgs({
  options: {
    "memory-kb": { type: "string" },
    "time-cost": { type: "string" },
    parallelism: { type: "string" },
    rounds: { type: "string" },
  },
  strict: true,
});

function positiveInt(raw: string | undefined, fallback: number, name: string) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} tem de ser um inteiro positivo.`);
    process.exit(1);
  }
  return n;
}

const env = loadEnv();
const opts = {
  memoryCost: positiveInt(
    values["memory-kb"],
    env.ARGON2_MEMORY_KB,
    "memory-kb",
  ),
  timeCost: positiveInt(values["time-cost"], env.ARGON2_TIME_COST, "time-cost"),
  parallelism: positiveInt(
    values.parallelism,
    env.ARGON2_PARALLELISM,
    "parallelism",
  ),
};
const rounds = positiveInt(values.rounds, 10, "rounds");

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; out: T }> {
  const t0 = performance.now();
  const out = await fn();
  return { ms: performance.now() - t0, out };
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    min: sorted[0] ?? 0,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const fmt = (ms: number) => `${Math.round(ms)} ms`;
const line = (label: string, s: ReturnType<typeof stats>) =>
  console.log(
    `${label}: mín ${fmt(s.min)} | mediana ${fmt(s.median)} | p95 ${fmt(s.p95)} | máx ${fmt(s.max)}`,
  );

console.log("== Benchmark do argon2id ==");
console.log(
  `Parâmetros: memória ${opts.memoryCost} KiB, iterações ${opts.timeCost}, paralelismo ${opts.parallelism}`,
);
console.log(
  `Máquina: ${availableParallelism()} CPU(s) visíveis, ${Math.round(totalmem() / 1024 / 1024)} MiB de RAM visíveis (o limite real do plano pode ser menor)`,
);
if (opts.memoryCost < MIN_MEMORY_KB || opts.timeCost < MIN_TIME_COST) {
  console.log(
    `AVISO: abaixo dos mínimos de produção (${MIN_MEMORY_KB} KiB e ${MIN_TIME_COST} iterações): a API recusaria arrancar com estes valores.`,
  );
}

// Aquecimento: a primeira chamada paga o carregamento do módulo nativo.
await hash(randomUUID(), opts);

const hashSamples: number[] = [];
let sampleHash = "";
const samplePassword = randomUUID();
for (let i = 0; i < rounds; i++) {
  const { ms, out } = await timed(() => hash(samplePassword, opts));
  hashSamples.push(ms);
  sampleHash = out;
}
line(`hash (sequencial, ${rounds}x)`, stats(hashSamples));

const verifySamples: number[] = [];
for (let i = 0; i < VERIFY_ROUNDS; i++) {
  const { ms, out } = await timed(() =>
    verify(sampleHash, samplePassword, opts),
  );
  if (!out) {
    console.error("ERRO: verify devolveu false para a palavra-passe certa.");
    process.exit(2);
  }
  verifySamples.push(ms);
}
line(`verify (sequencial, ${VERIFY_ROUNDS}x)`, stats(verifySamples));

// Vários logins ao mesmo tempo: no CPU partilhado do plano gratuito os hashes enfileiram.
const concurrentSamples: number[] = [];
const batchWalls: number[] = [];
for (let r = 0; r < CONCURRENT_ROUNDS; r++) {
  const wall = await timed(async () => {
    const each = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        timed(() => hash(randomUUID(), opts)),
      ),
    );
    for (const e of each) concurrentSamples.push(e.ms);
  });
  batchWalls.push(wall.ms);
}
line(`hash (${CONCURRENCY} em simultâneo, por hash)`, stats(concurrentSamples));
console.log(
  `Lote de ${CONCURRENCY} em simultâneo: ${batchWalls.map(fmt).join(", ")} (tempo total de cada lote)`,
);
console.log(
  `Memória do processo (RSS): ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MiB`,
);

const median = stats(hashSamples).median;
console.log(
  median < TARGET_MS
    ? `RESULTADO: OK, mediana ${fmt(median)} < ${TARGET_MS} ms.`
    : `RESULTADO: ATENÇÃO, mediana ${fmt(median)} >= ${TARGET_MS} ms. Não baixar dos mínimos de produção: considerar plano com mais CPU.`,
);
