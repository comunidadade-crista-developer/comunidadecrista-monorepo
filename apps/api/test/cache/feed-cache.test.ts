import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFeedCache } from "../../src/cache/feed-cache.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";

class FakeRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  failWith: Error | null = null;

  async get(key: string): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.store.get(key) ?? null;
  }
  async set(
    key: string,
    value: string,
    _mode: string,
    ttl: number,
  ): Promise<"OK"> {
    if (this.failWith) throw this.failWith;
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }
  async incr(key: string): Promise<number> {
    if (this.failWith) throw this.failWith;
    const next = Number.parseInt(this.store.get(key) ?? "0", 10) + 1;
    this.store.set(key, String(next));
    return next;
  }
}

const warnings: Record<string, unknown>[] = [];
const logger = {
  warn: (obj: Record<string, unknown>) => void warnings.push(obj),
};

async function build(redis: FakeRedis | null, ttlSeconds?: number) {
  return createFeedCache({
    redis: redis as unknown as Parameters<typeof createFeedCache>[0]["redis"],
    db: await getTestDb(),
    logger,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
}

const first = { filter: "recent", limit: 20 } as const;

beforeAll(async () => {
  await getTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await truncateAll();
  warnings.length = 0;
});

describe("feed-cache", () => {
  it("1.ª leitura vai à BD e guarda; a 2.ª vem da cache (mesmo sem a BD ter mudado)", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis, 45);
    const author = await makeUser();
    await makePost(author.id, { title: "A" });

    const a = await cache.list(first);
    expect(a.cacheHit).toBe(false);
    expect(a.posts.map((p) => p.title)).toEqual(["A"]);
    expect(a.authorIds).toEqual([author.id]);
    // TTL configurado
    expect([...redis.ttls.values()]).toEqual([45]);

    await makePost(author.id, { title: "B" });
    const b = await cache.list(first);
    expect(b.cacheHit).toBe(true);
    expect(b.posts.map((p) => p.title)).toEqual(["A"]);
  });

  it("invalidar muda a versão: a leitura seguinte vê o estado novo", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    await makePost(author.id, { title: "A" });
    await cache.list(first);
    await makePost(author.id, { title: "B" });

    expect(await cache.invalidate()).toBe(true);
    const after = await cache.list(first);
    expect(after.cacheHit).toBe(false);
    expect(after.posts.map((p) => p.title).sort()).toEqual(["A", "B"]);
  });

  it("filtros, categoria e limite têm chaves separadas", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    await makePost(author.id, { category: "entendimento" });
    await makePost(author.id, { category: "ensinamento" });

    await cache.list(first);
    await cache.list({ ...first, category: "ensinamento" });
    await cache.list({ ...first, filter: "top" });
    await cache.list({ ...first, limit: 5 });
    const pageKeys = [...redis.store.keys()].filter(
      (k) => !k.endsWith("version"),
    );
    expect(pageKeys).toHaveLength(4);
  });

  it("páginas com cursor nunca passam pela cache", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    for (let i = 0; i < 3; i++) await makePost(author.id, { title: `P${i}` });

    const p1 = await cache.list({ ...first, limit: 2 });
    expect(p1.nextCursor).not.toBeNull();
    const before = redis.store.size;
    const p2 = await cache.list({
      ...first,
      limit: 2,
      cursor: p1.nextCursor!,
    });
    expect(p2.cacheHit).toBe(false);
    expect(p2.posts).toHaveLength(1);
    expect(redis.store.size).toBe(before);
  });

  it("pedidos concorrentes à mesma chave fazem uma só carga", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    await makePost(author.id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.list(first)),
    );
    expect(results.every((r) => r.posts.length === 1)).toBe(true);
    // Todos partilham a mesma promessa: nenhum foi «hit» (a cache só foi escrita uma vez).
    expect(results.filter((r) => r.cacheHit)).toHaveLength(0);
  });

  it("Redis a falhar: serve da BD, não lança e só regista nome/código", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    await makePost(author.id, { title: "A" });
    redis.failWith = Object.assign(
      new Error("connect ECONNREFUSED 10.0.0.5:6379"),
      {
        code: "ECONNREFUSED",
      },
    );

    const page = await cache.list(first);
    expect(page.cacheHit).toBe(false);
    expect(page.posts).toHaveLength(1);
    expect(await cache.invalidate()).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).not.toContain("10.0.0.5");
    expect(warnings[0]).toMatchObject({
      errorName: "Error",
      errorCode: "ECONNREFUSED",
    });
  });

  it("valor inválido na cache é ignorado e substituído", async () => {
    const redis = new FakeRedis();
    const cache = await build(redis);
    const author = await makeUser();
    await makePost(author.id, { title: "A" });
    await cache.list(first);
    for (const key of [...redis.store.keys()]) {
      if (!key.endsWith("version")) redis.store.set(key, '{"posts":"lixo"}');
    }

    const page = await cache.list(first);
    expect(page.cacheHit).toBe(false);
    expect(page.posts.map((p) => p.title)).toEqual(["A"]);
  });

  it("sem Redis funciona sempre contra a BD", async () => {
    const cache = await build(null);
    const author = await makeUser();
    await makePost(author.id, { title: "A" });
    expect((await cache.list(first)).cacheHit).toBe(false);
    await makePost(author.id, { title: "B" });
    expect((await cache.list(first)).posts).toHaveLength(2);
    expect(await cache.invalidate()).toBe(true);
  });

  it("não inclui posts em revisão nem apagados", async () => {
    const cache = await build(null);
    const author = await makeUser();
    await makePost(author.id, { title: "visível" });
    await makePost(author.id, { title: "revisão", status: "pending_review" });
    const gone = await makePost(author.id, { title: "apagado" });
    const db = await getTestDb();
    const { postsRepo } = await import("../../src/repositories/posts.js");
    await postsRepo(db).softDelete(gone.id, author.id);

    const page = await cache.list(first);
    expect(page.posts.map((p) => p.title)).toEqual(["visível"]);
  });
});
