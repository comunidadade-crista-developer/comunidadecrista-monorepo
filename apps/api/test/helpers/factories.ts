import { uuidv7 } from 'uuidv7';
import type { NewPost, NewUser, Post, User } from '../../src/db/schema.js';
import { postsRepo, postLikesRepo } from '../../src/repositories/posts.js';
import { usersRepo } from '../../src/repositories/users.js';
import { getTestDb } from './db.js';

let userCounter = 0;

export async function makeUser(overrides: Partial<NewUser> = {}): Promise<User> {
  const db = await getTestDb();
  userCounter += 1;
  const username = overrides.username ?? `utilizador${userCounter}`;
  return usersRepo(db).create({
    username,
    passwordHash: '$argon2id$test',
    recoveryCodeHash: '$argon2id$test',
    securityQ1Hash: '$argon2id$test',
    securityQ2Hash: '$argon2id$test',
    securityQ3Hash: '$argon2id$test',
    avatarSeed: `seed-${uuidv7()}`,
    ...overrides,
  });
}

export async function makePost(
  authorId: string,
  overrides: Partial<NewPost> = {},
): Promise<Post> {
  const db = await getTestDb();
  return postsRepo(db).create({
    authorId,
    category: 'entendimento',
    title: 'Partilha de teste',
    content: 'Conteúdo de teste.',
    status: 'published',
    ...overrides,
  });
}

export async function makeLike(postId: string, userId: string): Promise<void> {
  const db = await getTestDb();
  await postLikesRepo(db).like(postId, userId);
}