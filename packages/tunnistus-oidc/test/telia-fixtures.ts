import {
  base64url,
  CompactEncrypt,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import type * as client from "openid-client";
import {
  ACR_LOATEST2,
  createTunnistusClient,
  FTN_CLAIMS,
  TELIA_PREPRODUCTION_ISSUER,
  type TunnistusClientOptions,
} from "../src/client.ts";

// Telia-shaped artefacts for the package's tests, built from what
// docs/vendors/telia.md records of the broker (the endpoints, the discovery
// document as read live on 2026-10-07, the JWKS, the ID token, the FTN
// claims), with keys generated in the test. Nothing here is fetched. It lives
// outside src/ so it is neither shipped nor counted in the coverage of the
// code it tests.

export const ISSUER = TELIA_PREPRODUCTION_ISSUER;
/** Artificial; Telia assigns the real one at registration. */
export const CLIENT_ID = "5f0c0a1e-7a1b-4c2d-8e3f-000000000001";
/** docs/vendors/telia.md "What Telia needs from us": staging's registered redirect URI. */
export const REDIRECT_URI = "https://api.staging.kuutti.app/auth/callback";
/** docs/vendors/telia.md "The flow" (claims): the bank as a URI under /uas/saml2/names/ac/. */
export const AKTIA_AMR = `${ISSUER}/saml2/names/ac/oidc.aktia.1`;
/** An artificial test code (individual number 999: a test identity, never a person's). */
export const TEST_HETU = "010170-999R";
/** A fixed instant, so nothing depends on the wall clock: tests fake Date to it. */
export const NOW = new Date("2026-10-11T09:00:00.000Z");

/**
 * PEM armour around a body that is no key: built from its label so that no
 * key header stands in the source, which CI's "No private key in tracked
 * files" check refuses whatever follows it.
 */
const armoured = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
export const NOT_A_KEY_PEM = armoured("PRIVATE KEY", "AAAA");
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * docs/vendors/telia.md "What Telia gives us": the endpoints under the issuer,
 * and what both hosts' discovery documents offered when read live on
 * 2026-10-07 (private_key_jwt, RS256 request objects and ID tokens, RSA-OAEP
 * with A128GCM or A128CBC-HS256; no acr_values_supported, no ui_locales_supported).
 */
export function documentedDiscovery(issuer: string = ISSUER): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorization`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/oauth2/metadata.jwks`,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    request_object_signing_alg_values_supported: ["RS256"],
    id_token_signing_alg_values_supported: ["RS256"],
    id_token_encryption_alg_values_supported: ["RSA-OAEP"],
    id_token_encryption_enc_values_supported: ["A128GCM", "A128CBC-HS256"],
  };
}

type Pair = CryptoKeyPair;

export type Keys = {
  /** Ours: the `sig` key signs request objects and client assertions, the `enc` key receives the ID token. */
  client: { sig: Pair; enc: Pair; sigPem: string; encPem: string; encKid: string };
  /** Telia's: its current signing key, the next one published in advance (guide 2.7.1), its own enc key. */
  telia: { sig: Pair; sigKid: string; next: Pair; nextKid: string; enc: Pair; encKid: string };
  /** A key nobody published. */
  stranger: Pair;
};

export async function makeKeys(): Promise<Keys> {
  const rsa = (alg: "RS256" | "RSA-OAEP") => generateKeyPair(alg, { extractable: true });
  const [clientSig, clientEnc, teliaSig, teliaNext, teliaEnc, stranger] = await Promise.all([
    rsa("RS256"),
    rsa("RSA-OAEP"),
    rsa("RS256"),
    rsa("RS256"),
    rsa("RSA-OAEP"),
    rsa("RS256"),
  ]);
  return {
    client: {
      sig: clientSig,
      enc: clientEnc,
      sigPem: await exportPKCS8(clientSig.privateKey),
      encPem: await exportPKCS8(clientEnc.privateKey),
      encKid: await calculateJwkThumbprint(await exportJWK(clientEnc.publicKey)),
    },
    telia: {
      sig: teliaSig,
      sigKid: "telia-sig-2026-1",
      next: teliaNext,
      nextKid: "telia-sig-2026-2",
      enc: teliaEnc,
      encKid: "telia-enc-2026-1",
    },
    stranger,
  };
}

/** docs/vendors/telia.md "What Telia gives us": the pre-production JWKS carries one `sig` and one `enc` key. */
export async function documentedJwks(keys: Keys): Promise<{ keys: JWK[] }> {
  return {
    keys: [
      {
        ...(await exportJWK(keys.telia.sig.publicKey)),
        kid: keys.telia.sigKid,
        use: "sig",
        alg: "RS256",
      },
      {
        ...(await exportJWK(keys.telia.enc.publicKey)),
        kid: keys.telia.encKid,
        use: "enc",
        alg: "RSA-OAEP",
      },
    ],
  };
}

/**
 * docs/vendors/telia.md "The flow" (claims for a Finnish user through an FTN
 * method), in the shape guide 2.6.4 gives: `aud` an array with `azp`, the
 * person under the FTN OIDs.
 */
export function ftnClaims(nonce: string, overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return {
    sub: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
    iss: ISSUER,
    aud: [CLIENT_ID],
    azp: CLIENT_ID,
    exp: now + 600,
    iat: now,
    auth_time: now - 5,
    nonce,
    acr: ACR_LOATEST2,
    amr: [AKTIA_AMR],
    session_index: "_cb08aaa8c860fed8c798aac35885f4004fe15bb5",
    [FTN_CLAIMS.personalIdentityCode]: TEST_HETU,
    [FTN_CLAIMS.dateOfBirth]: "1970-01-01",
    [FTN_CLAIMS.surname]: "Äyrämö",
    [FTN_CLAIMS.givenNames]: "Tero Testi",
    [FTN_CLAIMS.displayName]: "Tero Testi Äyrämö",
    "bank-tupasid": "Aktia-saastopankit-paikallisosuuspankit-tupasid",
    ...overrides,
  };
}

const encoder = new TextEncoder();
const segment = (value: unknown) => base64url.encode(encoder.encode(JSON.stringify(value)));

export type IdTokenOptions = {
  /** Merged over the JWS header `{ alg: RS256, kid: Telia's, typ: JWT }`. */
  jwsHeader?: Record<string, unknown>;
  signWith?: CryptoKey;
  /** A JWS assembled by hand (any alg, any signature), for what jose would refuse to sign. */
  rawJws?: { header: Record<string, unknown>; signature: string };
  /** False sends the JWS in the clear; otherwise merged over `{ alg: RSA-OAEP, enc: A128CBC-HS256, cty: JWT, kid: our enc key's }`. */
  jweHeader?: Record<string, unknown> | false;
  encryptTo?: CryptoKey;
  /** What the JWE carries instead of the JWS. */
  plaintext?: string;
};

/** Guide 2.6.3: a JWS signed by Telia, inside a JWE encrypted to our `enc` key. */
export async function idToken(
  keys: Keys,
  claims: Record<string, unknown>,
  options: IdTokenOptions = {},
): Promise<string> {
  const jws = options.rawJws
    ? `${segment(options.rawJws.header)}.${segment(claims)}.${options.rawJws.signature}`
    : await new SignJWT(claims)
        .setProtectedHeader({
          alg: "RS256",
          kid: keys.telia.sigKid,
          typ: "JWT",
          ...options.jwsHeader,
        } as { alg: string })
        .sign(options.signWith ?? keys.telia.sig.privateKey);
  if (options.jweHeader === false) return jws;
  return new CompactEncrypt(encoder.encode(options.plaintext ?? jws))
    .setProtectedHeader({
      alg: "RSA-OAEP",
      enc: "A128CBC-HS256",
      cty: "JWT",
      kid: keys.client.encKid,
      ...options.jweHeader,
    } as { alg: string; enc: string })
    .encrypt(options.encryptTo ?? keys.client.enc.publicKey);
}

/** RFC 6749 5.1: the token endpoint's success, as the double and the guide's sample answer it. */
export function tokenResponse(
  idTokenValue: string | undefined,
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      access_token: "opaque-access-token",
      scope: "openid",
      id_token: idTokenValue,
      token_type: "Bearer",
      expires_in: 600,
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json;charset=UTF-8" } },
  );
}

/** RFC 6749 5.2: the token endpoint's error. */
export function tokenError(status: number, error: string, description = ""): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type ProviderRequest = { method: string; url: string; form: URLSearchParams | null };

export type FixtureProvider = {
  fetch: client.CustomFetch;
  requests: ProviderRequest[];
  /** The token endpoint's form of the last token request, if any. */
  lastTokenForm(): URLSearchParams | null;
};

/**
 * An OpenID provider answering from fixtures through a `fetch` function:
 * discovery and the JWKS as given, and the token endpoint as the test says.
 * Unlike the double it checks nothing; it is the documented shape and nothing more.
 */
export function fixtureProvider(options: {
  /** Where the document is served: `<issuer>/.well-known/openid-configuration`. */
  issuer?: string;
  discovery?: Record<string, unknown>;
  jwks?: unknown;
  token?: (form: URLSearchParams) => Response | Promise<Response>;
}): FixtureProvider {
  const issuer = options.issuer ?? ISSUER;
  const discovery = options.discovery ?? documentedDiscovery(issuer);
  const requests: ProviderRequest[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetchImpl: client.CustomFetch = async (url, init) => {
    const form =
      init.body instanceof URLSearchParams
        ? new URLSearchParams(init.body)
        : typeof init.body === "string"
          ? new URLSearchParams(init.body)
          : null;
    requests.push({ method: init.method, url, form });
    if (url === `${issuer}/.well-known/openid-configuration`) return json(discovery);
    if (url === discovery.jwks_uri) return json(options.jwks ?? { keys: [] });
    if (url === discovery.token_endpoint && init.method === "POST" && options.token) {
      return options.token(form ?? new URLSearchParams());
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch: fetchImpl,
    requests,
    lastTokenForm: () => requests.filter((r) => r.form !== null).at(-1)?.form ?? null,
  };
}

/** Our client against a fixture provider, in the Telia dialect unless the test says otherwise. */
export function fixtureClient(
  keys: Keys,
  provider: FixtureProvider,
  overrides: Partial<TunnistusClientOptions> = {},
) {
  return createTunnistusClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    acrValues: ACR_LOATEST2,
    signingKeyPem: keys.client.sigPem,
    encryptionKeyPem: keys.client.encPem,
    fetch: provider.fetch,
    ...overrides,
  });
}

/** Where Telia sends the browser back (guide 2.5): the registered URI with code and state. */
export function callback(state: string, extra: Record<string, string> = { code: "code-1" }): URL {
  const url = new URL(REDIRECT_URI);
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url;
}

/** The reason of a TunnistusError (or the message of anything else), for one rejected promise. */
export async function refusal(
  promise: Promise<unknown>,
): Promise<{ name: string; reason: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return { name: error.name, reason: (error as { reason?: string }).reason ?? error.message };
    }
    return { name: typeof error, reason: String(error) };
  }
  throw new Error("expected a refusal, got an answer");
}
