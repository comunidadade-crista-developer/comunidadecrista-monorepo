import { createHash } from "node:crypto";
import {
  checkContent,
  CreatePostResponse,
  flagCodes,
} from "@comunidade/shared";
import type {
  PostCategory,
  ReportCategory,
  ReportOutcome,
  ReportSeverity,
} from "@comunidade/shared";
import type { Executor } from "../db/client.js";
import { cardsRepo } from "../repositories/cards.js";
import { idempotencyKeysRepo, outboxRepo } from "../repositories/outbox.js";
import { postLikesRepo, postsRepo } from "../repositories/posts.js";
import { reportsRepo } from "../repositories/reports.js";
import { usersRepo } from "../repositories/users.js";
import { presentOne } from "./post-presenter.js";

export interface ServicesDeps {
  /**
   * O pool ou uma transacção já aberta. Cada serviço corre na sua própria transacção (dentro
   * de uma transacção aberta passa a ser um savepoint): tudo o que o serviço escreve — post,
   * chave de idempotência, evento de outbox, contadores — fica ou desaparece junto.
   */
  db: Executor;
}

export type ServiceError =
  | { code: "not_found"; status: 404 }
  | { code: "forbidden"; status: 403 }
  /** A conta está em apagamento (ou já foi apagada): não pode escrever. */
  | { code: "account_inactive"; status: 403 }
  | { code: "own_post"; status: 400 }
  | { code: "idempotency_key_conflict"; status: 409 }
  | { code: "gospel_card_not_found"; status: 400 }
  | { code: "contains_link"; status: 400 }
  | { code: "contains_contact"; status: 400 }
  | { code: "reason_required"; status: 400 };

export type ServiceResult<T, E extends ServiceError = ServiceError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

type ErrorOf<C extends ServiceError["code"]> = Extract<
  ServiceError,
  { code: C }
>;

function fail<C extends ServiceError["code"]>(
  code: C,
): { ok: false; error: ErrorOf<C> } {
  const status = {
    not_found: 404,
    forbidden: 403,
    account_inactive: 403,
    own_post: 400,
    idempotency_key_conflict: 409,
    gospel_card_not_found: 400,
    contains_link: 400,
    contains_contact: 400,
    reason_required: 400,
  }[code];
  return { ok: false, error: { code, status } as ErrorOf<C> };
}

/**
 * Escrever exige conta activa: sem apagamento pendente e não apagada. É uma leitura por chave
 * primária, feita a cada escrita (as leituras públicas não pagam este custo), por isso o
 * bloqueio é imediato — não espera pela expiração do token de acesso.
 */
async function isAccountActive(
  exec: Executor,
  userId: string,
): Promise<boolean> {
  const user = await usersRepo(exec).findById(userId);
  return user !== null && user.deletionRequestedAt === null;
}

// ---------- Criar ----------

export interface CreatePostInput {
  category: PostCategory;
  title: string;
  content: string;
  gospelCardSlug?: string | undefined;
}

/** `replayed`: a resposta veio de um pedido anterior com a mesma chave (nada foi criado agora). */
export type CreatePostData = CreatePostResponse & { replayed: boolean };

type CreatePostError = ErrorOf<
  | "account_inactive"
  | "gospel_card_not_found"
  | "idempotency_key_conflict"
  | "contains_link"
  | "contains_contact"
>;

const CREATE_OPERATION = "post.create";

/** SHA-256 da operação e do corpo, com as chaves em ordem fixa. */
function hashCreateRequest(input: CreatePostInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CREATE_OPERATION,
        input.category,
        input.title,
        input.content,
        input.gospelCardSlug ?? null,
      ]),
    )
    .digest("hex");
}

/**
 * A chave já existe: é uma repetição (mesma operação e mesmo corpo → repete a resposta) ou
 * um erro do cliente (mesma chave, outro pedido → 409). Nunca cria nada.
 */
async function resolveExistingKey(
  exec: Executor,
  userId: string,
  key: string,
  requestHash: string,
): Promise<ServiceResult<CreatePostData, CreatePostError> | null> {
  const row = await idempotencyKeysRepo(exec).get(userId, key);
  if (!row) return null;
  if (row.operation !== CREATE_OPERATION || row.requestHash !== requestHash) {
    return fail("idempotency_key_conflict");
  }
  // Guardámo-la nós, mas valida-se na mesma: um valor estragado dá 500, nunca uma resposta falsa.
  const stored = CreatePostResponse.parse(row.response);
  return { ok: true, data: { ...stored, replayed: true } };
}

export async function createPostService(
  deps: ServicesDeps,
  userId: string,
  input: CreatePostInput,
  idempotencyKey: string,
): Promise<ServiceResult<CreatePostData, CreatePostError>> {
  return deps.db.transaction<ServiceResult<CreatePostData, CreatePostError>>(
    async (tx) => {
      if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

      const requestHash = hashCreateRequest(input);
      const earlier = await resolveExistingKey(
        tx,
        userId,
        idempotencyKey,
        requestHash,
      );
      if (earlier) return earlier;

      const check = checkContent(input.title, input.content);
      if (check.reject) {
        const code =
          check.violations[0]?.kind === "link"
            ? "contains_link"
            : "contains_contact";
        return fail(code);
      }
      const flags = flagCodes(check);

      let gospelCardId: string | null = null;
      if (input.gospelCardSlug) {
        const card = await cardsRepo(tx).findBySlug(input.gospelCardSlug);
        if (!card) return fail("gospel_card_not_found");
        gospelCardId = card.id;
      }

      // Reserva ANTES de criar: dois pedidos concorrentes com a mesma chave não criam dois posts.
      // O segundo espera aqui pelo primeiro e, quando este faz commit, vê a chave como existente.
      const reservation = await idempotencyKeysRepo(tx).reserve({
        userId,
        key: idempotencyKey,
        operation: CREATE_OPERATION,
        requestHash,
      });
      if (reservation === "exists") {
        const concurrent = await resolveExistingKey(
          tx,
          userId,
          idempotencyKey,
          requestHash,
        );
        return concurrent ?? fail("idempotency_key_conflict");
      }

      const post = await postsRepo(tx).create({
        authorId: userId,
        category: input.category,
        title: input.title,
        content: input.content,
        status: flags.length > 0 ? "pending_review" : "published",
        reviewFlags: flags.length > 0 ? flags : null,
        gospelCardId,
      });

      const response: CreatePostResponse = {
        post: await presentOne(post, tx, userId),
        status: post.status,
      };
      await idempotencyKeysRepo(tx).complete(userId, idempotencyKey, response);
      await outboxRepo(tx).enqueue({
        aggregateType: "post",
        aggregateId: post.id,
        eventType: "post.created",
        payload: { postId: post.id, authorId: userId, status: post.status },
      });

      return { ok: true, data: { ...response, replayed: false } };
    },
  );
}

// ---------- Apagar ----------

type DeletePostError = ErrorOf<"not_found" | "account_inactive">;

/**
 * Apaga (soft delete) um post do próprio autor. Idempotente: apagar outra vez devolve
 * sucesso com `changed: false`. Quem não é o autor recebe o mesmo `not_found` que um post
 * inexistente — não se confirma a existência de posts alheios.
 */
export async function deletePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
): Promise<
  ServiceResult<{ deleted: true; changed: boolean }, DeletePostError>
> {
  return deps.db.transaction<
    ServiceResult<{ deleted: true; changed: boolean }, DeletePostError>
  >(async (tx) => {
    if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

    const posts = postsRepo(tx);
    const post = await posts.findById(postId, { includeDeleted: true });
    if (!post || post.authorId !== userId) return fail("not_found");

    const changed = await posts.softDelete(postId, userId);
    if (changed) {
      await outboxRepo(tx).enqueue({
        aggregateType: "post",
        aggregateId: postId,
        eventType: "post.deleted",
        payload: { postId },
      });
    }
    return { ok: true, data: { deleted: true, changed } };
  });
}

// ---------- Likes ----------

export interface LikeData {
  likesCount: number;
  isLiked: boolean;
  /** `false` quando já estava assim (curtir um post já curtido, descurtir um não curtido). */
  changed: boolean;
}

type LikeError = ErrorOf<"not_found" | "account_inactive">;

export async function likePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
): Promise<ServiceResult<LikeData, LikeError>> {
  return deps.db.transaction<ServiceResult<LikeData, LikeError>>(async (tx) => {
    if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

    const posts = postsRepo(tx);
    const post = await posts.findById(postId);
    if (!post || post.status !== "published") return fail("not_found");

    const inserted = await postLikesRepo(tx).like(postId, userId);
    // O contador sobe na mesma transacção que o like: nunca fica desalinhado.
    const likesCount = inserted
      ? await posts.incrementLikes(postId, 1)
      : post.likesCount;
    if (inserted) {
      await outboxRepo(tx).enqueue({
        aggregateType: "post",
        aggregateId: postId,
        eventType: "post.liked",
        payload: { postId, userId },
      });
    }
    return { ok: true, data: { likesCount, isLiked: true, changed: inserted } };
  });
}

export async function unlikePostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
): Promise<ServiceResult<LikeData, LikeError>> {
  return deps.db.transaction<ServiceResult<LikeData, LikeError>>(async (tx) => {
    if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

    const posts = postsRepo(tx);
    // Descurtir é permitido em qualquer estado (o utilizador pode querer retirar o like de um
    // post entretanto oculto), mas não num post apagado.
    const post = await posts.findById(postId);
    if (!post) return fail("not_found");

    const removed = await postLikesRepo(tx).unlike(postId, userId);
    const likesCount = removed
      ? await posts.incrementLikes(postId, -1)
      : post.likesCount;
    if (removed) {
      await outboxRepo(tx).enqueue({
        aggregateType: "post",
        aggregateId: postId,
        eventType: "post.unliked",
        payload: { postId, userId },
      });
    }
    return {
      ok: true,
      data: { likesCount, isLiked: false, changed: removed },
    };
  });
}

// ---------- Denúncias ----------

type ReportPostError = ErrorOf<
  "own_post" | "not_found" | "reason_required" | "account_inactive"
>;

export async function reportPostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
  category: ReportCategory,
  reason: string | undefined,
): Promise<
  ServiceResult<{ outcome: ReportOutcome; changed: boolean }, ReportPostError>
> {
  // Rede de segurança: o schema da rota já exige o motivo para «other».
  const trimmed = reason?.trim();
  if (category === "other" && (!trimmed || trimmed.length < 3)) {
    return fail("reason_required");
  }

  return deps.db.transaction<
    ServiceResult<{ outcome: ReportOutcome; changed: boolean }, ReportPostError>
  >(async (tx) => {
    if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

    const result = await reportsRepo(tx).file({
      postId,
      reporterId: userId,
      category,
      reason: trimmed ?? null,
    });

    switch (result.outcome) {
      case "created": {
        await outboxRepo(tx).enqueue({
          aggregateType: "post",
          aggregateId: postId,
          eventType: "post.reported",
          payload: { postId, reporterId: userId, category },
        });
        if (result.escalated && result.escalatedBy) {
          const severity: ReportSeverity = result.escalatedBy;
          await outboxRepo(tx).enqueue({
            aggregateType: "post",
            aggregateId: postId,
            eventType: "post.escalated",
            payload: { postId, severity },
          });
        }
        return { ok: true, data: { outcome: "created", changed: true } };
      }
      case "duplicate":
        return { ok: true, data: { outcome: "duplicate", changed: false } };
      case "own_post":
        return fail("own_post");
      case "post_not_found":
        return fail("not_found");
    }
  });
}

type UnreportPostError = ErrorOf<"not_found" | "account_inactive">;

/**
 * Retira a denúncia do próprio utilizador. Idempotente: se já estava retirada (ou resolvida
 * pelo moderador) devolve sucesso com `changed: false`; só é `not_found` se nunca denunciou.
 */
export async function unreportPostService(
  deps: ServicesDeps,
  userId: string,
  postId: string,
): Promise<
  ServiceResult<{ withdrawn: true; changed: boolean }, UnreportPostError>
> {
  return deps.db.transaction<
    ServiceResult<{ withdrawn: true; changed: boolean }, UnreportPostError>
  >(async (tx) => {
    if (!(await isAccountActive(tx, userId))) return fail("account_inactive");

    const reports = reportsRepo(tx);
    const open = await reports.findOpenByPostAndReporter(postId, userId);
    if (open) {
      const changed = await reports.cancel(open.id, userId);
      return { ok: true, data: { withdrawn: true, changed } };
    }
    const earlier = await reports.findByPostAndReporter(postId, userId);
    if (earlier) return { ok: true, data: { withdrawn: true, changed: false } };
    return fail("not_found");
  });
}
