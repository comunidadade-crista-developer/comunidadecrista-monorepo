import "dotenv/config";
import { exportJWK, generateKeyPair } from "jose";

process.env.ARGON2_MEMORY_KB = "4096";
process.env.ARGON2_TIME_COST = "1";
process.env.ARGON2_PARALLELISM = "1";

// Rate limits generosos em testes (bloqueio é testado num teste dedicado com env próprio)
process.env.RATE_LIMIT_LOGIN_MAX = "1000";
process.env.RATE_LIMIT_REGISTER_MAX = "1000";
process.env.RATE_LIMIT_RECOVER_MAX = "1000";
process.env.RATE_LIMIT_LOGIN_IP_MAX = "1000";
process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "1000";
process.env.RATE_LIMIT_RECOVER_IP_MAX = "1000";
process.env.RATE_LIMIT_RECOVER_ACCOUNT_QUESTIONS_MAX = "1000";
process.env.RATE_LIMIT_RECOVER_ACCOUNT_CODE_MAX = "1000";

// Chaves JWT efémeras por run (nunca reutilizar)
if (!process.env.JWT_PRIVATE_JWK || !process.env.JWT_PUBLIC_JWK) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const priv = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  process.env.JWT_PRIVATE_JWK = JSON.stringify({ ...priv, alg: "EdDSA" });
  process.env.JWT_PUBLIC_JWK = JSON.stringify({ ...pub, alg: "EdDSA" });
}
