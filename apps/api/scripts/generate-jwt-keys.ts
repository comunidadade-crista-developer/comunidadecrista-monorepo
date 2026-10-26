import { exportJWK, generateKeyPair } from "jose";

const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});

const priv = await exportJWK(privateKey);
const pub = await exportJWK(publicKey);

console.log("# Cola em apps/api/.env");
console.log(`JWT_PRIVATE_JWK='${JSON.stringify({ ...priv, alg: "EdDSA" })}'`);
console.log(`JWT_PUBLIC_JWK='${JSON.stringify({ ...pub, alg: "EdDSA" })}'`);
