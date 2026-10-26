import { loadEnv } from "../env.js";
import { runMigrations } from "./migrate.js";

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL não está definido.");
  process.exit(1);
}

await runMigrations(env.DATABASE_URL);
console.log("Migrações aplicadas com sucesso.");
