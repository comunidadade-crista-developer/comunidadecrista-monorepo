import {
  CardSlugParams,
  GospelCardListResponse,
  GospelCardResponse,
  ErrorResponse,
  MAX_CARDS_PER_RESPONSE,
} from '@comunidade/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CardsCache } from '../cache/cards-cache.js';
import type { RateLimiters } from '../auth/rate-limit.js';

const CACHE_CONTROL_PUBLIC = 'public, max-age=60, stale-while-revalidate=300';

export interface CardsRoutesOptions {
  cache: CardsCache;
  limiters: RateLimiters;
}

export async function cardsRoutes(
  app: FastifyInstance,
  { cache, limiters }: CardsRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/gospel-cards',
    { schema: { response: { 200: GospelCardListResponse } } },
    async (request, reply) => {
      const rl = await limiters.checkCardsPublic(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const all = await cache.list();
      const cards = all.slice(0, MAX_CARDS_PER_RESPONSE);

      if (all.length > MAX_CARDS_PER_RESPONSE) {
        request.log.warn(
          { total: all.length, served: MAX_CARDS_PER_RESPONSE },
          'cards: list truncated — review seed size',
        );
      }

      reply.header('Cache-Control', CACHE_CONTROL_PUBLIC);
      return reply.code(200).send({ cards });
    },
  );

  f.get(
    '/gospel-cards/:slug',
    {
      schema: {
        params: CardSlugParams,
        response: { 200: GospelCardResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkCardsPublic(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rl.retryAfter ?? 60))
          .send({ error: 'rate_limited' });
      }

      const card = await cache.bySlug(request.params.slug);
      if (!card) {
        return reply.code(404).send({ error: 'not_found' });
      }

      reply.header('Cache-Control', CACHE_CONTROL_PUBLIC);
      return reply.code(200).send({ card });
    },
  );
}