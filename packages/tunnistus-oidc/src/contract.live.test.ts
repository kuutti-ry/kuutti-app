import { describe, expect, it } from "vitest";
import { TELIA_PREPRODUCTION_ISSUER } from "./client.ts";
import { discoverProvider } from "./discovery.ts";
import { fakeTelia } from "./testing/fake-telia.ts";

// Opt-in, and the only test of the package that leaves the machine: Telia's
// public, unauthenticated metadata on the pre-production bed (the discovery
// document and the JWKS), compared with what the client depends on and with
// what the double serves, so a change on Telia's side shows before a login
// fails. Skipped unless asked for:
//
//   TELIA_CONTRACT_LIVE=1 pnpm --filter @kuutti/tunnistus-oidc exec vitest run src/contract.live.test.ts
//
// The issuer is the client's own constant (docs/vendors/telia.md, "What
// Telia gives us"); nothing is sent but two GETs.

const LIVE = process.env.TELIA_CONTRACT_LIVE === "1";
const ISSUER = TELIA_PREPRODUCTION_ISSUER;
const TIMEOUT_MS = 10_000;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  expect(response.status, `GET ${url}`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

describe.skipIf(!LIVE)("Telia's published metadata, live (pre-production bed)", () => {
  it("the discovery document offers what the client depends on, as the double does", async () => {
    // The kit's own check first: the issuer character for character, the four URLs.
    const metadata = await discoverProvider(ISSUER, fetch, TIMEOUT_MS);
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorization`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      jwks_uri: `${ISSUER}/oauth2/metadata.jwks`,
    });

    const live = await getJson(`${ISSUER}/.well-known/openid-configuration`);
    const double = (await (
      await (
        await fakeTelia()
      ).fetch(`${ISSUER}/.well-known/openid-configuration`, {
        method: "GET",
        headers: {},
        body: undefined,
        redirect: "manual",
      })
    ).json()) as Record<string, unknown>;

    // What the client sends and accepts, each offered by Telia (guide 2.4–2.6).
    const depends: [field: string, value: string][] = [
      ["token_endpoint_auth_methods_supported", "private_key_jwt"],
      ["request_object_signing_alg_values_supported", "RS256"],
      ["id_token_signing_alg_values_supported", "RS256"],
      ["id_token_encryption_alg_values_supported", "RSA-OAEP"],
      // What the client metadata registers; the client also accepts A128GCM.
      ["id_token_encryption_enc_values_supported", "A128CBC-HS256"],
    ];
    for (const [field, value] of depends) {
      expect(list(live[field]), `Telia's ${field}`).toContain(value);
      expect(list(double[field]), `the double's ${field}`).toContain(value);
    }
    for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      expect(double[field], `the double's ${field}`).toBe(live[field]);
    }
  });

  it("the JWKS publishes a signing key the client can select, and nothing private", async () => {
    const { keys } = await getJson(`${ISSUER}/oauth2/metadata.jwks`);
    expect(Array.isArray(keys)).toBe(true);
    const published = keys as Record<string, unknown>[];
    // The client picks the key by the token's kid among RSA keys meant for
    // signatures (use sig or none, alg RS256 or none).
    const signing = published.filter(
      (k) =>
        k.kty === "RSA" &&
        (k.use === undefined || k.use === "sig") &&
        (k.alg === undefined || k.alg === "RS256"),
    );
    expect(signing.length).toBeGreaterThan(0);
    for (const key of published) {
      expect(typeof key.kid, "every key has a kid").toBe("string");
      for (const member of ["d", "p", "q", "dp", "dq", "qi"])
        expect(key).not.toHaveProperty(member);
    }
    for (const key of signing) {
      expect(typeof key.n).toBe("string");
      expect(Buffer.from(String(key.n), "base64url").length * 8).toBeGreaterThanOrEqual(2048);
    }
  });
});
