const MAX_CAUSE_DEPTH = 5;
const SQLSTATE = /^[0-9A-Z]{5}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Código SQLSTATE do Postgres (5 caracteres) do erro ou de uma das suas causas. */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    const code = current.code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

/**
 * Campos de log seguros para um erro: só nomes e código, nunca a mensagem, a query, os
 * parâmetros nem a stack (as mensagens dos erros do Postgres e do `new URL` trazem dados do
 * utilizador ou a connection string).
 */
export function safeErrorFields(err: unknown): {
  errorName: string;
  errorCode?: string;
  causeName?: string;
} {
  const nameOf = (e: unknown): string =>
    isRecord(e) && typeof e.name === "string" ? e.name : typeof e;

  let code: string | undefined;
  let current: unknown = err;
  let root: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    if (code === undefined && typeof current.code === "string") {
      code = current.code;
    }
    root = current;
    current = current.cause;
  }

  const out: { errorName: string; errorCode?: string; causeName?: string } = {
    errorName: nameOf(err),
  };
  if (code !== undefined) out.errorCode = code;
  if (root !== err) out.causeName = nameOf(root);
  return out;
}
