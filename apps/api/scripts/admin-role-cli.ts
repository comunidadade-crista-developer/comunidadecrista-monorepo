import { Username } from "@comunidade/shared";
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/env.js";
import {
  demoteAdmin,
  promoteAdmin,
  type RoleChangeResult,
} from "../src/services/admin-roles.js";

export const EXIT = { ok: 0, usage: 1, notFound: 2, refused: 3 } as const;

function describe(
  kind: "promote" | "demote",
  username: string,
  r: RoleChangeResult,
): { message: string; code: number } {
  if (r.ok) {
    switch (r.data.outcome) {
      case "promoted":
        return {
          message: `"${username}" promovido a admin. As sessões existentes foram revogadas (tem de iniciar sessão de novo).`,
          code: EXIT.ok,
        };
      case "already_admin":
        return {
          message: `"${username}" já é admin. Nada a fazer.`,
          code: EXIT.ok,
        };
      case "demoted":
        return {
          message: `"${username}" deixou de ser admin. As sessões existentes foram revogadas.`,
          code: EXIT.ok,
        };
      case "already_user":
        return {
          message: `"${username}" não é admin. Nada a fazer.`,
          code: EXIT.ok,
        };
    }
  }
  switch (r.error.code) {
    case "not_found":
      return {
        message: `O utilizador "${username}" não existe.`,
        code: EXIT.notFound,
      };
    case "inactive":
      return {
        message: `A conta "${username}" está em apagamento: não é possível ${kind === "promote" ? "promovê-la" : "alterá-la"}.`,
        code: EXIT.notFound,
      };
    case "last_admin":
      return {
        message: `Recusado: "${username}" é o último admin activo. Promove outro utilizador antes de o despromover.`,
        code: EXIT.refused,
      };
  }
}

export async function runRoleCommand(
  kind: "promote" | "demote",
): Promise<void> {
  const username = process.argv[2]?.trim();
  if (
    !username ||
    process.argv.length > 3 ||
    !Username.safeParse(username).success
  ) {
    console.error(
      `Uso: pnpm --filter @comunidade/api admin:${kind} <username>`,
    );
    process.exitCode = EXIT.usage;
    return;
  }

  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL não está definido.");
    process.exitCode = EXIT.usage;
    return;
  }

  const { db, pool } = createDb(env.DATABASE_URL, {
    poolMax: 2,
    applicationName: `admin-${kind}`,
  });
  try {
    const result =
      kind === "promote"
        ? await promoteAdmin(db, username)
        : await demoteAdmin(db, username);
    const { message, code } = describe(kind, username, result);
    (code === EXIT.ok ? console.log : console.error)(message);
    process.exitCode = code;
  } catch (err) {
    // Sem a mensagem do erro: pode trazer dados. O nome e o código bastam para diagnosticar.
    console.error(
      "Erro inesperado:",
      err instanceof Error ? err.name : typeof err,
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "",
    );
    process.exitCode = EXIT.usage;
  } finally {
    await pool.end().catch(() => {});
  }
}
