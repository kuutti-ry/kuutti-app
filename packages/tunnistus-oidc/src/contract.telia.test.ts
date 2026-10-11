import { randomBytes } from "node:crypto";
import {
  calculateJwkThumbprint,
  compactDecrypt,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  importPKCS8,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import type * as oidc from "openid-client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  callback,
  documentedDiscovery,
  documentedJwks,
  fixtureClient,
  fixtureProvider,
  ftnClaims,
  idToken,
  type Keys,
  makeKeys,
  tokenResponse,
} from "../test/telia-fixtures.ts";
import {
  ACR_LOA2,
  ACR_LOATEST2,
  createTunnistusClient,
  FTN_CLAIMS,
  HETU_CLAIM,
  TELIA_PREPRODUCTION_ISSUER,
  TELIA_PRODUCTION_ISSUER,
  type TunnistusClient,
} from "./client.ts";
import { discoverProvider, isTeliaIssuer } from "./discovery.ts";
import { keyIdOf, publicJwk } from "./keys.ts";
import {
  AKTIA,
  CLIENT_ASSERTION_TYPE,
  type FakeTelia,
  fakeTelia,
  LOATEST2,
  TELIA_AUTHORIZATION_ENDPOINT,
  TELIA_ISSUER,
  TELIA_JWKS,
  TELIA_TOKEN_ENDPOINT,
} from "./testing/fake-telia.ts";

// The contract with Telia Tunnistus, both ways, as docs/vendors/telia.md
// records it (the integration guide v2.36, the cheat sheet of 2026-10-08,
// the discovery documents read live on 2026-10-07). Each test names the
// requirement and the section it comes from.
//
// What we send: the client's request is checked against the requirement,
// and the double is shown to refuse a request that breaks it, so the double
// cannot pass a client the broker would refuse.
// What we accept: each artefact Telia documents is accepted by the client,
// built as a fixture from the documented shape, and the double is shown to
// produce the same shape, so the double cannot drift from the broker.

const random = () => randomBytes(18).toString("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1000);

type Sent = {
  url: URL;
  requestObject: JWTPayload;
  requestHeader: Record<string, unknown>;
  tokenForm: Record<string, string>;
  assertion: JWTPayload;
  assertionHeader: Record<string, unknown>;
  state: string;
  nonce: string;
};

/** The double's fetch, with every answer kept for reading. */
function recording(telia: FakeTelia) {
  const answers: { url: string; status: number; body: string }[] = [];
  const fetch: oidc.CustomFetch = async (url, init) => {
    const response = await telia.fetch(url, init);
    answers.push({ url, status: response.status, body: await response.clone().text() });
    return response;
  };
  return { fetch, answers };
}

const clientOf = (telia: FakeTelia, fetch: oidc.CustomFetch = telia.fetch) =>
  createTunnistusClient({
    issuer: TELIA_ISSUER,
    clientId: telia.clientId,
    redirectUri: telia.redirectUri,
    acrValues: ACR_LOATEST2,
    signingKeyPem: telia.signingKeyPem,
    encryptionKeyPem: telia.encryptionKeyPem,
    fetch,
  });

/** One whole login by the client against the double, and what the double saw of it. */
async function loginAndRecord(client: TunnistusClient, telia: FakeTelia): Promise<Sent> {
  const state = random();
  const nonce = random();
  const url = await client.startLogin({ state, nonce, uiLocales: "fi", prompt: "login" });
  const back = await telia.authorize(url);
  await client.completeLogin({ callbackUrl: back, state, nonce });
  const { seen } = telia;
  if (!seen.requestObject || !seen.requestHeader || !seen.tokenForm || !seen.assertion) {
    throw new Error("the double saw no complete login");
  }
  // A copy: the double's record is overwritten by the next request.
  const copy = structuredClone({
    requestObject: seen.requestObject,
    requestHeader: seen.requestHeader,
    tokenForm: seen.tokenForm,
    assertion: seen.assertion,
    assertionHeader: seen.assertionHeader ?? {},
  });
  return { ...copy, url, state, nonce };
}

describe("what we send is what Telia documents", () => {
  let telia: FakeTelia;
  let client: TunnistusClient;
  let sent: Sent;
  let signingKey: CryptoKey;

  beforeAll(async () => {
    telia = await fakeTelia();
    client = await clientOf(telia);
    sent = await loginAndRecord(client, telia);
    signingKey = await importPKCS8(telia.signingKeyPem, "RS256");
  });

  /** A request object as the guide's sample has it, signed with our sig key, changed as the test says. */
  async function requestObject(
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
    key: CryptoKey = signingKey,
  ): Promise<string> {
    const now = nowSeconds();
    return new SignJWT({
      iss: telia.clientId,
      aud: TELIA_ISSUER,
      client_id: telia.clientId,
      response_type: "code",
      scope: "openid",
      redirect_uri: telia.redirectUri,
      acr_values: LOATEST2,
      state: "s",
      nonce: "n",
      jti: random(),
      iat: now,
      exp: now + 600,
      ...claims,
    })
      .setProtectedHeader(header as { alg: string })
      .sign(key);
  }

  const authorizationUrl = (request: string | null) => {
    const url = new URL(TELIA_AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", telia.clientId);
    if (request !== null) url.searchParams.set("request", request);
    return url;
  };

  /** The double's refusal of an authorization request, read from its own record. */
  async function authorizationRefusal(url: URL): Promise<string> {
    const before = telia.seen.refusals.length;
    await expect(telia.authorize(url)).rejects.toThrow(/^authorization endpoint answered 400: /);
    expect(telia.seen.refusals).toHaveLength(before + 1);
    return telia.seen.refusals.at(-1) ?? "";
  }

  describe("the authorization request (telia.md 'The flow', guide 2.4)", () => {
    it("2.4.1 and the cheat sheet: a signed request object, the query carrying client_id and request only", async () => {
      expect(`${sent.url.origin}${sent.url.pathname}`).toBe(TELIA_AUTHORIZATION_ENDPOINT);
      expect([...sent.url.searchParams.keys()].sort()).toEqual(["client_id", "request"]);
      expect(await authorizationRefusal(authorizationUrl(null))).toBe(
        "no request object (guide 2.4.1)",
      );
      // The baseline the refusals below depart from is accepted.
      const back = await telia.authorize(authorizationUrl(await requestObject()));
      expect(back.searchParams.get("code")).toBeTruthy();
    });

    it("2.4.1: RS256 with our sig key, verifiable with its public half and not with the enc key's", async () => {
      const request = sent.url.searchParams.get("request") ?? "";
      expect(decodeProtectedHeader(request).alg).toBe("RS256");
      const sigPublic = publicJwk(telia.signingKeyPem, "sig");
      const encPublic = publicJwk(telia.encryptionKeyPem, "enc");
      await expect(
        jwtVerify(request, createLocalJWKSet({ keys: [{ ...sigPublic }] })),
      ).resolves.toBeTruthy();
      await expect(
        jwtVerify(
          request,
          createLocalJWKSet({ keys: [{ ...encPublic, alg: "RS256", use: "sig" }] }),
        ),
      ).rejects.toThrow();
      const stranger = await fakeTelia();
      const strangersRequest = await requestObject(
        {},
        undefined,
        await importPKCS8(stranger.signingKeyPem, "RS256"),
      );
      expect(await authorizationRefusal(authorizationUrl(strangersRequest))).toBe(
        "request object rejected: signature verification failed",
      );
    });

    it("2.4.4, the guide's sample header: typ JWT, and no kid (Telia knows one sig key per client)", async () => {
      expect(sent.requestHeader).toEqual({ alg: "RS256", typ: "JWT" });
      expect(
        await authorizationRefusal(authorizationUrl(await requestObject({}, { alg: "RS256" }))),
      ).toBe("request object typ must be JWT");
    });

    it.each([
      [
        "iss is the client_id",
        "iss",
        () => telia.clientId,
        () => ({ iss: "someone-else" }),
        /unexpected "iss" claim value/,
      ],
      [
        "aud is the issuer",
        "aud",
        () => TELIA_ISSUER,
        () => ({ aud: TELIA_TOKEN_ENDPOINT }),
        /unexpected "aud" claim value/,
      ],
      [
        "client_id is the registered client",
        "client_id",
        () => telia.clientId,
        () => ({ client_id: "someone-else" }),
        /^client_id is not the registered client$/,
      ],
      [
        "response_type is code",
        "response_type",
        () => "code",
        () => ({ response_type: "id_token" }),
        /^response_type must be code$/,
      ],
      [
        "scope is openid",
        "scope",
        () => "openid",
        () => ({ scope: "openid profile" }),
        /^scope must be openid$/,
      ],
      [
        "redirect_uri is the registered one, exactly (2.1.3)",
        "redirect_uri",
        () => telia.redirectUri,
        () => ({ redirect_uri: `${telia.redirectUri}/` }),
        /^redirect_uri is not registered$/,
      ],
      [
        "acr_values is mandatory (Traficom 213/2023 S): loatest2 on the test bed",
        "acr_values",
        () => ACR_LOATEST2,
        () => ({ acr_values: "" }),
        /^acr_values is mandatory/,
      ],
      [
        "state is carried",
        "state",
        () => sent.state,
        () => ({ state: 7 }),
        /^state and nonce are expected$/,
      ],
      [
        "nonce is carried",
        "nonce",
        () => sent.nonce,
        () => ({ nonce: undefined }),
        /^state and nonce are expected$/,
      ],
    ])("2.4.2: %s", async (_name, claim, expected, violation, refusal) => {
      expect(sent.requestObject[claim]).toBe(expected());
      expect(
        await authorizationRefusal(authorizationUrl(await requestObject(violation()))),
      ).toMatch(refusal);
    });

    it("2.4.2: jti, a new one for every request", async () => {
      const again = decodeJwt(
        (await client.startLogin({ state: "s", nonce: "n" })).searchParams.get("request") ?? "",
      );
      expect(typeof sent.requestObject.jti).toBe("string");
      expect(again.jti).not.toBe(sent.requestObject.jti);
    });

    it("2.4.2–2.4.3: exp about ten minutes after iat; a request without exp, or past it, is refused", async () => {
      const { iat, exp } = sent.requestObject;
      expect(typeof iat).toBe("number");
      expect((exp ?? 0) - (iat ?? 0)).toBe(600);
      expect(
        await authorizationRefusal(authorizationUrl(await requestObject({ exp: undefined }))),
      ).toBe("request object expired or without exp");
      expect(
        await authorizationRefusal(
          authorizationUrl(await requestObject({ exp: nowSeconds() - 120 })),
        ),
      ).toMatch(/^request object rejected: "exp" claim timestamp check failed$/);
    });

    it("2.4.4: no nbf, which the guide does not name and a slow clock would trip", async () => {
      expect(sent.requestObject).not.toHaveProperty("nbf");
      expect(
        await authorizationRefusal(authorizationUrl(await requestObject({ nbf: nowSeconds() }))),
      ).toBe("nbf is not a request object claim here");
    });

    it("2.4.3: ui_locales fi, sv or en, as the caller asks", async () => {
      expect(sent.requestObject.ui_locales).toBe("fi");
      for (const locale of ["sv", "en"]) {
        const request = (
          await client.startLogin({ state: "s", nonce: "n", uiLocales: locale })
        ).searchParams.get("request");
        expect(decodeJwt(request ?? "").ui_locales).toBe(locale);
      }
    });

    it("2.4.3 and ADR-016: prompt=login when the caller asks for the bank every time", () => {
      expect(sent.requestObject.prompt).toBe("login");
    });

    it("the request object's claims are those of the guide and nothing more", () => {
      expect(Object.keys(sent.requestObject).sort()).toEqual([
        "acr_values",
        "aud",
        "client_id",
        "exp",
        "iat",
        "iss",
        "jti",
        "nonce",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
        "ui_locales",
      ]);
    });
  });

  describe("the token request (telia.md 'The flow', guide 2.6.1–2.6.2)", () => {
    /** A fresh code from the double, for one token request. */
    async function code(): Promise<string> {
      const back = await telia.authorize(authorizationUrl(await requestObject()));
      return back.searchParams.get("code") ?? "";
    }

    async function assertion(
      claims: Record<string, unknown> = {},
      key: CryptoKey = signingKey,
    ): Promise<string> {
      const now = nowSeconds();
      return new SignJWT({
        iss: telia.clientId,
        sub: telia.clientId,
        aud: TELIA_TOKEN_ENDPOINT,
        jti: random(),
        iat: now,
        exp: now + 60,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256" })
        .sign(key);
    }

    async function tokenRequest(form: Record<string, string | undefined>) {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(form))
        if (value !== undefined) body.set(key, value);
      const response = await telia.fetch(TELIA_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "manual",
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    async function form(overrides: Record<string, string | undefined> = {}) {
      return {
        grant_type: "authorization_code",
        code: await code(),
        redirect_uri: telia.redirectUri,
        client_id: telia.clientId,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await assertion(),
        ...overrides,
      };
    }

    it("the baseline the refusals below depart from is answered with an ID token", async () => {
      const answer = await tokenRequest(await form());
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ token_type: "Bearer", scope: "openid" });
      expect(typeof answer.body.id_token).toBe("string");
    });

    it("2.6.1: grant_type authorization_code", async () => {
      expect(sent.tokenForm.grant_type).toBe("authorization_code");
      expect(await tokenRequest(await form({ grant_type: "refresh_token" }))).toEqual({
        status: 400,
        body: { error: "unsupported_grant_type", error_description: "" },
      });
    });

    it("2.6.1 and the cheat sheet: the code as Telia sent it, untouched; a code is good once", async () => {
      expect(sent.tokenForm.code).toBeTruthy();
      const once = await form();
      expect((await tokenRequest(once)).status).toBe(200);
      const replay = await tokenRequest({ ...once, client_assertion: await assertion() });
      expect(replay).toEqual({
        status: 400,
        body: { error: "invalid_grant", error_description: "unknown or used code" },
      });
      expect((await tokenRequest(await form({ code: undefined }))).body.error).toBe(
        "invalid_grant",
      );
      expect((await tokenRequest(await form({ code: `${await code()}x` }))).body.error).toBe(
        "invalid_grant",
      );
    });

    it("2.6.1 and 2.1.3: redirect_uri, the registered one", async () => {
      expect(sent.tokenForm.redirect_uri).toBe(telia.redirectUri);
      expect(
        await tokenRequest(await form({ redirect_uri: "https://api.kuutti.app/auth/callback" })),
      ).toEqual({
        status: 400,
        body: { error: "invalid_grant", error_description: "redirect_uri" },
      });
    });

    it("2.6.1: client_id, the registered client", async () => {
      expect(sent.tokenForm.client_id).toBe(telia.clientId);
      expect(await tokenRequest(await form({ client_id: "someone-else" }))).toEqual({
        status: 400,
        body: { error: "invalid_client", error_description: "client_id" },
      });
    });

    it("2.6.1: private_key_jwt (RFC 7523): the jwt-bearer assertion type and an assertion, never a secret", async () => {
      expect(sent.tokenForm.client_assertion_type).toBe(CLIENT_ASSERTION_TYPE);
      expect(sent.tokenForm).not.toHaveProperty("client_secret");
      expect(
        (await tokenRequest(await form({ client_assertion_type: "client_secret" }))).body,
      ).toEqual({
        error: "invalid_client",
        error_description: "client_assertion_type",
      });
      expect((await tokenRequest(await form({ client_assertion: undefined }))).body).toEqual({
        error: "invalid_client",
        error_description: "no client_assertion",
      });
    });

    it("2.6.1: no PKCE: the guide's flow has no code_verifier", () => {
      expect(sent.tokenForm).not.toHaveProperty("code_verifier");
      expect([...sent.url.searchParams.keys()]).not.toContain("code_challenge");
      expect(sent.requestObject).not.toHaveProperty("code_challenge");
    });

    it("2.6.1: the form carries the documented parameters and nothing more", () => {
      expect(Object.keys(sent.tokenForm).sort()).toEqual([
        "client_assertion",
        "client_assertion_type",
        "client_id",
        "code",
        "grant_type",
        "redirect_uri",
      ]);
    });

    it("2.6.2: the assertion is signed RS256 with our sig key (no kid)", async () => {
      expect(sent.assertionHeader).toEqual({ alg: "RS256" });
      const stranger = await fakeTelia();
      const answer = await tokenRequest(
        await form({
          client_assertion: await assertion({}, await importPKCS8(stranger.signingKeyPem, "RS256")),
        }),
      );
      expect(answer).toEqual({
        status: 400,
        body: { error: "invalid_client", error_description: "signature verification failed" },
      });
    });

    it.each([
      ["iss is the client_id", "iss", { iss: "someone-else" }, /unexpected "iss" claim value/],
      ["sub is the client_id", "sub", { sub: "someone-else" }, /unexpected "sub" claim value/],
      [
        "aud is the token endpoint, not the issuer the library would put there",
        "aud",
        { aud: TELIA_ISSUER },
        /unexpected "aud" claim value/,
      ],
    ])("2.6.2: %s", async (_name, claim, violation, refusal) => {
      expect(sent.assertion[claim]).toBe(claim === "aud" ? TELIA_TOKEN_ENDPOINT : telia.clientId);
      const answer = await tokenRequest(
        await form({ client_assertion: await assertion(violation) }),
      );
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe("invalid_client");
      expect(answer.body.error_description).toMatch(refusal);
    });

    it("2.6.2: jti single use: a new one for every token request, a reused one refused", async () => {
      expect(typeof sent.assertion.jti).toBe("string");
      const second = await clientOf(telia);
      const again = await loginAndRecord(second, telia);
      expect(again.assertion.jti).not.toBe(sent.assertion.jti);
      const reused = await assertion({ jti: "used-once" });
      expect((await tokenRequest(await form({ client_assertion: reused }))).status).toBe(200);
      expect((await tokenRequest(await form({ client_assertion: reused }))).body).toEqual({
        error: "invalid_client",
        error_description: "jti missing or reused",
      });
      expect(
        (await tokenRequest(await form({ client_assertion: await assertion({ jti: undefined }) })))
          .body,
      ).toEqual({ error: "invalid_client", error_description: "jti missing or reused" });
    });

    it("2.6.2: exp within 60 minutes (ours: a minute after iat)", async () => {
      const { iat, exp } = sent.assertion;
      expect(typeof iat).toBe("number");
      expect((exp ?? 0) - (iat ?? 0)).toBe(60);
      for (const exp of [nowSeconds() + 3601, undefined]) {
        expect(
          (await tokenRequest(await form({ client_assertion: await assertion({ exp }) }))).body,
        ).toEqual({ error: "invalid_client", error_description: "exp more than 60 minutes ahead" });
      }
    });

    it("2.6.2: the assertion's claims are the RFC 7523 set (nbf is the library's, not the guide's)", () => {
      // Telia accepted it on 2026-10-08; the request object drops nbf, the assertion keeps it.
      expect(Object.keys(sent.assertion).sort()).toEqual([
        "aud",
        "exp",
        "iat",
        "iss",
        "jti",
        "nbf",
        "sub",
      ]);
      expect(sent.assertion.nbf).toBe(sent.assertion.iat);
    });
  });

  describe("our keys (telia.md 'What Telia needs from us', guide 2.1.1 and 2.3)", () => {
    it("two separate RSA keys of 2048 bits or more, published as JWKs with use sig and use enc", () => {
      const sig = publicJwk(telia.signingKeyPem, "sig");
      const enc = publicJwk(telia.encryptionKeyPem, "enc");
      expect(sig).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256" });
      expect(enc).toMatchObject({ kty: "RSA", use: "enc", alg: "RSA-OAEP" });
      expect(sig.kid).not.toBe(enc.kid);
      for (const jwk of [sig, enc]) {
        expect(Buffer.from(jwk.n, "base64url").length * 8).toBeGreaterThanOrEqual(2048);
      }
    });

    it("the kids the client names are the RFC 7638 thumbprints of the JWKs Telia registered", async () => {
      expect(client.keyIds).toEqual({
        signing: await calculateJwkThumbprint(publicJwk(telia.signingKeyPem, "sig")),
        encryption: await calculateJwkThumbprint(publicJwk(telia.encryptionKeyPem, "enc")),
      });
      expect(client.keyIds?.signing).toBe(keyIdOf(telia.signingKeyPem));
    });
  });
});

describe("what we accept is what Telia provides", () => {
  let keys: Keys;
  let telia: FakeTelia;
  beforeAll(async () => {
    keys = await makeKeys();
    telia = await fakeTelia();
  });

  /** The double's discovery document, read through its fetch as a consumer would (no signal). */
  async function doubleDiscovery(): Promise<Record<string, unknown>> {
    const response = await telia.fetch(`${TELIA_ISSUER}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { accept: "application/json" },
      body: undefined,
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  describe("the issuers, endpoints and levels (telia.md 'What Telia gives us', 'The flow')", () => {
    it("names the two documented issuers and the levels of Traficom 213/2023 S", () => {
      expect(TELIA_PREPRODUCTION_ISSUER).toBe("https://tunnistus-pp.telia.fi/uas");
      expect(TELIA_PRODUCTION_ISSUER).toBe("https://tunnistus.telia.fi/uas");
      expect(ACR_LOA2).toBe("http://ftn.ficora.fi/2017/loa2");
      expect(ACR_LOATEST2).toBe("http://ftn.ficora.fi/2017/loatest2");
      expect(
        isTeliaIssuer(TELIA_PREPRODUCTION_ISSUER) && isTeliaIssuer(TELIA_PRODUCTION_ISSUER),
      ).toBe(true);
      // The double plays the documented pre-production broker.
      expect(TELIA_ISSUER).toBe(TELIA_PREPRODUCTION_ISSUER);
      expect(LOATEST2).toBe(ACR_LOATEST2);
    });

    it("finds the endpoints the file lists under the issuer, for both hosts, and so does the double", async () => {
      for (const issuer of [TELIA_PREPRODUCTION_ISSUER, TELIA_PRODUCTION_ISSUER]) {
        const metadata = await discoverProvider(issuer, async (url) => {
          expect(url).toBe(`${issuer}/.well-known/openid-configuration`);
          return Response.json(documentedDiscovery(issuer));
        });
        expect(metadata).toMatchObject({
          authorization_endpoint: `${issuer}/oauth2/authorization`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/oauth2/metadata.jwks`,
        });
      }
      expect([TELIA_AUTHORIZATION_ENDPOINT, TELIA_TOKEN_ENDPOINT, TELIA_JWKS]).toEqual([
        `${TELIA_PREPRODUCTION_ISSUER}/oauth2/authorization`,
        `${TELIA_PREPRODUCTION_ISSUER}/oauth2/token`,
        `${TELIA_PREPRODUCTION_ISSUER}/oauth2/metadata.jwks`,
      ]);
    });
  });

  describe("the discovery document (telia.md 'What Telia gives us', read live 2026-10-07)", () => {
    it("the client completes a login against the documented document, which lists no acr_values_supported or ui_locales_supported", async () => {
      const discovery = documentedDiscovery();
      expect(discovery).not.toHaveProperty("acr_values_supported");
      expect(discovery).not.toHaveProperty("ui_locales_supported");
      const provider = fixtureProvider({
        discovery,
        jwks: await documentedJwks(keys),
        token: async () => tokenResponse(await idToken(keys, ftnClaims("n"))),
      });
      const client = await fixtureClient(keys, provider);
      const url = await client.startLogin({ state: "s", nonce: "n" });
      expect(`${url.origin}${url.pathname}`).toBe(discovery.authorization_endpoint);
      const identity = await client.completeLogin({
        callbackUrl: callback("s"),
        state: "s",
        nonce: "n",
      });
      expect(identity.acr).toBe(ACR_LOATEST2);
      expect(provider.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        `GET ${TELIA_PREPRODUCTION_ISSUER}/.well-known/openid-configuration`,
        `POST ${discovery.token_endpoint}`,
        `GET ${discovery.jwks_uri}`,
      ]);
    });

    it("the double's document carries every field the client depends on, with the documented values", async () => {
      const ours = documentedDiscovery();
      const double = await doubleDiscovery();
      for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        expect(double[field]).toBe(ours[field]);
      }
      for (const field of [
        "token_endpoint_auth_methods_supported",
        "request_object_signing_alg_values_supported",
        "id_token_signing_alg_values_supported",
        "id_token_encryption_alg_values_supported",
      ]) {
        expect(double[field]).toEqual(ours[field]);
      }
      // A subset: the double encrypts with A128GCM too when asked (`enc`), as Telia may.
      for (const enc of double.id_token_encryption_enc_values_supported as string[]) {
        expect(ours.id_token_encryption_enc_values_supported).toContain(enc);
      }
      await expect(
        discoverProvider(TELIA_ISSUER, (url) =>
          telia.fetch(url, {
            method: "GET",
            headers: {},
            body: undefined,
            redirect: "manual",
          }),
        ),
      ).resolves.toMatchObject({ issuer: TELIA_ISSUER });
    });

    it("a document that names another issuer is not the broker's (OpenID Connect Discovery 4.3)", async () => {
      const provider = fixtureProvider({
        discovery: { ...documentedDiscovery(), issuer: TELIA_PRODUCTION_ISSUER },
      });
      await expect(fixtureClient(keys, provider)).rejects.toThrow(
        "discovered metadata issuer does not match the expected issuer",
      );
    });

    it.each(["token_endpoint", "jwks_uri"])(
      "a document without %s starts a client that cannot complete a login",
      async (field) => {
        const discovery = documentedDiscovery();
        delete discovery[field];
        const provider = fixtureProvider({
          discovery,
          jwks: await documentedJwks(keys),
          token: async () => tokenResponse(await idToken(keys, ftnClaims("n"))),
        });
        const client = await fixtureClient(keys, provider);
        await expect(
          client.completeLogin({ callbackUrl: callback("s"), state: "s", nonce: "n" }),
        ).rejects.toMatchObject({
          reason: `authorization server metadata does not contain a valid "as.${field}"`,
        });
      },
    );
  });

  describe("the JWKS (telia.md 'What Telia gives us', guide 2.2 and 2.7)", () => {
    it("the documented set, one sig and one enc key: the client verifies with the sig key", async () => {
      const jwks = await documentedJwks(keys);
      expect(jwks.keys.map((k) => k.use)).toEqual(["sig", "enc"]);
      const provider = fixtureProvider({
        jwks,
        token: async () => tokenResponse(await idToken(keys, ftnClaims("n"))),
      });
      const client = await fixtureClient(keys, provider);
      await expect(
        client.completeLogin({ callbackUrl: callback("s"), state: "s", nonce: "n" }),
      ).resolves.toMatchObject({ acr: ACR_LOATEST2 });
    });

    it("the double's set: RSA keys under a kid, for sig and RS256, that verify the double's ID tokens", async () => {
      const response = await telia.fetch(TELIA_JWKS, {
        method: "GET",
        headers: {},
        body: undefined,
        redirect: "manual",
      });
      const { keys: published } = (await response.json()) as { keys: JWK[] };
      expect(published.length).toBeGreaterThan(0);
      for (const key of published) {
        expect(key).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256" });
        expect(typeof key.kid).toBe("string");
        expect(key).not.toHaveProperty("d");
      }
    });
  });

  describe("the ID token (telia.md 'The flow', guide 2.6.3–2.6.4)", () => {
    let jwe: string;
    let jws: string;
    let claims: JWTPayload;
    beforeAll(async () => {
      const recorder = recording(telia);
      const client = await clientOf(telia, recorder.fetch);
      const state = random();
      const nonce = random();
      const back = await telia.authorize(await client.startLogin({ state, nonce }));
      await client.completeLogin({ callbackUrl: back, state, nonce });
      const answer = recorder.answers.find((a) => a.url === TELIA_TOKEN_ENDPOINT);
      jwe = (JSON.parse(answer?.body ?? "{}") as { id_token: string }).id_token;
      const decrypted = await compactDecrypt(
        jwe,
        await importPKCS8(telia.encryptionKeyPem, "RSA-OAEP"),
      );
      jws = new TextDecoder().decode(decrypted.plaintext);
      const jwksAnswer = recorder.answers.find((a) => a.url === TELIA_JWKS);
      const verified = await jwtVerify(
        jws,
        createLocalJWKSet(JSON.parse(jwksAnswer?.body ?? "{}")),
        {
          issuer: TELIA_ISSUER,
          audience: telia.clientId,
          algorithms: ["RS256"],
        },
      );
      claims = verified.payload;
    });

    it("2.6.3: a JWE, RSA-OAEP with A128CBC-HS256, cty JWT, named by our enc key's thumbprint", () => {
      expect(jwe.split(".")).toHaveLength(5);
      expect(decodeProtectedHeader(jwe)).toEqual({
        alg: "RSA-OAEP",
        enc: "A128CBC-HS256",
        cty: "JWT",
        kid: keyIdOf(telia.encryptionKeyPem),
      });
    });

    it("2.6.3: inside, a JWS signed RS256 by Telia under a kid of its JWKS", () => {
      expect(jws.split(".")).toHaveLength(3);
      expect(decodeProtectedHeader(jws)).toMatchObject({ alg: "RS256", typ: "JWT" });
      expect(typeof decodeProtectedHeader(jws).kid).toBe("string");
    });

    it("2.6.3: iss the issuer, aud an array with azp the client, exp, iat and nonce", () => {
      expect(claims).toMatchObject({
        iss: TELIA_ISSUER,
        aud: [telia.clientId],
        azp: telia.clientId,
      });
      for (const claim of ["exp", "iat", "nonce"]) expect(claims).toHaveProperty(claim);
    });

    it("2.6.4: every claim the file lists for a Finnish person through an FTN method", () => {
      expect(Object.keys(claims)).toEqual(
        expect.arrayContaining([
          "sub",
          "auth_time",
          "acr",
          "amr",
          "session_index",
          "bank-tupasid",
          FTN_CLAIMS.personalIdentityCode,
          FTN_CLAIMS.dateOfBirth,
          FTN_CLAIMS.surname,
          FTN_CLAIMS.givenNames,
          FTN_CLAIMS.displayName,
        ]),
      );
      expect(claims.acr).toBe(ACR_LOATEST2);
      expect(claims.amr).toEqual([AKTIA]);
      expect(AKTIA).toMatch(
        /^https:\/\/tunnistus-pp\.telia\.fi\/uas\/saml2\/names\/ac\/oidc\.[a-z]+\.1$/,
      );
      expect(typeof claims.auth_time).toBe("number");
    });

    it("2.6.4: the claim names are the documented OIDs", () => {
      expect(FTN_CLAIMS).toEqual({
        personalIdentityCode: "urn:oid:1.2.246.21",
        dateOfBirth: "urn:oid:1.3.6.1.5.5.7.9.1",
        surname: "urn:oid:2.5.4.4",
        givenNames: "urn:oid:1.2.246.575.1.14",
        displayName: "urn:oid:2.16.840.1.113730.3.1.241",
      });
      expect(HETU_CLAIM).toBe("urn:oid:1.2.246.21");
    });

    it("the client reads the same shape built from the file, with the next key published in advance (2.7.1)", async () => {
      const jwks = await documentedJwks(keys);
      jwks.keys.push({
        ...(await exportJWK(keys.telia.next.publicKey)),
        kid: keys.telia.nextKid,
        use: "sig",
        alg: "RS256",
      });
      const provider = fixtureProvider({
        jwks,
        token: async () =>
          tokenResponse(
            await idToken(keys, ftnClaims("n"), {
              jwsHeader: { kid: keys.telia.nextKid },
              signWith: keys.telia.next.privateKey,
            }),
          ),
      });
      const identity = await (await fixtureClient(keys, provider)).completeLogin({
        callbackUrl: callback("s"),
        state: "s",
        nonce: "n",
      });
      expect(identity).toMatchObject({
        personalIdentityCode: "010170-999R",
        acr: ACR_LOATEST2,
        surname: "Äyrämö",
        dateOfBirth: "1970-01-01",
      });
    });
  });

  describe("the error answers (telia.md 'The flow', guide 2.5.2; RFC 6749 4.1.2.1 and 5.2)", () => {
    it("2.5.2: a person who backs out comes back with error=access_denied and the state, no code; the client takes it for no login", async () => {
      const client = await clientOf(telia);
      telia.userCancels = true;
      const state = random();
      const back = await telia.authorize(await client.startLogin({ state, nonce: "n" }));
      telia.userCancels = false;
      expect(Object.fromEntries(back.searchParams)).toEqual({ state, error: "access_denied" });
      await expect(
        client.completeLogin({ callbackUrl: back, state, nonce: "n" }),
      ).rejects.toMatchObject({
        reason: "authorization response from the server is an error",
      });
    });

    it("RFC 6749 5.2: the token endpoint refuses with status 400 and a JSON error the client reads as no login", async () => {
      const recorder = recording(telia);
      const client = await clientOf(telia, recorder.fetch);
      const state = random();
      const back = await telia.authorize(await client.startLogin({ state, nonce: "n" }));
      await client.completeLogin({ callbackUrl: back, state, nonce: "n" });
      await expect(
        client.completeLogin({ callbackUrl: back, state, nonce: "n" }),
      ).rejects.toMatchObject({
        reason: "server responded with an error in the response body",
      });
      const refusal = recorder.answers.filter((a) => a.url === TELIA_TOKEN_ENDPOINT).at(-1);
      expect(refusal?.status).toBe(400);
      const body = JSON.parse(refusal?.body ?? "{}") as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["error", "error_description"]);
      expect([
        "invalid_request",
        "invalid_client",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
      ]).toContain(body.error);
    });

    it("the double answers anything it does not serve with 404", async () => {
      const response = await telia.fetch(`${TELIA_ISSUER}/.well-known/openid-federation`, {
        method: "GET",
        headers: {},
        body: undefined,
        redirect: "manual",
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "not_found",
        path: "/uas/.well-known/openid-federation",
      });
    });
  });
});
