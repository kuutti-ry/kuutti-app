import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  CompactEncrypt,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import type * as client from "openid-client";

/**
 * Telia Tunnistus as its integration guide describes it (docs/vendors/telia.md,
 * guide v2.36 sections 2.2–2.7), in process: an OpenID provider under the real
 * pre-production issuer that answers through a `fetch` function, so the API's
 * Telia dialect (signed request object, private_key_jwt, encrypted ID token,
 * key rotation) is exercised without a network, a port or a contract. Every
 * requirement the guide states is checked here and refused with a reason;
 * the toggles in `misbehave` make it answer wrongly on purpose so the API's
 * own verification is seen to refuse.
 */
export const TELIA_ISSUER = "https://tunnistus-pp.telia.fi/uas";
export const TELIA_AUTHORIZATION_ENDPOINT = `${TELIA_ISSUER}/oauth2/authorization`;
export const TELIA_TOKEN_ENDPOINT = `${TELIA_ISSUER}/oauth2/token`;
export const TELIA_JWKS = `${TELIA_ISSUER}/oauth2/metadata.jwks`;
export const LOATEST2 = "http://ftn.ficora.fi/2017/loatest2";
export const AKTIA = "https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Guide 2.6.4: what an FTN method returns for a Finnish person (test code, not a real one). */
export type Person = {
  hetu: string;
  dateOfBirth: string;
  acr?: string;
  amr?: string[];
};

export type Misbehaviour = {
  /** The ID token comes back as a plain JWS instead of a JWE. */
  plainIdToken?: boolean;
  /** Signed with a key the JWKS does not publish. */
  rogueKey?: boolean;
  /** The nonce of some other login. */
  wrongNonce?: boolean;
  /** The token is for another client. */
  wrongAudience?: boolean;
  /** A non-Finnish method (guide 2.6.5): no personal identity code. */
  omitHetu?: boolean;
  /** No auth_time in the ID token, against 2.6.4. */
  omitAuthTime?: boolean;
};

type Seen = {
  requestObject: JWTPayload | null;
  requestHeader: Record<string, unknown> | null;
  authorizationQuery: Record<string, string> | null;
  tokenForm: Record<string, string> | null;
  assertion: JWTPayload | null;
  assertionHeader: Record<string, unknown> | null;
  jwksFetches: number;
  /** What the authorization endpoint refused, for the test's own reading. */
  refusals: string[];
};

export type FakeTelia = {
  fetch: client.CustomFetch;
  clientId: string;
  redirectUri: string;
  signingKeyPem: string;
  encryptionKeyPem: string;
  person: Person;
  misbehave: Misbehaviour;
  /** The JWE content encryption: the guide's A128CBC-HS256, or the A128GCM Telia's metadata also lists. */
  enc: "A128CBC-HS256" | "A128GCM";
  userCancels: boolean;
  seen: Seen;
  /** The browser's trip to the authorization endpoint: the URL Telia sends it back to. */
  authorize(url: URL): Promise<URL>;
  /** Guide 2.7.1: a new signing key is published; tokens are signed with it from now on. */
  rotateSigningKey(): Promise<void>;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const opaque = () => randomBytes(24).toString("base64url");

export async function fakeTelia(options: { person?: Person } = {}): Promise<FakeTelia> {
  const clientId = "0043b426-2e6d-466d-b82f-33bb7d3cb6ea";
  const redirectUri = "https://api.staging.kuutti.app/auth/callback";
  const clientSig = await generateKeyPair("RS256", { extractable: true });
  const clientEnc = await generateKeyPair("RSA-OAEP", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  let teliaSig = await generateKeyPair("RS256", { extractable: true });
  let teliaKid = "telia-2026-1";
  // Telia names our enc key by the kid of the JWK we registered (guide 2.6.3);
  // ours is the key's RFC 7638 thumbprint (infra/README.md).
  const clientEncKid = await calculateJwkThumbprint(await exportJWK(clientEnc.publicKey));

  const pending = new Map<
    string,
    { nonce: string; state: string; redirectUri: string; acrValues: string }
  >();
  const usedJti = new Set<string>();

  const telia: FakeTelia = {
    fetch: async (url, init) =>
      app.fetch(
        new Request(url, {
          method: init.method,
          headers: init.headers,
          body: (init.body ?? null) as BodyInit | null,
          redirect: init.redirect,
          signal: init.signal ?? null,
        }),
      ),
    clientId,
    redirectUri,
    signingKeyPem: await exportPKCS8(clientSig.privateKey),
    encryptionKeyPem: await exportPKCS8(clientEnc.privateKey),
    person: options.person ?? {
      hetu: "010170-999R",
      dateOfBirth: "1970-01-01",
    },
    misbehave: {},
    enc: "A128CBC-HS256",
    userCancels: false,
    seen: {
      requestObject: null,
      requestHeader: null,
      authorizationQuery: null,
      tokenForm: null,
      assertion: null,
      assertionHeader: null,
      jwksFetches: 0,
      refusals: [],
    },
    async authorize(url) {
      const res = await app.fetch(new Request(url, { redirect: "manual" }));
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) {
        throw new Error(`authorization endpoint answered ${res.status}: ${await res.text()}`);
      }
      return new URL(location);
    },
    async rotateSigningKey() {
      teliaSig = await generateKeyPair("RS256", { extractable: true });
      teliaKid = `telia-2026-${opaque().slice(0, 6)}`;
    },
  };

  const app = new Hono();

  // Guide 2.2: the provider metadata; private_key_jwt is the only client authentication.
  app.get("/uas/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: TELIA_ISSUER,
      authorization_endpoint: TELIA_AUTHORIZATION_ENDPOINT,
      token_endpoint: TELIA_TOKEN_ENDPOINT,
      jwks_uri: TELIA_JWKS,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      scopes_supported: ["openid"],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256"],
      id_token_signing_alg_values_supported: ["RS256"],
      id_token_encryption_alg_values_supported: ["RSA-OAEP"],
      id_token_encryption_enc_values_supported: ["A128CBC-HS256"],
      request_parameter_supported: true,
      request_object_signing_alg_values_supported: ["RS256"],
      require_signed_request_object: true,
      acr_values_supported: [LOATEST2, "mpki.telia.emulator.1", "oidc.aktia.1"],
      ui_locales_supported: ["fi", "sv", "en"],
    }),
  );

  // Guide 2.2 and 2.7: the public keys, the current one under its kid.
  app.get("/uas/oauth2/metadata.jwks", async (c) => {
    telia.seen.jwksFetches += 1;
    const jwk = await exportJWK(teliaSig.publicKey);
    return c.json({ keys: [{ ...jwk, kid: teliaKid, use: "sig", alg: "RS256" }] });
  });

  // Guide 2.4: the authentication request is a signed request object, and only that.
  app.get("/uas/oauth2/authorization", async (c) => {
    const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    telia.seen.authorizationQuery = query;
    const refuse = (reason: string) => {
      telia.seen.refusals.push(reason);
      return c.json({ error: "invalid_request", error_description: reason }, 400);
    };
    const request = query.request;
    if (!request) return refuse("no request object (guide 2.4.1)");
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(request, clientSig.publicKey, {
        algorithms: ["RS256"],
        issuer: clientId,
        audience: TELIA_ISSUER,
      });
      payload = verified.payload;
      telia.seen.requestObject = payload;
      telia.seen.requestHeader = verified.protectedHeader;
    } catch (error) {
      return refuse(`request object rejected: ${error instanceof Error ? error.message : "?"}`);
    }
    // Guide 2.4.4: the sample header is typ JWT; nbf is not in the guide.
    if (telia.seen.requestHeader?.typ !== "JWT") return refuse("request object typ must be JWT");
    if ("nbf" in payload) return refuse("nbf is not a request object claim here");
    // Guide 2.4.2, the required claims.
    if (payload.response_type !== "code") return refuse("response_type must be code");
    if (payload.scope !== "openid") return refuse("scope must be openid");
    if (payload.client_id !== clientId) return refuse("client_id is not the registered client");
    if (payload.redirect_uri !== redirectUri) return refuse("redirect_uri is not registered");
    if (typeof payload.acr_values !== "string" || payload.acr_values.length === 0) {
      return refuse("acr_values is mandatory (Traficom 213/2023 S)");
    }
    if (typeof payload.state !== "string" || typeof payload.nonce !== "string") {
      return refuse("state and nonce are expected");
    }
    if (typeof payload.exp !== "number" || payload.exp < nowSeconds()) {
      return refuse("request object expired or without exp");
    }
    const back = new URL(payload.redirect_uri);
    back.searchParams.set("state", payload.state);
    // Guide 2.5.2: the person backs out at the bank.
    if (telia.userCancels) {
      back.searchParams.set("error", "access_denied");
      return c.redirect(back.toString(), 302);
    }
    const code = opaque();
    pending.set(code, {
      nonce: payload.nonce,
      state: payload.state,
      redirectUri: payload.redirect_uri,
      acrValues: payload.acr_values,
    });
    back.searchParams.set("code", code);
    return c.redirect(back.toString(), 302);
  });

  // Guide 2.6: private_key_jwt, then the encrypted and signed ID token.
  app.post("/uas/oauth2/token", async (c) => {
    const form = Object.fromEntries(new URLSearchParams(await c.req.text()).entries()) as Record<
      string,
      string
    >;
    telia.seen.tokenForm = form;
    const refuse = (error: string, reason: string) =>
      c.json({ error, error_description: reason }, 400);
    if (form.grant_type !== "authorization_code") return refuse("unsupported_grant_type", "");
    if (form.client_id !== clientId) return refuse("invalid_client", "client_id");
    if (form.client_assertion_type !== CLIENT_ASSERTION_TYPE) {
      return refuse("invalid_client", "client_assertion_type");
    }
    if (!form.client_assertion) return refuse("invalid_client", "no client_assertion");
    let assertion: JWTPayload;
    try {
      const verified = await jwtVerify(form.client_assertion, clientSig.publicKey, {
        algorithms: ["RS256"],
        issuer: clientId,
        subject: clientId,
        audience: TELIA_TOKEN_ENDPOINT,
      });
      assertion = verified.payload;
      telia.seen.assertion = assertion;
      telia.seen.assertionHeader = verified.protectedHeader;
    } catch (error) {
      return refuse("invalid_client", error instanceof Error ? error.message : "assertion");
    }
    // Guide 2.6.2: exp within 60 minutes, jti single use.
    if (typeof assertion.exp !== "number" || assertion.exp > nowSeconds() + 3600) {
      return refuse("invalid_client", "exp more than 60 minutes ahead");
    }
    if (typeof assertion.jti !== "string" || usedJti.has(assertion.jti)) {
      return refuse("invalid_client", "jti missing or reused");
    }
    usedJti.add(assertion.jti);
    const login = form.code ? pending.get(form.code) : undefined;
    if (!login) return refuse("invalid_grant", "unknown or used code");
    pending.delete(form.code ?? "");
    if (form.redirect_uri !== login.redirectUri) return refuse("invalid_grant", "redirect_uri");

    const now = nowSeconds();
    const { person, misbehave } = telia;
    const claims: Record<string, unknown> = {
      sub: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      iss: TELIA_ISSUER,
      aud: [misbehave.wrongAudience ? "some-other-client" : clientId],
      azp: clientId,
      exp: now + 600,
      iat: now,
      auth_time: now - 1,
      nonce: misbehave.wrongNonce ? opaque() : login.nonce,
      acr: person.acr ?? LOATEST2,
      amr: person.amr ?? [AKTIA],
      session_index: "_cb08aaa8c860fed8c798aac35885f4004fe15bb5",
      "urn:oid:1.3.6.1.5.5.7.9.1": person.dateOfBirth,
      "urn:oid:2.5.4.4": "Äyrämö",
      "urn:oid:1.2.246.575.1.14": "Tero Testi",
      "urn:oid:2.16.840.1.113730.3.1.241": "Tero Testi Äyrämö",
      "bank-tupasid": "Aktia-saastopankit-paikallisosuuspankit-tupasid",
    };
    if (!misbehave.omitHetu) claims["urn:oid:1.2.246.21"] = person.hetu;
    if (misbehave.omitAuthTime) delete claims.auth_time;
    const signer = misbehave.rogueKey ? rogue.privateKey : teliaSig.privateKey;
    const jws = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: teliaKid, typ: "JWT" })
      .sign(signer);
    const idToken = misbehave.plainIdToken
      ? jws
      : await new CompactEncrypt(new TextEncoder().encode(jws))
          .setProtectedHeader({
            alg: "RSA-OAEP",
            enc: telia.enc,
            cty: "JWT",
            kid: clientEncKid,
          })
          .encrypt(clientEnc.publicKey);
    c.header("content-type", "application/json;charset=UTF-8");
    return c.body(
      JSON.stringify({
        access_token: opaque(),
        scope: "openid",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 600,
      }),
      200,
    );
  });

  app.notFound((c) => c.json({ error: "not_found", path: new URL(c.req.url).pathname }, 404));

  return telia;
}

/** The protected header of a compact JWS or JWE, for assertions on what Telia was sent. */
export const headerOf = (token: string): Record<string, unknown> =>
  decodeProtectedHeader(token) as Record<string, unknown>;
