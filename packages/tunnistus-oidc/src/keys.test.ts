import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
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
});
