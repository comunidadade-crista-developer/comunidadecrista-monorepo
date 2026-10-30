import { buildServer } from "./server.js";
import { loadEnv } from "./env.js";

const env = loadEnv();

const app = await buildServer({ env });

// Se o fecho travar (ligações penduradas), sai mesmo assim: a plataforma acabaria por
// matar o processo, mas assim fica registado.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  setTimeout(() => {
    app.log.error("shutdown timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app.close();
    process.exit(exitCode);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Estado do processo incerto: regista (só o tipo, a mensagem pode ter dados do utilizador),
// fecha com cuidado e sai com erro para o supervisor reiniciar.
for (const event of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(event, (reason: unknown) => {
    app.log.fatal(
      { errorName: reason instanceof Error ? reason.name : typeof reason },
      event,
    );
    void shutdown(event, 1);
  });
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, env: env.NODE_ENV }, "server listening");
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
