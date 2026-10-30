import type { PostPublic } from '@comunidade/shared';
import type { Database } from '../db/client.js';
import type { Post } from '../db/schema.js';
import { cardsRepo } from '../repositories/cards.js';
import { usersRepo } from '../repositories/users.js';

export async function presentPosts(posts: Post[], db: Database): Promise<PostPublic[]> {
  if (posts.length === 0) return [];

  const authorIds = Array.from(
    new Set(posts.map((p) => p.authorId).filter((id): id is string => id !== null)),
  );
  const cardIds = Array.from(
    new Set(posts.map((p) => p.gospelCardId).filter((id): id is string => id !== null)),
  );

  const [authors, cards] = await Promise.all([
    usersRepo(db).findManyByIds(authorIds),
    cardIds.length > 0 ? fetchCardsByIds(db, cardIds) : Promise.resolve([]),
  ]);

  const authorMap = new Map(authors.map((a) => [a.id, a]));
  const cardSlugMap = new Map(cards.map((c) => [c.id, c.slug]));

  return posts.map((p) => {
    let authorUsername = '[removido]';
    if (p.authorId) {
      const a = authorMap.get(p.authorId);
      if (a && !a.deletedAt) authorUsername = a.username;
    }

    return {
      id: p.id,
      category: p.category,
      title: p.title,
      content: p.content,
      status: p.status,
      likesCount: p.likesCount,
      isLiked: false,
      authorId: p.authorId,
      authorUsername,
      gospelCardSlug: p.gospelCardId ? (cardSlugMap.get(p.gospelCardId) ?? null) : null,
      createdAt: p.createdAt.toISOString(),
      publishedAt: p.publishedAt?.toISOString() ?? null,
    };
  });
}

export async function presentOne(post: Post, db: Database): Promise<PostPublic> {
  const [result] = await presentPosts([post], db);
  return result!;
}

async function fetchCardsByIds(db: Database, ids: string[]) {
  // O cardsRepo não tem findByIds; usa `list()` e filtra. Volume de cards é baixo.
  const all = await cardsRepo(db).list();
  const wanted = new Set(ids);
  return all.filter((c) => wanted.has(c.id));
}