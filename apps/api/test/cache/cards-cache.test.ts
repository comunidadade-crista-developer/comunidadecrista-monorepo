import { describe, expect, it } from "vitest";
import {
  createCardsCache,
  type CardsCacheDeps,
} from "../../src/cache/cards-cache.js";
import type { GospelCard } from "../../src/db/schema.js";

// Sem infraestrutura: Redis, repositório e relógio são simulados, por isso estes testes são
// rápidos e determinísticos. A integração real (Postgres + Redis) está em routes/cards.test.ts.

class FakeRedis {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  calls = { get: 0, set: 0, incr: 0 };
  failWith: Error | null = null;

  async get(key: string): Promise<string | null> {
    this.calls.get += 1;
    if (this.failWith) throw this.failWith;
    return this.store.get(key) ?? null;
  }
  async set(
    key: string,
    value: string,
    _mode: string,
    ttl: number,
  ): Promise<"OK"> {
    this.calls.set += 1;
    if (this.failWith) throw this.failWith;
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }
  async incr(key: string): Promise<number> {
    this.calls.incr += 1;
    if (this.failWith) throw this.failWith;
    const next = Number.parseInt(this.store.get(key) ?? "0", 10) + 1;
    this.store.set(key, String(next));
    return next;
  }
}

const asRedis = (r: FakeRedis | null) =>
  r as unknown as CardsCacheDeps["redis"];

function row(
  slug: string,
  orderIndex: number,
  title = `Card ${slug}`,
): GospelCard {
  return {
    id: `00000000-0000-4000-8000-${String(orderIndex).padStart(12, "0")}`,
    slug,
    title,
    gospelReference: "Mateus 2",
    summary: "Resumo",
    otReferences: ["Isaías 7:14"],
    ntReferences: ["Mateus 2:1-12"],
    orderIndex,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeSource(rows: GospelCard[]) {
  const state = { rows, list: 0, find: 0 };
  return {
    state,
    source: {
      async list() {
        state.list += 1;
        return [...state.rows];
      },
      async findBySlug(slug: string) {
        state.find += 1;
        return state.rows.find((r) => r.slug === slug) ?? null;
      },
    },
  };
}

function makeLogger() {
  const logs: Array<{
    level: string;
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  return {
    logs,
    logger: {
      warn: (obj: Record<string, unknown>, msg: string) =>
        logs.push({ level: "warn", obj, msg }),
      info: (obj: Record<string, unknown>, msg: string) =>
        logs.push({ level: "info", obj, msg }),
    },
  };
}

function setup(
  rows: GospelCard[] = [row("a", 1), row("b", 2)],
  opts: { redis?: FakeRedis | null } = {},
) {
  const redis = opts.redis === undefined ? new FakeRedis() : opts.redis;
  const clock = { t: 1_000_000 };
  const src = makeSource(rows);
  const { logs, logger } = makeLogger();
  const build = (source = src.source) =>
    createCardsCache({
      redis: asRedis(redis),
      cards: source,
      logger,
      now: () => clock.t,
    });
  return { redis, clock, src, logs, build, cache: build() };
}

describe("cards-cache — list", () => {
  it("miss → BD + L2 (TTL 1 h); o segundo pedido vem da L1 sem BD nem Redis", async () => {
    const { redis, src, cache } = setup();
    const first = await cache.list();
    expect(first.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(src.state.list).toBe(1);
    expect(redis!.store.has("cc:v1:cards:v0:list")).toBe(true);
    expect(redis!.ttls.get("cc:v1:cards:v0:list")).toBe(3600);

    redis!.calls = { get: 0, set: 0, incr: 0 };
    const second = await cache.list();
    expect(second).toBe(first);
    expect(src.state.list).toBe(1);
    expect(redis!.calls.get).toBe(0);
  });

  it("não expõe campos internos (id, createdAt)", async () => {
    const { cache } = setup();
    const [card] = await cache.list();
    expect(Object.keys(card!).sort()).toEqual(
      [
        "gospelReference",
        "ntReferences",
        "orderIndex",
        "otReferences",
        "slug",
        "summary",
        "title",
      ].sort(),
    );
  });

  it("outra instância (L1 vazia) lê da L2 sem ir à BD", async () => {
    const { build, src } = setup();
    await build().list();
    const other = makeSource([row("x", 9)]);
    const second = await build(other.source).list();
    expect(second.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(other.state.list).toBe(0);
    expect(src.state.list).toBe(1);
  });

  it("lista vazia não é guardada (seed por correr)", async () => {
    const { redis, src, cache } = setup([]);
    expect(await cache.list()).toEqual([]);
    expect(await cache.list()).toEqual([]);
    expect(src.state.list).toBe(2);
    expect([...redis!.store.keys()].some((k) => k.endsWith(":list"))).toBe(
      false,
    );
  });

  it("pedidos concorrentes numa falha de cache fazem uma só carga (anti-stampede)", async () => {
    const { src, cache } = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.list()),
    );
    expect(src.state.list).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("preserva caracteres PT através da L2", async () => {
    const { build } = setup([row("pt", 1, "O Verbo se fez carne — graça")]);
    await build().list();
    const other = makeSource([]);
    const fromL2 = await build(other.source).list();
    expect(fromL2[0]!.title).toBe("O Verbo se fez carne — graça");
    expect(other.state.list).toBe(0);
  });
});

describe("cards-cache — invalidação", () => {
  it("invalidate dá uma versão nova, limpa a L1 e a lista volta a ser lida da BD", async () => {
    const { redis, src, cache } = setup();
    await cache.list();
    src.state.rows = [row("a", 1), row("b", 2), row("c", 3)];

    expect(await cache.invalidate()).toBe(1);
    const after = await cache.list();
    expect(after.map((c) => c.slug)).toEqual(["a", "b", "c"]);
    expect(src.state.list).toBe(2);
    expect(redis!.store.has("cc:v1:cards:v1:list")).toBe(true);
  });

  it("outra instância só vê a invalidação ao fim do TTL da versão (60 s)", async () => {
    const { build, clock, src } = setup();
    const a = build();
    const bSource = makeSource([row("a", 1), row("b", 2)]);
    const b = build(bSource.source);

    await a.list();
    await b.list();
    expect(bSource.state.list).toBe(0); // veio da L2

    bSource.state.rows = [row("novo", 1)];
    await a.invalidate();

    expect((await b.list()).map((c) => c.slug)).toEqual(["a", "b"]);
    clock.t += 60_001;
    expect((await b.list()).map((c) => c.slug)).toEqual(["novo"]);
    expect(bSource.state.list).toBe(1);
    expect(src.state.list).toBe(1);
  });

  it("invalidate lança se o Redis falhar (o seed tem de saber)", async () => {
    const { redis, cache } = setup();
    redis!.failWith = Object.assign(
      new Error("connect ECONNREFUSED 10.9.8.7:6379"),
      {
        code: "ECONNREFUSED",
      },
    );
    await expect(cache.invalidate()).rejects.toThrow();
  });
});

describe("cards-cache — Redis com problemas", () => {
  it("L2 corrompida ou com forma inválida é ignorada e reescrita", async () => {
    for (const bad of ["{isto não é json", '[{"slug":"x"}]', "null"]) {
      const { redis, src, cache, logs } = setup();
      redis!.store.set("cc:v1:cards:v0:list", bad);
      const list = await cache.list();
      expect(list.map((c) => c.slug)).toEqual(["a", "b"]);
      expect(src.state.list).toBe(1);
      expect(() =>
        JSON.parse(redis!.store.get("cc:v1:cards:v0:list")!),
      ).not.toThrow();
      expect(logs.some((l) => l.level === "warn")).toBe(true);
    }
  });

  it("Redis a falhar: o pedido funciona e o log não leva host nem porta", async () => {
    const redis = new FakeRedis();
    redis.failWith = Object.assign(
      new Error("connect ECONNREFUSED 10.9.8.7:6379"),
      {
        code: "ECONNREFUSED",
      },
    );
    const { src, cache, logs } = setup(undefined, { redis });
    const list = await cache.list();
    expect(list.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(src.state.list).toBe(1);
    const text = JSON.stringify(logs);
    expect(text).not.toContain("10.9.8.7");
    expect(text).not.toContain("6379");
    expect(text).toContain("ECONNREFUSED");
  });

  it("stale-if-error: com o Redis em baixo mantém a última versão, serve da L1 e não insiste", async () => {
    const { redis, clock, src, cache } = setup();
    await cache.list();
    redis!.failWith = new Error("down");
    clock.t += 61_000; // a versão em memória expirou
    redis!.calls = { get: 0, set: 0, incr: 0 };

    expect((await cache.list()).map((c) => c.slug)).toEqual(["a", "b"]);
    expect((await cache.list()).map((c) => c.slug)).toEqual(["a", "b"]);
    expect(src.state.list).toBe(1);
    expect(redis!.calls.get).toBe(1); // só uma tentativa dentro dos 10 s de espera
  });

  it("sem Redis (null): serve da BD, L1 curta (60 s) e invalidate devolve 0", async () => {
    const { clock, src, cache } = setup(undefined, { redis: null });
    await cache.list();
    await cache.list();
    expect(src.state.list).toBe(1);
    clock.t += 60_001;
    await cache.list();
    expect(src.state.list).toBe(2);

    expect(await cache.invalidate()).toBe(0);
    await cache.list();
    expect(src.state.list).toBe(3);
  });
});

describe("cards-cache — bySlug", () => {
  it("miss → BD + L2; o segundo pedido vem da L1", async () => {
    const { redis, src, cache } = setup();
    expect((await cache.bySlug("a"))?.slug).toBe("a");
    expect(src.state.find).toBe(1);
    expect(redis!.store.has("cc:v1:cards:v0:item:a")).toBe(true);
    expect((await cache.bySlug("a"))?.slug).toBe("a");
    expect(src.state.find).toBe(1);
  });

  it("inexistente: null, cache negativa de 60 s, não vai ao Redis como valor", async () => {
    const { redis, clock, src, cache } = setup();
    expect(await cache.bySlug("nao-existe")).toBeNull();
    expect(await cache.bySlug("nao-existe")).toBeNull();
    expect(src.state.find).toBe(1);
    expect([...redis!.store.keys()].some((k) => k.includes("nao-existe"))).toBe(
      false,
    );

    clock.t += 60_001;
    await cache.bySlug("nao-existe");
    expect(src.state.find).toBe(2);
  });

  it("a cache negativa cai com a invalidação (card criado pelo seed)", async () => {
    const { src, cache } = setup();
    expect(await cache.bySlug("novo")).toBeNull();
    src.state.rows = [...src.state.rows, row("novo", 3)];
    await cache.invalidate();
    expect((await cache.bySlug("novo"))?.slug).toBe("novo");
  });

  it("com a lista em L1, a lista é autoritativa: não vai à BD nem para inexistentes", async () => {
    const { src, cache } = setup();
    await cache.list();
    expect((await cache.bySlug("a"))?.slug).toBe("a");
    expect(await cache.bySlug("nao-existe")).toBeNull();
    expect(src.state.find).toBe(0);
  });

  it("slug inválido: null, sem BD e sem tocar no Redis", async () => {
    const { redis, src, cache } = setup();
    for (const bad of ["", "A", "com espaço", "a/b", "x".repeat(101), "a:b"]) {
      expect(await cache.bySlug(bad)).toBeNull();
    }
    expect(src.state.find).toBe(0);
    expect(redis!.calls.get).toBe(0);
  });

  it("as entradas negativas têm limite (1000): as mais antigas saem", async () => {
    const { src, cache } = setup();
    for (let i = 0; i < 1001; i++) await cache.bySlug(`miss-${i}`);
    src.state.find = 0;
    await cache.bySlug("miss-1000");
    expect(src.state.find).toBe(0); // recente: continua em cache
    await cache.bySlug("miss-0");
    expect(src.state.find).toBe(1); // a mais antiga foi expulsa
  });

  it("pedidos concorrentes do mesmo slug fazem uma só carga", async () => {
    const { src, cache } = setup();
    await Promise.all(Array.from({ length: 20 }, () => cache.bySlug("a")));
    expect(src.state.find).toBe(1);
  });
});
