import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { gospelCards } from "../db/schema.js";
import type { GospelCard, NewGospelCard } from "../db/schema.js";

export function cardsRepo(db: Database) {
  return {
    async list(): Promise<GospelCard[]> {
      return db.select().from(gospelCards).orderBy(asc(gospelCards.orderIndex));
    },

    async findBySlug(slug: string): Promise<GospelCard | null> {
      const [row] = await db
        .select()
        .from(gospelCards)
        .where(eq(gospelCards.slug, slug))
        .limit(1);
      return row ?? null;
    },

    async findBySlugs(slugs: string[]): Promise<GospelCard[]> {
      if (slugs.length === 0) return [];
      return db
        .select()
        .from(gospelCards)
        .where(inArray(gospelCards.slug, slugs));
    },

    async create(data: NewGospelCard): Promise<GospelCard> {
      const [row] = await db.insert(gospelCards).values(data).returning();
      return row!;
    },

    async upsertBySlug(data: NewGospelCard): Promise<GospelCard> {
      const [row] = await db
        .insert(gospelCards)
        .values(data)
        .onConflictDoUpdate({
          target: gospelCards.slug,
          set: conflictSet(data),
        })
        .returning();
      return row!;
    },

    async upsertMany(
      items: NewGospelCard[],
    ): Promise<{ created: number; updated: number }> {
      if (items.length === 0) return { created: 0, updated: 0 };
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({ slug: gospelCards.slug })
          .from(gospelCards)
          .where(
            inArray(
              gospelCards.slug,
              items.map((i) => i.slug),
            ),
          );
        const known = new Set(existing.map((r) => r.slug));
        for (const data of items) {
          await tx
            .insert(gospelCards)
            .values(data)
            .onConflictDoUpdate({
              target: gospelCards.slug,
              set: conflictSet(data),
            });
        }
        const updated = items.filter((i) => known.has(i.slug)).length;
        return { created: items.length - updated, updated };
      });
    },
  };
}

function conflictSet(data: NewGospelCard) {
  return {
    title: data.title,
    gospelReference: data.gospelReference,
    summary: data.summary,
    otReferences: data.otReferences,
    ntReferences: data.ntReferences,
    orderIndex: data.orderIndex,
  };
}
