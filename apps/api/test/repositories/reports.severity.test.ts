import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CATEGORY_TO_SEVERITY, ReportCategory } from "@comunidade/shared";
import { posts, reports } from "../../src/db/schema.js";
import type { User } from "../../src/db/schema.js";
import {
  REPORT_THRESHOLDS,
  REPORTER_MIN_AGE_DAYS,
  reportsRepo,
} from "../../src/repositories/reports.js";
import { closeTestDb, getTestDb, truncateAll } from "../helpers/db.js";
import { makePost, makeUser } from "../helpers/factories.js";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestDb(); 
});

/** Conta com a idade mínima e uma partilha publicada: a denúncia conta para o limiar. */
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

describe("severidade gerada pelo Postgres", () => {
  it.each(ReportCategory.options)(
    "categoria %s → gravidade igual a CATEGORY_TO_SEVERITY",
    async (category) => {
      const db = await getTestDb();
      const author = await makeUser();
      const reporter = await makeUser();
      const post = await makePost(author.id);
      const created = await reportsRepo(db).file({
        postId: post.id,
        reporterId: reporter.id,
        category,
        reason: "motivo",
      });
      if (created.outcome !== "created") throw new Error("esperava created");
      expect(created.report.severity).toBe(CATEGORY_TO_SEVERITY[category]);
    },
  );

  it("a gravidade não se pode escrever à mão", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    await expect(
      db.execute(sql`
        INSERT INTO reports (id, post_id, reporter_id, category, severity)
        VALUES (gen_random_uuid(), ${post.id}, ${reporter.id}, 'spam', 'high')
      `),
    ).rejects.toThrow();
  });
});

describe("motivo e categoria", () => {
  it("«other» sem motivo é recusado pela base de dados (CHECK)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    await expect(
      reportsRepo(db).file({
        postId: post.id,
        reporterId: reporter.id,
        category: "other",
      }),
    ).rejects.toThrow();
    // A transacção reverteu: o contador não mudou.
    expect((await postRow(post.id)).reportsCount).toBe(0);
  });

  it("«other» com motivo só de espaços também é recusado", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    await expect(
      reportsRepo(db).file({
        postId: post.id,
        reporterId: reporter.id,
        category: "other",
        reason: "   ",
      }),
    ).rejects.toThrow();
  });

  it("categorias que não são «other» não precisam de motivo", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    const result = await reportsRepo(db).file({
      postId: post.id,
      reporterId: reporter.id,
      category: "spam",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") expect(result.report.reason).toBeNull();
  });
});

describe("limiares por gravidade", () => {
  it("limiares: basic 10, medium 5, high 3", () => {
    expect(REPORT_THRESHOLDS).toEqual({ basic: 10, medium: 5, high: 3 });
  });

  it.each([
    ["spam", "basic"],
    ["offensive", "medium"],
    ["doctrine", "high"],
  ] as const)(
    "%s escala exactamente ao atingir o limiar da gravidade %s",
    async (category, severity) => {
      const db = await getTestDb();
      const author = await makeUser();
      const post = await makePost(author.id);
      const repo = reportsRepo(db);
      const limit = REPORT_THRESHOLDS[severity];

      for (let i = 1; i <= limit; i++) {
        const reporter = await makeValidReporter();
        const result = await repo.file({
          postId: post.id,
          reporterId: reporter.id,
          category,
        });
        if (result.outcome !== "created") throw new Error("esperava created");
        expect(result.validReportsBySeverity[severity]).toBe(i);
        expect(result.escalated).toBe(i === limit);
        expect(result.escalatedBy).toBe(i === limit ? severity : null);
      }

      const row = await postRow(post.id);
      expect(row.status).toBe("pending_review");
      expect(row.reviewFlags).toEqual([`reports_${severity}`]);
    },
  );

  it("as gravidades não se somam: 9 básicas + 4 médias + 2 graves não escalam", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const plan = [
      ...Array<ReportCategory>(9).fill("spam"),
      ...Array<ReportCategory>(4).fill("offensive"),
      ...Array<ReportCategory>(2).fill("doctrine"),
    ];
    for (const category of plan) {
      const reporter = await makeValidReporter();
      const result = await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        category,
      });
      if (result.outcome !== "created") throw new Error("esperava created");
      expect(result.escalated).toBe(false);
    }
    expect((await postRow(post.id)).status).toBe("published");
  });

  it("depois de escalar, o post deixa de ser denunciável (sem dupla escalada)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const rules = { thresholds: { high: 1 } };
    const first = await repo.file(
      {
        postId: post.id,
        reporterId: (await makeValidReporter()).id,
        category: "doctrine",
      },
      rules,
    );
    expect(first.outcome === "created" && first.escalated).toBe(true);
    // O post já não está publicado: novas denúncias são post_not_found.
    const second = await repo.file(
      {
        postId: post.id,
        reporterId: (await makeValidReporter()).id,
        category: "doctrine",
      },
      rules,
    );
    expect(second.outcome).toBe("post_not_found");
  });
});

describe("reportador válido", () => {
  it("só com partilhas pendentes, ocultas ou rejeitadas não conta", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);

    for (const status of ["pending_review", "hidden", "rejected"] as const) {
      const reporter = await makeUser({
        createdAt: new Date(Date.now() - 30 * DAY_MS),
      });
      await makePost(reporter.id, { status });
      const result = await repo.file({
        postId: post.id,
        reporterId: reporter.id,
        category: "doctrine",
      });
      if (result.outcome !== "created") throw new Error("esperava created");
      expect(result.validReports).toBe(0);
    }
    expect((await postRow(post.id)).status).toBe("published");
  });

  it("partilha apagada pelo autor deixa de contar", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const reporter = await makeUser({
      createdAt: new Date(Date.now() - 30 * DAY_MS),
    });
    const own = await makePost(reporter.id);
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, own.id));

    const result = await reportsRepo(db).file({
      postId: post.id,
      reporterId: reporter.id,
      category: "spam",
    });
    if (result.outcome !== "created") throw new Error("esperava created");
    expect(result.validReports).toBe(0);
  });
});

describe("posts apagados e denúncias retiradas", () => {
  it("post apagado não é denunciável (post_not_found)", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const reporter = await makeUser();
    const post = await makePost(author.id);
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, post.id));
    const result = await reportsRepo(db).file({
      postId: post.id,
      reporterId: reporter.id,
      category: "spam",
    });
    expect(result.outcome).toBe("post_not_found");
  });

  it("denúncia retirada não conta para o limiar nem pode ser retirada outra vez", async () => {
    const db = await getTestDb();
    const author = await makeUser();
    const post = await makePost(author.id);
    const repo = reportsRepo(db);
    const reporter = await makeValidReporter();
    const result = await repo.file({
      postId: post.id,
      reporterId: reporter.id,
      category: "doctrine",
    });
    if (result.outcome !== "created") throw new Error("esperava created");

    expect(await repo.cancel(result.report.id, reporter.id)).toBe(true);
    expect(await repo.cancel(result.report.id, reporter.id)).toBe(false);

    const [row] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, result.report.id));
    expect(row?.status).toBe("withdrawn");

    // Duas válidas novas: 2 < 3, e a retirada não conta como terceira.
    for (let i = 0; i < 2; i++) {
      const other = await makeValidReporter();
      const r = await repo.file({
        postId: post.id,
        reporterId: other.id,
        category: "doctrine",
      });
      if (r.outcome !== "created") throw new Error("esperava created");
      expect(r.escalated).toBe(false);
      expect(r.validReportsBySeverity.high).toBe(i + 1);
    }
  });
});
