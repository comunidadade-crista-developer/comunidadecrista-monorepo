import { uuidv7 } from "uuidv7";
import type { NewPost, NewUser, Post, User } from "../../src/db/schema.js";
import { postsRepo, postLikesRepo } from "../../src/repositories/posts.js";
import { usersRepo } from "../../src/repositories/users.js";
import { createPasswordService } from "../../src/auth/password.js";
import { createRecoveryService } from "../../src/auth/recovery.js";
import { loadEnv } from "../../src/env.js";
import { getTestDb } from "./db.js";

const testEnv = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "fatal" });
const passwordService = createPasswordService(testEnv);
const recoveryService = createRecoveryService(passwordService);

let userCounter = 0;

export async function makeUser(
  overrides: Partial<NewUser> = {},
): Promise<User> {
  const db = await getTestDb();
  userCounter += 1;
  const username = overrides.username ?? `utilizador${userCounter}`;
  return usersRepo(db).create({
    username,
    passwordHash: "$argon2id$test",
    recoveryCodeHash: "$argon2id$test",
    securityQ1Hash: "$argon2id$test",
    securityQ2Hash: "$argon2id$test",
    securityQ3Hash: "$argon2id$test",
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
    category: "entendimento",
    title: "Partilha de teste",
    content: "Conteúdo de teste.",
    status: "published",
    ...overrides,
  });
}

export async function makeLike(postId: string, userId: string): Promise<void> {
  const db = await getTestDb();
  await postLikesRepo(db).like(postId, userId);
}

export interface MakeUserWithPasswordOptions {
  username?: string;
  password?: string;
  answers?: { q1: string; q2: string; q3: string };
  role?: "user" | "admin";
}

export async function makeUserWithPassword(
  opts: MakeUserWithPasswordOptions = {},
): Promise<{
  user: User;
  plainPassword: string;
  answers: { q1: string; q2: string; q3: string };
  recoveryCode: string;
}> {
  const db = await getTestDb();
  const plainPassword = opts.password ?? "password123";
  const answers = opts.answers ?? {
    q1: "Azul",
    q2: "7",
    q3: "Igreja da Graça",
  };

  const [passwordHash, q1, q2, q3] = await Promise.all([
    passwordService.hashPassword(plainPassword),
    passwordService.hashAnswer(answers.q1),
    passwordService.hashAnswer(answers.q2),
    passwordService.hashAnswer(answers.q3),
  ]);
  const code = recoveryService.generate();
  const recoveryCodeHash = await recoveryService.hashCode(code.canonical);

  userCounter += 1;
  const user = await usersRepo(db).create({
    username: opts.username ?? `utilizador${userCounter}`,
    passwordHash,
    recoveryCodeHash,
    securityQ1Hash: q1,
    securityQ2Hash: q2,
    securityQ3Hash: q3,
    avatarSeed: `seed-${uuidv7()}`,
    role: opts.role ?? "user",
  });

  return { user, plainPassword, answers, recoveryCode: code.formatted };
}
