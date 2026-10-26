import { z } from "zod";
export * from "./auth.js";

export const APP_NAME = "Comunidade Cristã" as const;
export const APP_AUTHOR = "Gekko Dreamers" as const;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
  timestamp: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const DeepHealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  timestamp: z.string().datetime(),
  checks: z.object({
    db: z.enum(["ok", "fail", "not_configured"]),
    redis: z.enum(["ok", "fail", "not_configured"]),
  }),
});
export type DeepHealthResponse = z.infer<typeof DeepHealthResponse>;
