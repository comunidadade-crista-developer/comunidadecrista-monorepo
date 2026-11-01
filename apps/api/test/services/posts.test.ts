import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { reportsRepo } from "../../src/repositories/reports.js";
import {
  createPostService,
  deletePostService,
  likePostService,
  reportPostService,
  unlikePostService,
  unreportPostService,
} from "../../src/services/posts.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeTestDb();
});

const IDEM = () => `idem-${crypto.randomUUID()}`;

describe("createPostService", () => {
  it("aplica e devolve post + status; idempotência funciona", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const deps = { db };
    const key = IDEM();
    const input = {
      category: "entendimento" as const,
      title: "T",
      content: "C",
    };

    const first = await createPostService(deps, user.id, input, key);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.post.title).toBe("T");
    expect(first.data.status).toBe("published");

    const second = await createPostService(deps, user.id, input, key);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.post.id).toBe(first.data.post.id);
  });

  it("idempotency_key reutilizada com tipo diferente → conflito", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const deps = { db };
    const key = IDEM();

    // Cria um registo de idempotência com operation 'post.like' manualmente
    const { idempotencyKeysRepo } =
      await import("../../src/repositories/outbox.js");
    await idempotencyKeysRepo(db).set(key, user.id, "post.like", {
      foo: "bar",
    });

    const result = await createPostService(
      deps,
      user.id,
      { category: "entendimento", title: "T", content: "C" },
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("idempotency_key_conflict");
    expect(result.error.status).toBe(409);
  });

  it("gospelCardSlug inválido → 400", async () => {
    const db = await getTestDb();
    const user = await makeUser();
    const result = await createPostService(
      { db },
      user.id,
      {
        category: "entendimento",
        title: "T",
        content: "C",
        gospelCardSlug: "nao-existe",
      },
      IDEM(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("gospel_card_not_found");
    expect(result.error.status).toBe(400);
  });
});

describe("deletePostService", () => {
  it("autor apaga; outro user recebe 403", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const other = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const forbidden = await deletePostService(deps, other.id, post.id);
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.status).toBe(403);

    const ok = await deletePostService(deps, author.id, post.id);
    expect(ok.ok).toBe(true);
  });
});

describe("likePostService / unlikePostService", () => {
  it("like idempotente e unlike decrementa", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const user = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const a = await likePostService(deps, user.id, post.id);
    expect(a.ok && a.data.likesCount).toBe(1);

    const b = await likePostService(deps, user.id, post.id);
    expect(b.ok && b.data.likesCount).toBe(1);

    const c = await unlikePostService(deps, user.id, post.id);
    expect(c.ok && c.data.likesCount).toBe(0);
  });
});

describe("reportPostService / unreportPostService", () => {
  it("created → duplicate → unreport", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const user = await makeUser();
    const post = await makePost(author.id);
    const deps = { db };

    const first = await reportPostService(deps, user.id, post.id, "impróprio");
    expect(first.ok && first.data.outcome).toBe("created");

    const second = await reportPostService(deps, user.id, post.id, "impróprio");
    expect(second.ok && second.data.outcome).toBe("duplicate");

    const cancel = await unreportPostService(deps, user.id, post.id);
    expect(cancel.ok).toBe(true);

    const reports = await reportsRepo(db).countOpenByPost(post.id);
    expect(reports).toBe(0);
  });
});
