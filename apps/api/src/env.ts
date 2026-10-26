import "dotenv/config";
import { z } from "zod";

// Aceita boolean (overrides em testes) e string ('true' / 'false') vinda de process.env.
const booleanFromEnv = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "true");

// Segredos opcionais: string vazia (ex.: "CF_ORIGIN_SECRET=" no .env) conta como ausente.
const optionalSecret = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().min(32, "tem de ter pelo menos 32 caracteres").optional(),
);

const BaseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  APP_VERSION: z.string().default("dev"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Proxy genérico (VPS, Fly, etc.). Não usar em conjunto com EDGE_MODE=cloudflare.
  TRUST_PROXY: booleanFromEnv,
  // Nº de proxies de confiança entre o cliente e a API (só com TRUST_PROXY=true).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),

  // Cloudflare à frente da API. Em 'cloudflare' a API só aceita pedidos que tragam o
  // cabeçalho X-Origin-Auth (injectado por uma Transform Rule) e lê o IP em CF-Connecting-IP.
  EDGE_MODE: z.enum(["none", "cloudflare"]).default("none"),
  CF_ORIGIN_SECRET: optionalSecret,
  // Segredo anterior, aceite durante uma rotação sem downtime.
  CF_ORIGIN_SECRET_PREVIOUS: optionalSecret,

  // Segredo do HMAC que anonimiza IP/username nas chaves do rate limit (Redis).
  IP_HASH_SECRET: optionalSecret,

  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  JWT_PRIVATE_JWK: z.string().optional(),
  JWT_PUBLIC_JWK: z.string().optional(),
  JWT_ISSUER: z.string().default("comunidade-crista"),
  JWT_AUDIENCE: z.string().default("comunidade-crista-api"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RECOVERY_SESSION_TTL: z.string().default("5m"),
  // Atraso até uma recuperação por perguntas de segurança produzir efeito.
  RECOVERY_QUESTIONS_DELAY_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),

  ARGON2_MEMORY_KB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_S: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REGISTER_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  RATE_LIMIT_RECOVER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_RECOVER_WINDOW_S: z.coerce.number().int().positive().default(3600),
  // Limites que não dependem de o atacante usar sempre o mesmo IP+utilizador.
  RATE_LIMIT_LOGIN_IP_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_LOGIN_IP_WINDOW_S: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_LOGIN_ACCOUNT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  RATE_LIMIT_RECOVER_IP_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RECOVER_IP_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(86400),
  RATE_LIMIT_RECOVER_ACCOUNT_CODE_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  RATE_LIMIT_RECOVER_ACCOUNT_CODE_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
});

const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  if (env.EDGE_MODE === "cloudflare" && !env.CF_ORIGIN_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CF_ORIGIN_SECRET"],
      message: "obrigatório quando EDGE_MODE=cloudflare",
    });
  }
  if (env.EDGE_MODE === "cloudflare" && env.TRUST_PROXY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TRUST_PROXY"],
      message: "não combinar TRUST_PROXY com EDGE_MODE=cloudflare",
    });
  }
  if (env.NODE_ENV === "production" && !env.IP_HASH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["IP_HASH_SECRET"],
      message: "obrigatório em produção",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    console.error(
      "Invalid environment variables:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment variables");
  }
  return parsed.data;
}
