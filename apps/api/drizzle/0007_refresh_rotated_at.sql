-- RB-b: momento em que um refresh token foi substituído por rotação. Distingue-o de um token
-- revogado por logout ou por mudança de palavra-passe (`revoked_at` sozinho não distingue) e
-- permite tolerar, durante poucos segundos, o reenvio do token antigo (vários separadores, retry).
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_at" timestamp with time zone;
