import type { PostPublic } from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import type { FeedPage } from "../cache/feed-cache.js";
import { postLikesRepo } from "../repositories/posts.js";

export async function decorateForViewer(
  page: Pick<FeedPage, "posts" | "authorIds">,
  viewerId: string | undefined,
  exec: Executor,
): Promise<PostPublic[]> {
  if (!viewerId || page.posts.length === 0) return [...page.posts];
  const liked = new Set(
    await postLikesRepo(exec).findLikedPostIds(
      viewerId,
      page.posts.map((p) => p.id),
    ),
  );
  return page.posts.map((p, i) => ({
    ...p,
    isLiked: liked.has(p.id),
    isMine: page.authorIds[i] === viewerId,
  }));
}
