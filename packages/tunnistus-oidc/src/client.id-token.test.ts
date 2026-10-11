import { exportJWK, importJWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AKTIA_AMR,
  CLIENT_ID,
  callback,
  documentedJwks,
  fixtureClient,
  fixtureProvider,
  ftnClaims,
  type IdTokenOptions,
  ISSUER,
  idToken,
  type Keys,
  makeKeys,
  NOW,
  nowSeconds,
  REDIRECT_URI,
  TEST_HETU,
  tokenError,
  tokenResponse,
} from "../test/telia-fixtures.ts";
import { ACR_LOATEST2, FTN_CLAIMS, TunnistusError } from "./client.ts";

// Every check completeLogin makes, or has the library make, on what comes
// back from the broker: the callback, the token response, the JWE, the JWS,
// and each claim. Each refusal is one defect away from the accepted
// baseline, so the check named is the one that refused. Every refusal is also
// checked for carrying nothing of the person (no `cause`, no claims).

let keys: Keys;
let jwks: Awaited<ReturnType<typeof documentedJwks>>;
beforeAll(async () => {
  keys = await makeKeys();
  jwks = await documentedJwks(keys);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Answer = () => Response | Promise<Response>;

/** The token endpoint answers with the documented token for nonce "n", changed as the test says. */
const answer =
  (claims: Record<string, unknown> = {}, options: IdTokenOptions = {}): Answer =>
  async () =>
    tokenResponse(await idToken(keys, ftnClaims("n", claims), options));

async function exchange(
  token: Answer,
  options: { jwks?: unknown; callbackUrl?: URL; state?: string } = {},
) {
  const provider = fixtureProvider({ jwks: options.jwks ?? jwks, token });
  const client = await fixtureClient(keys, provider);
  const outcome = client.completeLogin({
    callbackUrl: options.callbackUrl ?? callback("s"),
    state: options.state ?? "s",
    nonce: "n",
  });
  return { outcome, provider };
}

/** Refused with this reason, and nothing of the person on the error. */
async function refused(outcome: Promise<unknown>, reason: string): Promise<void> {
  const error = await outcome.then(
    () => {
      throw new Error("accepted, expected a refusal");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TunnistusError);
  expect((error as TunnistusError).reason).toBe(reason);
  expect((error as TunnistusError).cause).toBeUndefined();
  const everything = JSON.stringify(error, Object.getOwnPropertyNames(error));
  for (const personal of [TEST_HETU, "Äyrämö", "Tero Testi", "1970-01-01"]) {
    expect(everything).not.toContain(personal);
  }
}

const accepted = async (outcome: Promise<{ acr: string }>) =>
  expect((await outcome).acr).toBe(ACR_LOATEST2);

describe("the accepted baseline", () => {
  it("is the documented token: a JWE (RSA-OAEP, A128CBC-HS256, our enc kid, cty JWT) around Telia's RS256 JWS", async () => {
    const { outcome } = await exchange(answer());
    expect(await outcome).toEqual({
      personalIdentityCode: TEST_HETU,
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      sessionIndex: "_cb08aaa8c860fed8c798aac35885f4004fe15bb5",
      tokenId: null,
      authenticatedAt: new Date((nowSeconds() - 5) * 1000),
      acr: ACR_LOATEST2,
      amr: [AKTIA_AMR],
      dateOfBirth: "1970-01-01",
      givenNames: "Tero Testi",
      surname: "Äyrämö",
      displayName: "Tero Testi Äyrämö",
    });
  });
});

describe("the encryption (guide 2.6.3)", () => {
  it("refuses an ID token in the clear, however well signed: Telia always encrypts", async () => {
    await refused(
      (await exchange(answer({}, { jweHeader: false }))).outcome,
      "ID token was not encrypted",
    );
  });

  it("accepts A128GCM, the other content encryption Telia's metadata lists", async () => {
    await accepted((await exchange(answer({}, { jweHeader: { enc: "A128GCM" } }))).outcome);
  });

  it.each(["A256GCM", "A192GCM", "A256CBC-HS512"])(
    "refuses content encryption %s, which Telia does not offer",
    async (enc) => {
      await refused(
        (await exchange(answer({}, { jweHeader: { enc } }))).outcome,
        "decryption failed",
      );
    },
  );

  it("refuses key management RSA-OAEP-256: the key is held for RSA-OAEP only", async () => {
    const token: Answer = async () => {
      const to = await importJWK(await exportJWK(keys.client.enc.publicKey), "RSA-OAEP-256");
      return answer({}, { encryptTo: to as CryptoKey, jweHeader: { alg: "RSA-OAEP-256" } })();
    };
    await refused((await exchange(token)).outcome, "decryption failed");
  });

  it("refuses a JWE whose header names another key than our enc key", async () => {
    await refused(
      (await exchange(answer({}, { jweHeader: { kid: "someone-elses-enc-key" } }))).outcome,
      "no applicable decryption key selected",
    );
  });

  it("refuses a JWE that names our key but was encrypted to another (our sig key's public half)", async () => {
    const token: Answer = async () => {
      const to = await importJWK(await exportJWK(keys.client.sig.publicKey), "RSA-OAEP");
      return answer({}, { encryptTo: to as CryptoKey })();
    };
    await refused((await exchange(token)).outcome, "decryption failed");
  });

  it("decrypts a JWE without kid or cty with the one key it holds (both are informative)", async () => {
    await accepted((await exchange(answer({}, { jweHeader: { kid: undefined } }))).outcome);
    await accepted((await exchange(answer({}, { jweHeader: { cty: undefined } }))).outcome);
  });

  it("refuses a JWE that carries something other than a JWS", async () => {
    await refused(
      (await exchange(answer({}, { plaintext: JSON.stringify({ sub: "x" }) }))).outcome,
      "invalid response encountered",
    );
  });
});

describe("the signature (guide 2.6.3, 2.7)", () => {
  it("refuses a token signed by a key the JWKS does not publish, under Telia's kid", async () => {
    await refused(
      (await exchange(answer({}, { signWith: keys.stranger.privateKey }))).outcome,
      "invalid response encountered",
    );
  });

  it("refuses a token whose signature is not the one its content needs", async () => {
    const token = await idToken(keys, ftnClaims("n"), { jweHeader: false });
    const otherToken = await idToken(keys, ftnClaims("n", { sub: "OTHER" }), { jweHeader: false });
    const signature = otherToken.split(".")[2] ?? "";
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());
    await refused(
      (await exchange(answer({}, { rawJws: { header, signature } }))).outcome,
      "invalid response encountered",
    );
  });

  it("refuses a token whose kid the JWKS does not name, without fetching the JWKS again within the minute", async () => {
    const { outcome, provider } = await exchange(
      answer({}, { jwsHeader: { kid: "telia-sig-unknown" } }),
    );
    await refused(outcome, "error when selecting a JWT verification key, no applicable keys found");
    const jwksFetches = provider.requests.filter((r) => r.url.endsWith("/metadata.jwks"));
    expect(jwksFetches).toHaveLength(1);
  });

  it("never verifies with the JWKS's enc key, even when the token names it and is signed by it", async () => {
    // The enc key's private half, made usable for RS256, signs under the enc kid.
    const {
      alg: _alg,
      key_ops: _ops,
      ext: _ext,
      ...material
    } = await exportJWK(keys.telia.enc.privateKey);
    const encAsSigner = (await importJWK(material, "RS256")) as CryptoKey;
    await refused(
      (await exchange(answer({}, { jwsHeader: { kid: keys.telia.encKid }, signWith: encAsSigner })))
        .outcome,
      "error when selecting a JWT verification key, no applicable keys found",
    );
  });

  it("verifies with the next key Telia publishes in advance (guide 2.7.1)", async () => {
    const withNext = {
      keys: [
        ...jwks.keys,
        {
          ...(await exportJWK(keys.telia.next.publicKey)),
          kid: keys.telia.nextKid,
          use: "sig",
          alg: "RS256",
        },
      ],
    };
    const { outcome } = await exchange(
      answer({}, { jwsHeader: { kid: keys.telia.nextKid }, signWith: keys.telia.next.privateKey }),
      { jwks: withNext },
    );
    await accepted(outcome);
  });

  it("picks the one sig key of the JWKS for a token without kid", async () => {
    await accepted((await exchange(answer({}, { jwsHeader: { kid: undefined } }))).outcome);
  });

  it.each([
    ["none", ""],
    ["HS256", "c2VjcmV0"],
    ["RS512", "AAAA"],
    ["PS256", "AAAA"],
    ["ES256", "AAAA"],
  ])("refuses a token signed with alg %s: RS256 only", async (alg, signature) => {
    await refused(
      (
        await exchange(
          answer({}, { rawJws: { header: { alg, kid: keys.telia.sigKid }, signature } }),
        )
      ).outcome,
      "invalid response encountered",
    );
  });
});

describe("the claims the library checks (guide 2.6.3: iss, aud, exp, nonce)", () => {
  it.each([
    ["another issuer", { iss: "https://tunnistus.telia.fi/uas" }],
    ["the issuer with a trailing slash", { iss: `${ISSUER}/` }],
    ["another audience", { aud: ["some-other-client"] }],
    ["another nonce", { nonce: "someone-elses-nonce" }],
    ["several audiences without azp", { aud: [CLIENT_ID, "other"], azp: undefined }],
    ["several audiences and azp naming another", { aud: [CLIENT_ID, "other"], azp: "other" }],
  ])("refuses %s", async (_name, claims) => {
    await refused(
      (await exchange(answer(claims))).outcome,
      "unexpected JWT claim value encountered",
    );
  });

  it.each([
    ["without iss", { iss: undefined }],
    ["without aud", { aud: undefined }],
    ["without exp", { exp: undefined }],
    ["without iat", { iat: undefined }],
    ["without sub", { sub: undefined }],
    ["without nonce", { nonce: undefined }],
    ["with exp as a string", { exp: String(Math.floor(NOW.getTime() / 1000) + 600) }],
    ["with iat as a string", { iat: "now" }],
    ["with sub as a number", { sub: 42 }],
    ["with auth_time as a string", { auth_time: "yesterday" }],
    ["with aud as an object", { aud: { client: CLIENT_ID } }],
  ])("refuses a token %s", async (_name, claims) => {
    await refused((await exchange(answer(claims))).outcome, "invalid response encountered");
  });

  it("accepts aud as the client id alone, or as an array that names it with azp", async () => {
    await accepted((await exchange(answer({ aud: CLIENT_ID, azp: undefined }))).outcome);
    await accepted((await exchange(answer({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }))).outcome);
  });

  it("refuses a token that expired thirty seconds ago or more (the library's tolerance), accepts one a second inside it", async () => {
    await refused(
      (await exchange(answer({ exp: nowSeconds() - 30 }))).outcome,
      "JWT timestamp claim value failed validation",
    );
    await accepted((await exchange(answer({ exp: nowSeconds() - 29 }))).outcome);
  });

  it("refuses a token not valid for more than thirty seconds yet (nbf), accepts one at the tolerance", async () => {
    await refused(
      (await exchange(answer({ nbf: nowSeconds() + 31 }))).outcome,
      "JWT timestamp claim value failed validation",
    );
    await accepted((await exchange(answer({ nbf: nowSeconds() + 30 }))).outcome);
  });

  it("puts no bound on iat or auth_time in the future: neither the guide nor OIDC Core 3.1.3.7 requires one", async () => {
    // Recorded so that adding a bound is a decision; a caller's freshness rule
    // compares auth_time with its own request, not with the clock.
    const inAYear = nowSeconds() + 365 * 24 * 3600;
    const identity = await (await exchange(answer({ iat: inAYear, auth_time: inAYear }))).outcome;
    expect(identity.authenticatedAt).toEqual(new Date(inAYear * 1000));
  });
});

describe("the claims the kit checks (guide 2.6.4–2.6.5, Traficom 213/2023 S)", () => {
  it("refuses a token without auth_time, which a caller's freshness rule stands on", async () => {
    await refused((await exchange(answer({ auth_time: undefined }))).outcome, "no auth_time");
  });

  it("refuses a token without the personal identity code (a non-Finnish method, 2.6.5)", async () => {
    await refused(
      (await exchange(answer({ [FTN_CLAIMS.personalIdentityCode]: undefined }))).outcome,
      "no identity code",
    );
  });

  it("refuses a level other than the one asked for, and a token without one", async () => {
    await refused(
      (await exchange(answer({ acr: "mpki.telia.emulator.1" }))).outcome,
      "unexpected acr",
    );
    await refused((await exchange(answer({ acr: undefined }))).outcome, "no acr");
  });
});

describe("the token response (RFC 6749 5.1–5.2)", () => {
  it.each([
    ["no id_token", () => tokenResponse(undefined)],
    ["an id_token that is not a string", () => tokenResponse(42 as unknown as string)],
    [
      "no access_token",
      async () => tokenResponse(await idToken(keys, ftnClaims("n")), { access_token: undefined }),
    ],
  ])("refuses a response with %s", async (_name, token) => {
    await refused((await exchange(token)).outcome, "invalid response encountered");
  });

  it("refuses a token type other than Bearer", async () => {
    const token: Answer = async () =>
      tokenResponse(await idToken(keys, ftnClaims("n")), { token_type: "mac" });
    await refused((await exchange(token)).outcome, "unsupported operation");
  });

  it.each([
    ["invalid_grant", 400],
    ["invalid_client", 401],
    ["invalid_request", 400],
    ["unauthorized_client", 400],
    ["unsupported_grant_type", 400],
  ])("refuses the broker's %s error", async (error, status) => {
    await refused(
      (await exchange(() => tokenError(status, error, "a description"))).outcome,
      "server responded with an error in the response body",
    );
  });

  it("refuses a server error page and a page that is not JSON", async () => {
    const page = (status: number) => () =>
      new Response("<html>Huoltokatko</html>", {
        status,
        headers: { "content-type": "text/html" },
      });
    await refused((await exchange(page(503))).outcome, "unexpected HTTP response status code");
    await refused((await exchange(page(200))).outcome, "unexpected response content-type");
  });

  it("refuses when the broker cannot be reached, with the library's reason only", async () => {
    await refused(
      (
        await exchange(() => {
          throw new Error(`ECONNRESET while sending ${TEST_HETU}`);
        })
      ).outcome,
      "something went wrong",
    );
  });
});

describe("the callback (guide 2.5)", () => {
  it.each([
    ["the person cancelled (access_denied, 2.5.2)", { error: "access_denied" }],
    [
      "a server error",
      { error: "server_error", error_description: "Palvelu ei ole käytettävissä" },
    ],
    ["temporarily unavailable", { error: "temporarily_unavailable" }],
    [
      "an invalid request",
      { error: "invalid_request", error_description: "request object rejected" },
    ],
  ])("refuses an error answer: %s, and asks the token endpoint nothing", async (_name, query) => {
    const { outcome, provider } = await exchange(answer(), { callbackUrl: callback("s", query) });
    await refused(outcome, "authorization response from the server is an error");
    expect(provider.lastTokenForm()).toBeNull();
  });

  it.each([
    ["another login's state", callback("not-s")],
    ["no state", new URL(`${REDIRECT_URI}?code=code-1`)],
    ["no code", callback("s", {})],
    [
      "an iss parameter naming another issuer (RFC 9207)",
      callback("s", { code: "c", iss: "https://evil.example/uas" }),
    ],
    ["a cancellation under another login's state", callback("not-s", { error: "access_denied" })],
  ])("refuses a callback with %s before any token request", async (_name, url) => {
    const { outcome, provider } = await exchange(answer(), { callbackUrl: url });
    await refused(outcome, "invalid response encountered");
    expect(provider.lastTokenForm()).toBeNull();
  });

  it("refuses an implicit-flow answer (an id_token in the query)", async () => {
    const { outcome, provider } = await exchange(answer(), {
      callbackUrl: callback("s", { code: "c", id_token: "x.y.z" }),
    });
    await refused(outcome, "unsupported operation");
    expect(provider.lastTokenForm()).toBeNull();
  });

  it("accepts an iss parameter that names the issuer", async () => {
    await accepted(
      (await exchange(answer(), { callbackUrl: callback("s", { code: "c", iss: ISSUER }) }))
        .outcome,
    );
  });
});
