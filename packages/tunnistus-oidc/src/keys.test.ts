import { createHash, generateKeyPairSync } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { NOT_A_KEY_PEM } from "../test/telia-fixtures.ts";
import { keyIdOf, publicJwk } from "./keys.ts";

describe("keys", () => {
  it("names a key by its RFC 7638 thumbprint, the same jose computes, and builds the JWK Telia is sent", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const kid = keyIdOf(pem);
    expect(kid).toBe(await calculateJwkThumbprint(await exportJWK(publicKey)));

    const sig = publicJwk(pem, "sig");
    expect(sig).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256", kid, e: "AQAB" });
    expect(sig.n).toBe((await exportJWK(publicKey)).n);
    expect(publicJwk(pem, "enc")).toMatchObject({ use: "enc", alg: "RSA-OAEP", kid });
    // No private material in what is sent.
    expect(Object.keys(sig).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("refuses a key that is not RSA", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    expect(() => keyIdOf(pem)).toThrow(/RSA/);
  });

  it("names a key the same way every time, from either half and whatever its use: 43 base64url characters", async () => {
    const { privateKey } = await generateKeyPair("RSA-OAEP", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const kid = keyIdOf(pem);
    expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keyIdOf(pem)).toBe(kid);
    expect(publicJwk(pem, "sig").kid).toBe(publicJwk(pem, "enc").kid);
    // RFC 7638 3.2: the required members, sorted, no whitespace, SHA-256.
    const { e, n } = publicJwk(pem, "enc");
    expect(kid).toBe(
      createHash("sha256").update(`{"e":"${e}","kty":"RSA","n":"${n}"}`).digest("base64url"),
    );
  });

  it("names two keys differently", async () => {
    const [a, b] = await Promise.all([
      generateKeyPair("RS256", { extractable: true }),
      generateKeyPair("RS256", { extractable: true }),
    ]);
    expect(keyIdOf(await exportPKCS8(a.privateKey))).not.toBe(
      keyIdOf(await exportPKCS8(b.privateKey)),
    );
  });

  it("reads the same key in PKCS#1 as in PKCS#8 (the client itself takes PKCS#8 only)", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }) as string;
    expect(keyIdOf(pkcs1)).toBe(keyIdOf(pkcs8));
  });

  it("refuses an Ed25519 key as it refuses an EC key", () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    expect(() => keyIdOf(pem)).toThrow("a Telia key is RSA (guide 2.1.1)");
    expect(() => publicJwk(pem, "sig")).toThrow("a Telia key is RSA (guide 2.1.1)");
  });

  it("refuses an RSA key under 2048 bits, naming its size (guide 2.1.1), and takes 2048 itself", () => {
    const pem = (bits: number) =>
      generateKeyPairSync("rsa", { modulusLength: bits }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }) as string;
    for (const bits of [1024, 2047]) {
      const small = pem(bits);
      const refusal = `a Telia key is RSA of 2048 bits or more (guide 2.1.1), not ${bits}`;
      expect(() => keyIdOf(small)).toThrow(refusal);
      expect(() => publicJwk(small, "sig")).toThrow(refusal);
      expect(() => publicJwk(small, "enc")).toThrow(refusal);
    }
    expect(keyIdOf(pem(2048))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a public key, an empty string and something that is not a key", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
    for (const notPrivate of [publicPem, "", NOT_A_KEY_PEM]) {
      expect(() => keyIdOf(notPrivate)).toThrow();
    }
  });
});
