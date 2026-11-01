import { z } from "zod";

export const MAX_GOSPEL_CARDS = 200;

const Reference = z.string().min(1).max(100);

export const CardSlug = z
  .string()
  .min(1, "slug vazio")
  .max(100, "slug demasiado longo")
  .regex(/^[a-z0-9-]+$/, "slug inválido");

export const GospelCardPublic = z.object({
  slug: CardSlug,
  title: z.string().min(1).max(200),
  gospelReference: z.string().min(1).max(100),
  summary: z.string().min(1).max(1000),
  otReferences: z.array(Reference).max(50),
  ntReferences: z.array(Reference).max(50),
  orderIndex: z.number().int().min(0),
});
export type GospelCardPublic = z.infer<typeof GospelCardPublic>;

export const GospelCardListResponse = z.object({
  cards: z.array(GospelCardPublic),
});
export type GospelCardListResponse = z.infer<typeof GospelCardListResponse>;

export const GospelCardResponse = z.object({
  card: GospelCardPublic,
});
export type GospelCardResponse = z.infer<typeof GospelCardResponse>;

export const CardSlugParams = z.object({ slug: CardSlug });
export type CardSlugParams = z.infer<typeof CardSlugParams>;

export const GospelCardsSeedFile = z
  .array(GospelCardPublic)
  .min(1, "o ficheiro de seed está vazio")
  .max(MAX_GOSPEL_CARDS, `no máximo ${MAX_GOSPEL_CARDS} cards`)
  .superRefine((cards, ctx) => {
    const slugs = new Set<string>();
    const orders = new Set<number>();
    cards.forEach((card, index) => {
      if (slugs.has(card.slug)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "slug"],
          message: `slug repetido: ${card.slug}`,
        });
      }
      slugs.add(card.slug);
      if (orders.has(card.orderIndex)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "orderIndex"],
          message: `orderIndex repetido: ${card.orderIndex}`,
        });
      }
      orders.add(card.orderIndex);
    });
  });
