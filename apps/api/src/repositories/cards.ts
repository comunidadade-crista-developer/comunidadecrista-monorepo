import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { gospelCards } from '../db/schema.js';
import type { GospelCard, NewGospelCard } from '../db/schema.js';

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
        return db.select().from(gospelCards).where(inArray(gospelCards.slug, slugs));
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
          set: {
            title: data.title,
            gospelReference: data.gospelReference,
            summary: data.summary,
            otReferences: data.otReferences,
            ntReferences: data.ntReferences,
            orderIndex: data.orderIndex,
          },
        })
        .returning();
      return row!;
    },
  };
}

//