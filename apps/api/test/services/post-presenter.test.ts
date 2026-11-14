import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { posts, users } from "../../src/db/schema.js";
import { cardsRepo } from "../../src/repositories/cards.js";
import { usersRepo } from "../../src/repositories/users.js";
import { presentOne, presentPosts } from "../../src/services/post-presenter.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makeLike, makePost, makeUser } from "../helpers/factories.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

describe("presentPosts", () => {
  it("lista vazia → lista vazia (sem consultas)", async () => {
    const db = await getTestDb();
    expect(await presentPosts([], db)).toEqual([]);
  });

  it("devolve o autor pelo nome e NUNCA o identificador interno", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const view = await presentOne(post, db);
    expect(view.author).toEqual({ username: author.username });
    expect("authorId" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(author.id);
  });

  it("isMine e isLiked dependem de quem vê", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const viewer = await makeUser();
    const liked = await makePost(author.id, { title: "Curtido" });
    const plain = await makePost(author.id, { title: "Simples" });
    await makeLike(liked.id, viewer.id);

    const asViewer = await presentPosts([liked, plain], db, viewer.id);
    expect(asViewer.map((p) => [p.title, p.isLiked, p.isMine])).toEqual([
      ["Curtido", true, false],
      ["Simples", false, false],
    ]);
    const asAuthor = await presentPosts([liked], db, author.id);
    expect(asAuthor[0]).toMatchObject({ isMine: true, isLiked: false });
    const anonymous = await presentPosts([liked], db);
    expect(anonymous[0]).toMatchObject({ isMine: false, isLiked: false });
  });

  it("autor com apagamento pendente, apagado ou post anónimo → author null", async () => {
    const db = await getTestDb();
    const pending = await makeUser({ deletionRequestedAt: new Date() });
    const deleted = await makeUser({ deletedAt: new Date() });
    const hiddenAuthor = await makeUser();
    const orphan = await makeUser();

    const p1 = await makePost(pending.id);
    const p2 = await makePost(deleted.id);
    const p3 = await makePost(hiddenAuthor.id, { authorHidden: true });
    const p4 = await makePost(orphan.id);
    await db.update(posts).set({ authorId: null }).where(eq(posts.id, p4.id));
    const [row4] = await db.select().from(posts).where(eq(posts.id, p4.id));

    const views = await presentPosts([p1, p2, p3, row4!], db);
    expect(views.map((v) => v.author)).toEqual([null, null, null, null]);
    const text = JSON.stringify(views);
    for (const u of [pending, deleted, hiddenAuthor]) {
      expect(text).not.toContain(u.username);
      expect(text).not.toContain(u.id);
    }
  });

  it("o próprio autor de um post anónimo continua a vê-lo como seu (isMine)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id, { authorHidden: true });
    const [view] = await presentPosts([post], db, author.id);
    expect(view).toMatchObject({ author: null, isMine: true });
  });

  it("liga o slug do card sem carregar a tabela toda", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const repo = cardsRepo(db);
    const card = await repo.create({
      slug: "natividade",
      title: "Natividade",
      gospelReference: "Mateus 2",
      summary: "Resumo.",
      otReferences: [],
      ntReferences: [],
      orderIndex: 1,
    });
    await repo.create({
      slug: "outro",
      title: "Outro",
      gospelReference: "Lucas 1",
      summary: "Resumo.",
      otReferences: [],
      ntReferences: [],
      orderIndex: 2,
    });
    const withCard = await makePost(author.id, { gospelCardId: card.id });
    const without = await makePost(author.id);
    const views = await presentPosts([withCard, without], db);
    expect(views.map((v) => v.gospelCardSlug)).toEqual(["natividade", null]);
  });
});

describe("repositórios de apoio", () => {
  it("usersRepo.findManyByIds devolve os pedidos (inclui contas apagadas) e aceita lista vazia", async () => {
    const db = await getTestDb();
    const a = await makeUser();
    const b = await makeUser({ deletedAt: new Date() });
    await makeUser();
    const found = await usersRepo(db).findManyByIds([a.id, b.id]);
    expect(found.map((u) => u.id).sort()).toEqual([a.id, b.id].sort());
    expect(await usersRepo(db).findManyByIds([])).toEqual([]);
    expect(await db.select().from(users)).toHaveLength(3);
  });

  it("cardsRepo.findByIds devolve só os pedidos e aceita lista vazia", async () => {
    const db = await getTestDb();
    const repo = cardsRepo(db);
    const mk = (slug: string, orderIndex: number) =>
      repo.create({
        slug,
        title: slug,
        gospelReference: "Mateus 2",
        summary: "Resumo.",
        otReferences: [],
        ntReferences: [],
        orderIndex,
      });
    const a = await mk("a", 1);
    await mk("b", 2);
    expect((await repo.findByIds([a.id])).map((c) => c.slug)).toEqual(["a"]);
    expect(await repo.findByIds([])).toEqual([]);
  });
});
