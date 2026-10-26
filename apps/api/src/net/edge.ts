import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../env.js";

/**
 * Cabeçalho injectado pela Cloudflare (Transform Rule) com um segredo partilhado.
 * É a única prova de que o pedido passou pela nossa Cloudflare: o Render não permite
 * mTLS na origem, e a URL *.onrender.com continua acessível directamente.
 */
export const ORIGIN_AUTH_HEADER = "x-origin-auth";

/** Caminhos que o Render/monitorização chamam sem passar pela Cloudflare. Só o /health leve. */
const EDGE_EXEMPT_PATHS = new Set(["/health"]);

declare module "fastify" {
  interface FastifyRequest {
    /**
     * IP do cliente já resolvido (CF-Connecting-IP validado, ou request.ip).
     * Usar sempre este campo — nunca request.ip nem cabeçalhos X-Forwarded-*.
     */
    clientIp: string;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Compara digests de tamanho fixo: tempo constante e sem fugas pelo comprimento.
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function pathOf(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

export interface EdgeGuard {
  /** Hook onRequest: resolve request.clientIp e, em modo cloudflare, rejeita pedidos fora da Cloudflare. */
  onRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void>;
}

export function createEdgeGuard(env: Env): EdgeGuard {
  const enabled = env.EDGE_MODE === "cloudflare";
  const secrets = [env.CF_ORIGIN_SECRET, env.CF_ORIGIN_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  function isFromEdge(request: FastifyRequest): boolean {
    const header = request.headers[ORIGIN_AUTH_HEADER];
    if (typeof header !== "string" || header.length === 0) return false;
    // Avalia todos os segredos (sem curto-circuito) para não variar o tempo de resposta.
    let ok = false;
    for (const secret of secrets) {
      if (safeEqual(header, secret)) ok = true;
    }
    return ok;
  }

  function cloudflareIp(request: FastifyRequest): string | null {
    const raw = request.headers["cf-connecting-ip"];
    if (typeof raw !== "string") return null;
    const ip = raw.trim();
    return isIP(ip) !== 0 ? ip : null;
  }

  return {
    async onRequest(request, reply) {
      if (!enabled) {
        request.clientIp = request.ip;
        return;
      }

      const fromEdge = isFromEdge(request);
      // CF-Connecting-IP só é de confiança se o segredo da origem estiver correcto.
      request.clientIp =
        (fromEdge ? cloudflareIp(request) : null) ?? request.ip;

      if (!fromEdge && !EDGE_EXEMPT_PATHS.has(pathOf(request.url))) {
        return reply.code(403).send({ error: "forbidden" });
      }
    },
  };
}
