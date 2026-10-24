import { buildServer } from './server.js';
import { loadEnv } from './env.js';

const env = loadEnv();

const app = await buildServer({ env });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}