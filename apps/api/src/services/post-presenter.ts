import type { PostPublic } from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import type { Post, User } from "../db/schema.js";
import { cardsRepo } from "../repositories/cards.js";
import { postLikesRepo } from "../repositories/posts.js";
import { usersRepo } from "../repositories/users.js";

/**
 * O autor só é mostrado se a conta existe e está activa e o post não foi mantido anónimo
 * (F5). Em qualquer outro caso o cliente recebe `null` («[removido]»): nem o nome nem o
 * identificador interno saem da API.
 */
function visibleAuthor(
  post: Post,
  author: User | undefined,
): { username: string } | null {
  if (post.authorHidden || post.authorId === null) return null;
  if (!author) return null;
  if (author.deletedAt !== null || author.deletionRequestedAt !== null) {
    return null;
  }
  return { username: author.username };
}

/**
 * Converte posts da base de dados no formato público. Corre na mesma ligação/transacção
 * que o chamador (`exec`) e faz no máximo 3 consultas por página, seja qual for o tamanho:
 * autores, cards e (se houver `viewerId`) likes do espectador.
 */
export async function presentPosts(
  posts: Post[],
  exec: Executor,
  viewerId?: string,
): Promise<PostPublic[]> {
  if (posts.length === 0) return [];

  const authorIds = [
    ...new Set(
      posts
        .filter((p) => !p.authorHidden)
        .map((p) => p.authorId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const cardIds = [
    ...new Set(
      posts
        .map((p) => p.gospelCardId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const [authors, cards, likedIds] = await Promise.all([
    usersRepo(exec).findManyByIds(authorIds),
    cardsRepo(exec).findByIds(cardIds),
    viewerId
      ? postLikesRepo(exec).findLikedPostIds(
          viewerId,
          posts.map((p) => p.id),
        )
      : Promise.resolve<string[]>([]),
  ]);

  const authorById = new Map(authors.map((a) => [a.id, a]));
  const slugByCardId = new Map(cards.map((c) => [c.id, c.slug]));
  const liked = new Set(likedIds);

  return posts.map((p) => ({
    id: p.id,
    category: p.category,
    title: p.title,
    content: p.content,
    status: p.status,
    likesCount: p.likesCount,
    isLiked: liked.has(p.id),
    isMine: viewerId !== undefined && p.authorId === viewerId,
    author: visibleAuthor(
      p,
      p.authorId ? authorById.get(p.authorId) : undefined,
    ),
    gospelCardSlug: p.gospelCardId
      ? (slugByCardId.get(p.gospelCardId) ?? null)
      : null,
    createdAt: p.createdAt.toISOString(),
    publishedAt: p.publishedAt?.toISOString() ?? null,
  }));
}

export async function presentOne(
  post: Post,
  exec: Executor,
  viewerId?: string,
): Promise<PostPublic> {
  const [result] = await presentPosts([post], exec, viewerId);
  return result!;
}
