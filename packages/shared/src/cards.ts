import { z } from 'zod';

export const MAX_CARDS_PER_RESPONSE = 200;

export const GospelCardPublic = z.object({
  slug: z.string(),
  title: z.string(),
  gospelReference: z.string(),
  summary: z.string(),
  otReferences: z.array(z.string()),
  ntReferences: z.array(z.string()),
  orderIndex: z.number().int(),
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

export const CardSlugParams = z.object({
  slug: z
    .string()
    .min(1, 'slug vazio')
    .max(100, 'slug demasiado longo')
    .regex(/^[a-z0-9-]+$/, 'slug inválido'),
});
export type CardSlugParams = z.infer<typeof CardSlugParams>;