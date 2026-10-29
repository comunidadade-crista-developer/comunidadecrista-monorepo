import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { posts } from "../../src/db/schema.js";
import type { User } from "../../src/db/schema.js";
import {
  REPORT_THRESHOLD,
  REPORTER_MIN_AGE_DAYS,
  reportsRepo,
} from "../../src/repositories/reports.js";
import { postsRepo } from "../../src/repositories/posts.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb();
});

/** Conta com a idade mínima e uma partilha: a denúncia conta para o limiar. */
async function makeValidReporter(): Promise<User> {
  const user = await makeUser({
    createdAt: new Date(Date.now() - (REPORTER_MIN_AGE_DAYS + 1) * DAY_MS),
  });
  await makePost(user.id);
  return user;
}

async function postRow(id: string) {
  const db = await getTestDb();
  const [row] = await db.select().from(posts).where(eq(posts.id, id));
  return row!;
}

describe("reportsRepo.file — regras básicas", () => {
  it("cria a denúncia e incrementa reports_count", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);

    const result = await reportsRepo(db).file({
      postId: post.id,
      reporterId: reporter.id,
      reason: "conteúdo impróprio",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.reportsCount).toBe(1);
    expect(result.escalated).toBe(false);
    expect((await postRow(post.id)).reportsCount).toBe(1);
  });

  it("post inexistente → post_not_found", async () => {
    const db = await getTestDb();
    const reporter = await makeUser();
    const result = await reportsRepo(db).file({
      postId: uuidv7(),
      reporterId: reporter.id,
      reason: "x",
    });
    expect(result.outcome).toBe("post_not_found");
  });

  it.each(["pending_review", "hidden", "rejected"] as const)(
    "post %s não é denunciável (post_not_found)",
    async (status) => {
      const db = await getTestDb();
      const author = await makeUser();
      const reporter = await makeUser();
      const post = await makePost(author.id, { status });
      const result = await reportsRepo(db).file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
      expect(result.outcome).toBe("post_not_found");
      expect((await postRow(post.id)).reportsCount).toBe(0);
    },
  );

  it("auto-denúncia → own_post, sem linha nem contador", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const result = await reportsRepo(db).file({
      postId: post.id,
      reporterId: author.id,
      reason: "x",
    });
    expect(result.outcome).toBe("own_post");
    expect(await reportsRepo(db).countOpenByPost(post.id)).toBe(0);
    expect((await postRow(post.id)).reportsCount).toBe(0);
  });

  it("denúncia repetida → duplicate, contador inalterado", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const args = { postId: post.id, reporterId: reporter.id, reason: "x" };

    expect((await repo.file(args)).outcome).toBe("created");
    expect((await repo.file(args)).outcome).toBe("duplicate");
    expect((await postRow(post.id)).reportsCount).toBe(1);
  });

  it("depois de resolvida, o mesmo utilizador não volta a denunciar o post", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const args = { postId: post.id, reporterId: reporter.id, reason: "x" };

    await repo.file(args);
    await repo.resolveAllForPost(post.id, "resolved_kept", admin.id);
    expect((await repo.file(args)).outcome).toBe("duplicate");
  });
});

describe("reportsRepo.file — limiar e anti-abuso", () => {
  it("a 10.ª denúncia válida passa o post a pending_review (e sai do feed)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);

    for (let i = 1; i <= REPORT_THRESHOLD; i++) {
      const reporter = await makeValidReporter();
      const result = await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.validReports).toBe(i);
      expect(result.escalated).toBe(i === REPORT_THRESHOLD);
    }

    const row = await postRow(post.id);
    expect(row.status).toBe("pending_review");
    expect(row.reportsCount).toBe(REPORT_THRESHOLD);
    const feed = await postsRepo(db).list({});
    expect(feed.items.map((p) => p.id)).not.toContain(post.id);
  });

  it("9 válidas não escalam", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    for (let i = 0; i < REPORT_THRESHOLD - 1; i++) {
      const reporter = await makeValidReporter();
      await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
    }
    expect((await postRow(post.id)).status).toBe("published");
  });

  it("contas novas (< 7 dias) contam em reports_count mas não para o limiar", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);

    for (let i = 0; i < REPORT_THRESHOLD; i++) {
      const reporter = await makeUser(); // conta nova
      await makePost(reporter.id); // tem partilha, mas é recente
      const r = await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
      expect(r.outcome).toBe("created");
      if (r.outcome === "created") expect(r.validReports).toBe(0);
    }
    const row = await postRow(post.id);
    expect(row.status).toBe("published");
    expect(row.reportsCount).toBe(REPORT_THRESHOLD);
  });

  it("contas antigas sem qualquer partilha não contam para o limiar", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);

    for (let i = 0; i < REPORT_THRESHOLD; i++) {
      const reporter = await makeUser({
        createdAt: new Date(Date.now() - 30 * DAY_MS),
      });
      const r = await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
      if (r.outcome === "created") expect(r.validReports).toBe(0);
    }
    expect((await postRow(post.id)).status).toBe("published");
  });

  it("limiar configurável (rules.threshold)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const rules = { threshold: 2 };

    const a = await makeValidReporter();
    const b = await makeValidReporter();
    const first = await repo.file(
      { postId: post.id, reporterId: a.id, reason: "x" },
      rules,
    );
    const second = await repo.file(
      { postId: post.id, reporterId: b.id, reason: "x" },
      rules,
    );
    expect(first.outcome === "created" && first.escalated).toBe(false);
    expect(second.outcome === "created" && second.escalated).toBe(true);
  });

  it("denúncias concorrentes: o contador não se perde e só uma escala", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);

    const reporters: User[] = [];
    for (let i = 0; i < REPORT_THRESHOLD; i++) {
      reporters.push(await makeValidReporter());
    }
    const results = await Promise.all(
      reporters.map((r) =>
        repo.file({ postId: post.id, reporterId: r.id, reason: "x" }),
      ),
    );

    expect(results.every((r) => r.outcome === "created")).toBe(true);
    const escalations = results.filter(
      (r) => r.outcome === "created" && r.escalated,
    );
    expect(escalations).toHaveLength(1);
    const row = await postRow(post.id);
    expect(row.reportsCount).toBe(REPORT_THRESHOLD);
    expect(row.status).toBe("pending_review");
  });
});

describe("reportsRepo.cancel — só abertas, com contador", () => {
  it("cancela a própria denúncia aberta e decrementa o contador", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const result = await repo.file({
      postId: post.id,
      reporterId: reporter.id,
      reason: "x",
    });
    if (result.outcome !== "created") throw new Error("esperava created");

    expect(await repo.cancel(result.report.id, reporter.id)).toBe(true);
    expect((await postRow(post.id)).reportsCount).toBe(0);
    expect(await repo.countOpenByPost(post.id)).toBe(0);
    // Pode denunciar de novo depois de cancelar.
    expect(
      (
        await repo.file({
          postId: post.id,
          reporterId: reporter.id,
          reason: "x",
        })
      ).outcome,
    ).toBe("created");
  });

  it("não cancela denúncia de outro utilizador", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const r1 = await makeUser();
    const r2 = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const result = await repo.file({
      postId: post.id,
      reporterId: r1.id,
      reason: "x",
    });
    if (result.outcome !== "created") throw new Error("esperava created");

    expect(await repo.cancel(result.report.id, r2.id)).toBe(false);
    expect((await postRow(post.id)).reportsCount).toBe(1);
  });

  it("não cancela denúncia já resolvida", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const result = await repo.file({
      postId: post.id,
      reporterId: reporter.id,
      reason: "x",
    });
    if (result.outcome !== "created") throw new Error("esperava created");
    await repo.resolveAllForPost(post.id, "resolved_kept", admin.id);

    expect(await repo.cancel(result.report.id, reporter.id)).toBe(false);
    expect((await repo.listByReporter(reporter.id))[0]!.status).toBe(
      "resolved_kept",
    );
  });

  it("cancelar não tira o post de pending_review", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const rules = { threshold: 1 };
    const reporter = await makeValidReporter();
    const result = await repo.file(
      { postId: post.id, reporterId: reporter.id, reason: "x" },
      rules,
    );
    if (result.outcome !== "created") throw new Error("esperava created");
    expect(result.escalated).toBe(true);

    expect(await repo.cancel(result.report.id, reporter.id)).toBe(true);
    expect((await postRow(post.id)).status).toBe("pending_review");
  });
});

describe("reportsRepo.resolveAllForPost", () => {
  it("fecha as denúncias abertas e põe reports_count a 0", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    for (let i = 0; i < 3; i++) {
      const reporter = await makeUser();
      await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        reason: "x",
      });
    }
    expect((await postRow(post.id)).reportsCount).toBe(3);

    await repo.resolveAllForPost(post.id, "resolved_removed", admin.id);
    expect(await repo.countOpenByPost(post.id)).toBe(0);
    expect((await postRow(post.id)).reportsCount).toBe(0);
  });
});
