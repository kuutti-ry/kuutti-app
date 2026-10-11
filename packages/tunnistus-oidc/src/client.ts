import { importPKCS8 } from "jose";
import * as client from "openid-client";
import { isTeliaIssuer } from "./discovery.ts";
import { keyIdOf } from "./keys.ts";

/**
 * Telia Tunnistus's OpenID Connect dialect, as its integration guide (v2.36,
 * sections 2.4–2.7) specifies it: the authorization request is a signed
 * request object with `acr_values`, the token request authenticates with
 * private_key_jwt, and the ID token arrives encrypted to the client's second
 * key. The `plain` dialect is the same client against an ordinary provider
 * over http, for a local mock. Telia's signing keys rotate (guide 2.7): the
 * library keeps the JWKS for five minutes and fetches it again when a token
 * names a kid it does not hold (once the set is a minute old), so a key
 * published in advance is picked up without a restart; nothing is pinned.
 */

export const TELIA_PREPRODUCTION_ISSUER = "https://tunnistus-pp.telia.fi/uas";
export const TELIA_PRODUCTION_ISSUER = "https://tunnistus.telia.fi/uas";
/** The level Traficom 213/2023 S has a relying party ask for in production. */
export const ACR_LOA2 = "http://ftn.ficora.fi/2017/loa2";
/** The same on the pre-production bed. */
export const ACR_LOATEST2 = "http://ftn.ficora.fi/2017/loatest2";

/** The claims an FTN method returns for a Finnish person (guide 2.6.4). */
export const FTN_CLAIMS = {
  personalIdentityCode: "urn:oid:1.2.246.21",
  dateOfBirth: "urn:oid:1.3.6.1.5.5.7.9.1",
  surname: "urn:oid:2.5.4.4",
  givenNames: "urn:oid:1.2.246.575.1.14",
  displayName: "urn:oid:2.16.840.1.113730.3.1.241",
} as const;
/** The one claim a Finnish relying party must have. */
export const HETU_CLAIM = FTN_CLAIMS.personalIdentityCode;

export type TunnistusDialect = "telia" | "plain";

export type TunnistusClientOptions = {
  /** `https://tunnistus-pp.telia.fi/uas` or `https://tunnistus.telia.fi/uas`; a mock's issuer in the plain dialect. */
  issuer: string;
  /** Assigned by Telia at registration. */
  clientId: string;
  /** Registered with Telia, exact, https. */
  redirectUri: string;
  /**
   * `acr_values` of every request and the only `acr` accepted in the answer:
   * ACR_LOA2 in production, ACR_LOATEST2 on the test bed. Null sends none
   * and accepts any level, which only a mock deserves.
   */
  acrValues: string | null;
  /** PKCS#8 PEM, RSA 2048 or longer. Both required for the Telia dialect, ignored by the plain one. */
  signingKeyPem: string | null;
  encryptionKeyPem: string | null;
  /** Default: `telia` for Telia's hosts, `plain` for anything else. */
  dialect?: TunnistusDialect;
  /**
   * The HTTP client for discovery, the JWKS and the token endpoint. Tests
   * hand in the double's fetch so the dialect runs under the real issuer
   * without a network; a service leaves it unset.
   */
  fetch?: client.CustomFetch;
};

export type StartLoginInput = {
  state: string;
  nonce: string;
  /** `fi`, `sv` or `en` (guide 2.4.3). */
  uiLocales?: string | null;
  /** `login` asks the bank every time, whatever web session the broker holds (guide 2.4.3). */
  prompt?: "login" | "none" | null;
};

export type CompleteLoginInput = {
  /** The request's own URL as the service saw it; only its query is used (see `registeredCallbackUrl`). */
  callbackUrl: URL;
  state: string;
  nonce: string;
};

/** What a completed login says of the person. The identity code is for deriving, not keeping. */
export type FtnIdentity = {
  personalIdentityCode: string;
  /** `sub`: transient per Telia (2026-10-08), not an identifier of the person. */
  subject: string;
  sessionIndex: string | null;
  /** `jti`, when the token carries one. */
  tokenId: string | null;
  /** `auth_time`; `iat` only in the plain dialect, when the mock sends none. */
  authenticatedAt: Date;
  acr: string;
  /** The method as the broker names it, e.g. `https://tunnistus.telia.fi/uas/saml2/names/ac/oidc.nordea.1`. */
  amr: string[];
  dateOfBirth: string | null;
  givenNames: string | null;
  surname: string | null;
  displayName: string | null;
};

export interface TunnistusClient {
  readonly issuer: string;
  readonly dialect: TunnistusDialect;
  /** The RFC 7638 thumbprints of the two keys, what the registered JWKs must carry; null in the plain dialect. */
  readonly keyIds: { signing: string; encryption: string } | null;
  /** The URL to send the browser to: the bank chooser, or the method `acrValues` names. */
  startLogin(input: StartLoginInput): Promise<URL>;
  /** The code exchanged and every check made; throws `TunnistusError` for anything that is not a login. */
  completeLogin(input: CompleteLoginInput): Promise<FtnIdentity>;
}

/**
 * The broker answered, but not with a login: a bad token, a missing claim, a
 * refused level. The error carries the reason and nothing else: no `cause`,
 * because the underlying library attaches the decoded claims to its own
 * errors, and a consumer that serialises an error must never find the person in it.
 */
export class TunnistusError extends Error {
  constructor(readonly reason: string) {
    super(`Telia Tunnistus: ${reason}`);
    this.name = "TunnistusError";
  }
}

export async function createTunnistusClient(
  options: TunnistusClientOptions,
): Promise<TunnistusClient> {
  const dialect: TunnistusDialect =
    options.dialect ?? (isTeliaIssuer(options.issuer) ? "telia" : "plain");
  const telia = dialect === "telia";
  if (telia && (!options.signingKeyPem || !options.encryptionKeyPem)) {
    throw new TunnistusError("the telia dialect needs the signing and encryption keys");
  }
  const signingKey =
    telia && options.signingKeyPem
      ? await importPKCS8(options.signingKeyPem, "RS256", { extractable: false })
      : null;
  const encryptionKey =
    telia && options.encryptionKeyPem
      ? await importPKCS8(options.encryptionKeyPem, "RSA-OAEP", { extractable: false })
      : null;

  // Guide 2.6.2 has the client assertion's aud as the token endpoint, where
  // the library would put the issuer. The hook runs at token-request time,
  // when discovery has filled the endpoint.
  const assertionAudience: client.ModifyAssertionOptions = {
    [client.modifyAssertion]: (_header, payload) => {
      const tokenEndpoint = configuration.serverMetadata().token_endpoint;
      if (tokenEndpoint) payload.aud = tokenEndpoint;
    },
  };
  const configuration: client.Configuration = await client.discovery(
    new URL(options.issuer),
    options.clientId,
    { id_token_signed_response_alg: "RS256" },
    signingKey ? client.PrivateKeyJwt(signingKey, assertionAudience) : client.None(),
    {
      execute: telia ? [] : [client.allowInsecureRequests],
      ...(options.fetch ? { [client.customFetch]: options.fetch } : {}),
    },
  );
  // The library trusts a token it fetched itself over TLS and skips the JWS
  // signature by default; the guide (2.6.3) wants it verified against the
  // issuer's JWKS, which is also what makes a rotated key visible.
  client.enableNonRepudiationChecks(configuration);
  if (encryptionKey && options.encryptionKeyPem) {
    // The content encryptions Telia's metadata offers (both hosts, read
    // 2026-10-07): the guide's A128CBC-HS256 and A128GCM.
    client.enableDecryptingResponses(configuration, ["A128CBC-HS256", "A128GCM"], {
      key: encryptionKey,
      kid: keyIdOf(options.encryptionKeyPem),
    });
  }

  const expectedAcr = acrSet(options.acrValues);
  const keyIds =
    telia && options.signingKeyPem && options.encryptionKeyPem
      ? { signing: keyIdOf(options.signingKeyPem), encryption: keyIdOf(options.encryptionKeyPem) }
      : null;

  return {
    issuer: options.issuer,
    dialect,
    keyIds,

    async startLogin(input) {
      const parameters: Record<string, string> = {
        redirect_uri: options.redirectUri,
        scope: "openid",
        response_type: "code",
        state: input.state,
        nonce: input.nonce,
      };
      if (options.acrValues) parameters.acr_values = options.acrValues;
      if (input.uiLocales) parameters.ui_locales = input.uiLocales;
      if (input.prompt) parameters.prompt = input.prompt;
      if (signingKey) {
        // Telia: the request is a signed JWT (RFC 9101) with the sig key;
        // iss, aud, client_id, jti, iat and exp are added by the library. The
        // header and lifetime follow the guide's sample (2.4.3–2.4.4): typ JWT,
        // ten minutes; nbf is not in the guide and would trip a slow clock.
        return client.buildAuthorizationUrlWithJAR(configuration, parameters, signingKey, {
          [client.modifyAssertion]: (header, payload) => {
            header.typ = "JWT";
            if (typeof payload.iat === "number") payload.exp = payload.iat + 600;
            delete payload.nbf;
          },
        });
      }
      return client.buildAuthorizationUrl(configuration, parameters);
    },

    async completeLogin(input) {
      const callbackUrl = registeredCallbackUrl(options.redirectUri, input.callbackUrl);
      let claims: client.IDToken | undefined;
      try {
        const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
          expectedState: input.state,
          expectedNonce: input.nonce,
          idTokenExpected: true,
        });
        // Telia always encrypts the ID token (guide 2.6.3); one that arrives
        // in the clear is not from Telia, whatever its signature says.
        if (encryptionKey && (tokens.id_token ?? "").split(".").length !== 5) {
          throw new TunnistusError("ID token was not encrypted");
        }
        claims = tokens.claims();
        // Telia sends auth_time (guide 2.6.4); a caller's freshness rule
        // stands on it, and a token without it must not read as fresh.
        if (telia && typeof claims?.auth_time !== "number") {
          throw new TunnistusError("no auth_time");
        }
      } catch (error) {
        if (error instanceof TunnistusError) throw error;
        // The library's messages name codes and checks, never claims; its
        // error objects do carry the claims, and are left behind here.
        throw new TunnistusError(error instanceof Error ? error.message : "token exchange failed");
      }
      if (!claims) throw new TunnistusError("no ID token");
      return identityFromClaims(claims, expectedAcr);
    },
  };
}

function acrSet(acrValues: string | null): Set<string> | null {
  const values = acrValues?.split(/\s+/).filter((v) => v.length > 0) ?? [];
  return values.length > 0 ? new Set(values) : null;
}

/**
 * The library sends the callback URL, minus its query, as the token request's
 * redirect_uri. The request's own URL is whatever the Host header and the
 * TLS-terminating proxy made of it (http://… behind a proxy), so the
 * registered value is used and only the broker's answer is taken from the request.
 */
export function registeredCallbackUrl(redirectUri: string, requestUrl: URL): URL {
  const url = new URL(redirectUri);
  url.search = requestUrl.search;
  return url;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The ID token's claims reduced to the answer; `expectedAcr` is the set asked for, if any. */
export function identityFromClaims(
  claims: client.IDToken,
  expectedAcr: ReadonlySet<string> | null,
): FtnIdentity {
  const personalIdentityCode = claims[HETU_CLAIM];
  if (typeof personalIdentityCode !== "string" || personalIdentityCode.length === 0) {
    throw new TunnistusError("no identity code");
  }
  const acr = typeof claims.acr === "string" ? claims.acr : null;
  if (!acr) throw new TunnistusError("no acr");
  // The level asked for is the level accepted: a weaker one (a test
  // emulator, a lower LoA) is a broker misconfiguration, not a login.
  if (expectedAcr && !expectedAcr.has(acr)) throw new TunnistusError("unexpected acr");
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((v) => typeof v === "string") : [];
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : claims.iat;
  return {
    personalIdentityCode,
    subject: claims.sub,
    sessionIndex: text(claims.session_index),
    tokenId: text(claims.jti),
    authenticatedAt: new Date(authTime * 1000),
    acr,
    amr,
    dateOfBirth: text(claims[FTN_CLAIMS.dateOfBirth]),
    givenNames: text(claims[FTN_CLAIMS.givenNames]),
    surname: text(claims[FTN_CLAIMS.surname]),
    displayName: text(claims[FTN_CLAIMS.displayName]),
  };
}
