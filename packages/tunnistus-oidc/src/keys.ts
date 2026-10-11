import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export type KeyUse = "sig" | "enc";

function rsaPublicJwk(privateKeyPem: string): { kty: "RSA"; n: string; e: string } {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" });
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("a Telia key is RSA (guide 2.1.1)");
  return { kty: "RSA", n: jwk.n, e: jwk.e };
}

/**
 * The `kid` of a key is its RFC 7638 thumbprint: the JWK handed to Telia
 * carries it, Telia names the `enc` key by it in the JWE header of every ID
 * token (guide 2.6.3, confirmed by Telia 2026-10-08), and the client decrypts
 * only with the key whose kid the header names. Computed from the private
 * key, so no configuration can disagree with the key.
 */
export function keyIdOf(privateKeyPem: string): string {
  const { e, kty, n } = rsaPublicJwk(privateKeyPem);
  const canonical = JSON.stringify({ e, kty, n });
  return createHash("sha256").update(canonical).digest("base64url");
}

/** The public JWK to register with Telia (guide 2.3): `use`, `alg` and the thumbprint as `kid`. */
export function publicJwk(
  privateKeyPem: string,
  use: KeyUse,
): { kty: "RSA"; use: KeyUse; kid: string; alg: "RS256" | "RSA-OAEP"; n: string; e: string } {
  const { kty, n, e } = rsaPublicJwk(privateKeyPem);
  return {
    kty,
    use,
    kid: keyIdOf(privateKeyPem),
    alg: use === "sig" ? "RS256" : "RSA-OAEP",
    n,
    e,
  };
}
