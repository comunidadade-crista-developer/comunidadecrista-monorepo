import { createHash } from "node:crypto";
import {
  CardSlugParams,
  ErrorResponse,
  GospelCardListResponse,
  GospelCardResponse,
} from "@comunidade/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RateLimiters } from "../auth/rate-limit.js";
import type { CardsCache } from "../cache/cards-cache.js";

export const CARDS_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=86400";

export interface CardsRoutesOptions {
  cache: CardsCache;
  limiters: RateLimiters;
}

const etags = new WeakMap<object, string>();

export function etagOf(value: object): string {
  const known = etags.get(value);
  if (known) return known;
  const hash = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 27);
  const etag = `W/"${hash}"`;
  etags.set(value, etag);
  return etag;
}

export function matchesIfNoneMatch(
  header: string | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const current = strip(etag);
  return header.split(",").some((tag) => strip(tag) === current);
}

function notModified(reply: FastifyReply, etag: string): FastifyReply {
  return reply
    .code(304)
    .header("ETag", etag)
    .header("Cache-Control", CARDS_CACHE_CONTROL)
    .send();
}

export async function cardsRoutes(
  app: FastifyInstance,
  { cache, limiters }: CardsRoutesOptions,
): Promise<void> {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    "/gospel-cards",
    {
      schema: {
        response: { 200: GospelCardListResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkCardsPublic(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const cards = await cache.list();
      if (cards.length === 0) return reply.code(200).send({ cards });

      const etag = etagOf(cards);
      if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
        return notModified(reply as unknown as FastifyReply, etag);
      }

      reply.header("ETag", etag).header("Cache-Control", CARDS_CACHE_CONTROL);
      return reply.code(200).send({ cards });
    },
  );

  f.get(
    "/gospel-cards/:slug",
    {
      schema: {
        params: CardSlugParams,
        response: {
          200: GospelCardResponse,
          404: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const rl = await limiters.checkCardsPublic(request.clientIp);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(rl.retryAfter ?? 60))
          .send({ error: "rate_limited" });
      }

      const card = await cache.bySlug(request.params.slug);
      if (!card) return reply.code(404).send({ error: "not_found" });

      const etag = etagOf(card);
      if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
        return notModified(reply as unknown as FastifyReply, etag);
      }

      reply.header("ETag", etag).header("Cache-Control", CARDS_CACHE_CONTROL);
      return reply.code(200).send({ card });
    },
  );
}
