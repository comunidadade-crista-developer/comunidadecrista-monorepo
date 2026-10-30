import type { ErrorResponse } from "@comunidade/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Formato único de erro da API: `{ error: <código estável>, message?, fields? }`.
 *
 * - 5xx: o cliente só recebe `internal_error` (ou `service_unavailable`). Mensagens, SQL,
 *   valores e stack ficam fora da resposta E fora dos logs: os erros do Postgres trazem
 *   dados do utilizador na mensagem (ex.: «Key (username)=(x) already exists»).
 * - 4xx gerados pelo Fastify ou pelos plugins: código fixo por estado HTTP, sem repetir
 *   a mensagem original.
 * - Validação: `validation_error` + `fields` (campo → mensagem do schema).
 */

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  408: "request_timeout",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_entity",
  429: "rate_limited",
};

const MAX_FIELDS = 20;
const MAX_FIELD_MESSAGE = 200;
const MAX_LOG_FRAMES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function statusOf(error: unknown): number {
  if (isRecord(error)) {
    const status = error.statusCode ?? error.status;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return status;
    }
  }
  return 500;
}

function isValidationError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === "FST_ERR_VALIDATION" ||
    Array.isArray(error.validation) ||
    Array.isArray(error.issues)
  );
}

function joinPath(path: unknown): string {
  if (Array.isArray(path)) {
    const joined = path.map((p) => String(p)).join(".");
    return joined === "" ? "_" : joined;
  }
  if (typeof path === "string") {
    const joined = path.split("/").filter(Boolean).join(".");
    return joined === "" ? "_" : joined;
  }
  return "_";
}

/**
 * Extrai campo → mensagem dos erros de validação. Aceita as duas formas que o Fastify e o
 * type provider do zod produzem: `issues` (ZodError) e `validation` (lista estilo Ajv).
 * Só a primeira mensagem de cada campo; limitado em número e tamanho.
 */
export function collectFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!isRecord(error)) return fields;

  const add = (path: unknown, message: unknown) => {
    if (Object.keys(fields).length >= MAX_FIELDS) return;
    if (typeof message !== "string" || message === "") return;
    const key = joinPath(path);
    if (!(key in fields)) fields[key] = message.slice(0, MAX_FIELD_MESSAGE);
  };

  if (Array.isArray(error.issues)) {
    for (const issue of error.issues) {
      if (isRecord(issue)) add(issue.path, issue.message);
    }
  }
  if (Array.isArray(error.validation)) {
    for (const item of error.validation) {
      if (!isRecord(item)) continue;
      const params = isRecord(item.params) ? item.params : undefined;
      const issue = params && isRecord(params.issue) ? params.issue : undefined;
      if (issue) add(issue.path, issue.message);
      else add(item.instancePath, item.message);
    }
  }
  return fields;
}

/** Só frames da stack («at ...»): a 1.ª linha é a mensagem e pode ter dados do utilizador. */
function stackFrames(error: unknown): string[] {
  if (!isRecord(error) || typeof error.stack !== "string") return [];
  return error.stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, MAX_LOG_FRAMES)
    .map((line) => line.trim());
}

function body(error: string, fields?: Record<string, string>): ErrorResponse {
  return fields && Object.keys(fields).length > 0
    ? { error, fields }
    : { error };
}

export function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const status = statusOf(error);

  if (status >= 500) {
    // Sem mensagem nem valores: só o suficiente para diagnosticar.
    request.log.error(
      {
        errorName: isRecord(error)
          ? String(error.name ?? "Error")
          : typeof error,
        errorCode:
          isRecord(error) && typeof error.code === "string"
            ? error.code
            : undefined,
        statusCode: status,
        method: request.method,
        route: request.routeOptions?.url,
        frames: stackFrames(error),
      },
      "unhandled error",
    );
    return reply
      .code(status)
      .send(body(status === 503 ? "service_unavailable" : "internal_error"));
  }

  if (status === 400 && isValidationError(error)) {
    return reply.code(400).send(body("validation_error", collectFields(error)));
  }

  return reply.code(status).send(body(CODE_BY_STATUS[status] ?? "bad_request"));
}

export function notFoundHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return reply.code(404).send(body("not_found"));
}
