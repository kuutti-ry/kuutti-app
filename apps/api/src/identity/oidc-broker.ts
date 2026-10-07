import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { importPKCS8 } from "jose";
import * as client from "openid-client";
import type { Config } from "../lib/config.ts";
import { BrokerError, type BrokerIdentity, HETU_CLAIM, type IdentityBroker } from "./broker.ts";
import { isTeliaIssuer } from "./discovery.ts";

/**
 * The OpenID Connect adapter (#33, docs/vendors/telia.md). One implementation,
 * two configurations: against Telia the authorization request is a signed
 * request object with `acr_values`, the token request authenticates with
 * private_key_jwt, and the ID token arrives encrypted to our second key; against
 * the mock IdP it is plain OIDC over http. Both are decided by the issuer at
 * boot, never per request. Telia's signing keys rotate (guide 2.7): the
 * library keeps the JWKS for five minutes and fetches it again when a token
 * names a kid it does not hold (once the set is a minute old), so a key
 * published in advance is picked up without a restart; nothing is pinned.
 */
export type OidcBrokerOptions = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  acrValues: string | null;
  /** PEM (PKCS#8). Both required for a Telia issuer, both ignored for the mock. */
  signingKeyPem: string | null;
  encryptionKeyPem: string | null;
  /**
   * The HTTP client for discovery, JWKS and the token endpoint. Tests hand in
   * an in-process fake of Telia (src/test/fake-telia.ts) so the Telia dialect
   * runs under the real issuer without a network; production leaves it unset.
   */
  fetch?: client.CustomFetch;
};

/**
 * The `kid` of one of our keys is its RFC 7638 thumbprint: the JWK handed to
 * Telia carries it (infra/README.md, Secrets), Telia names it in the JWE
 * header of every ID token (guide 2.6.3), and the library decrypts only with
 * the key whose kid the header names. Computed from the private key, so no
 * configuration can disagree with the key.
 */
export function keyIdOf(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" });
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("a Telia key is RSA (guide 2.1.1)");
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash("sha256").update(canonical).digest("base64url");
}

/** The kids the maintainer compares with what Telia registered; public values, logged at boot. */
export function teliaKeyIds(config: Config): { signing: string | null; encryption: string | null } {
  return {
    signing: config.TELIA_SIGNING_KEY ? keyIdOf(config.TELIA_SIGNING_KEY) : null,
    encryption: config.TELIA_ENCRYPTION_KEY ? keyIdOf(config.TELIA_ENCRYPTION_KEY) : null,
  };
}

export function brokerOptionsFromConfig(config: Config): OidcBrokerOptions | null {
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID || !config.OIDC_REDIRECT_URI) return null;
  return {
    issuer: config.OIDC_ISSUER,
    clientId: config.OIDC_CLIENT_ID,
    redirectUri: config.OIDC_REDIRECT_URI,
    acrValues: config.OIDC_ACR_VALUES ?? null,
    signingKeyPem: config.TELIA_SIGNING_KEY ?? null,
    encryptionKeyPem: config.TELIA_ENCRYPTION_KEY ?? null,
  };
}

export class OidcBroker implements IdentityBroker {
  private readonly expectedAcr: Set<string> | null;

  private constructor(
    readonly issuer: string,
    private readonly configuration: client.Configuration,
    private readonly options: OidcBrokerOptions,
    private readonly signingKey: CryptoKey | null,
    private readonly expectsEncryptedIdToken: boolean,
  ) {
    const values = options.acrValues?.split(/\s+/).filter((v) => v.length > 0) ?? [];
    this.expectedAcr = values.length > 0 ? new Set(values) : null;
  }

  /** Discovery once, at boot; a Telia issuer without our keys is a configuration error. */
  static async create(options: OidcBrokerOptions): Promise<OidcBroker> {
    const telia = isTeliaIssuer(options.issuer);
    if (telia && (!options.signingKeyPem || !options.encryptionKeyPem)) {
      throw new Error("a Telia issuer needs TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY");
    }
    const signingKey = options.signingKeyPem
      ? await importPKCS8(options.signingKeyPem, "RS256", { extractable: false })
      : null;
    const encryptionKey = options.encryptionKeyPem
      ? await importPKCS8(options.encryptionKeyPem, "RSA-OAEP", { extractable: false })
      : null;

    // Telia's guide has the client assertion's aud as the token endpoint
    // (docs/vendors/telia.md), where the library would put the issuer. The
    // hook runs at token-request time, when discovery has filled the endpoint.
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
      telia && signingKey ? client.PrivateKeyJwt(signingKey, assertionAudience) : client.None(),
      {
        execute: telia ? [] : [client.allowInsecureRequests],
        ...(options.fetch ? { [client.customFetch]: options.fetch } : {}),
      },
    );
    // The library trusts a token it fetched itself over TLS and skips the JWS
    // signature by default; the guide (2.6.3) and rules/api.md want it verified
    // against the issuer's JWKS, which is also what makes a rotated key visible.
    client.enableNonRepudiationChecks(configuration);
    if (encryptionKey && options.encryptionKeyPem) {
      // The content encryptions Telia's metadata offers (id_token_encryption_enc_values_supported
      // on both hosts, read 2026-10-07): the guide's A128CBC-HS256 and A128GCM.
      client.enableDecryptingResponses(configuration, ["A128CBC-HS256", "A128GCM"], {
        key: encryptionKey,
        kid: keyIdOf(options.encryptionKeyPem),
      });
    }
    return new OidcBroker(
      options.issuer,
      configuration,
      options,
      signingKey,
      encryptionKey !== null,
    );
  }

  async startLogin(input: { state: string; nonce: string; locale: string | null }): Promise<URL> {
    const parameters: Record<string, string> = {
      redirect_uri: this.options.redirectUri,
      scope: "openid",
      response_type: "code",
      state: input.state,
      nonce: input.nonce,
      // ADR-016: the bank, every time. The broker keeps a web session in the
      // system browser, and on a shared phone the second person must never be
      // let in under the first one's identity (guide 2.4.3: prompt=login).
      prompt: "login",
    };
    if (this.options.acrValues) parameters.acr_values = this.options.acrValues;
    if (input.locale) parameters.ui_locales = input.locale;
    if (this.signingKey) {
      // Telia: the request is a signed JWT (RFC 9101) with our sig key; iss,
      // aud, client_id, jti, iat and exp are added by the library. The header
      // and lifetime follow the guide's sample (2.4.3–2.4.4): typ JWT, ten
      // minutes; nbf is not in the guide and would trip a slow broker clock.
      return client.buildAuthorizationUrlWithJAR(this.configuration, parameters, this.signingKey, {
        [client.modifyAssertion]: (header, payload) => {
          header.typ = "JWT";
          if (typeof payload.iat === "number") payload.exp = payload.iat + 600;
          delete payload.nbf;
        },
      });
    }
    return client.buildAuthorizationUrl(this.configuration, parameters);
  }

  async completeLogin(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
  }): Promise<BrokerIdentity> {
    const callbackUrl = registeredCallbackUrl(this.options.redirectUri, input.callbackUrl);
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(this.configuration, callbackUrl, {
        expectedState: input.state,
        expectedNonce: input.nonce,
        idTokenExpected: true,
      });
      // Telia always encrypts the ID token to our key (guide 2.6.3); one that
      // arrives in the clear is not from Telia, whatever its signature says.
      if (this.expectsEncryptedIdToken && (tokens.id_token ?? "").split(".").length !== 5) {
        throw new BrokerError("ID token was not encrypted");
      }
      claims = tokens.claims();
      // Telia sends auth_time (guide 2.6.4) and ADR-016 stands on it: a token
      // without it would make the freshness check read the issue time instead.
      if (this.expectsEncryptedIdToken && typeof claims?.auth_time !== "number") {
        throw new BrokerError("no auth_time");
      }
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      // The library's messages name codes and checks, never claims.
      throw new BrokerError(error instanceof Error ? error.message : "token exchange failed");
    }
    if (!claims) throw new BrokerError("no ID token");
    return identityFromClaims(claims, this.expectedAcr);
  }
}

/**
 * The library sends the callback URL, minus its query, as the token request's
 * redirect_uri. The request's own URL is whatever the Host header and the
 * TLS-terminating proxy made of it (http://… behind Traefik), so the registered
 * value is used and only the bank's answer is taken from the request.
 */
export function registeredCallbackUrl(redirectUri: string, requestUrl: URL): URL {
  const url = new URL(redirectUri);
  url.search = requestUrl.search;
  return url;
}

/** The ID token's claims reduced to the broker's answer; `expectedAcr` is the set asked for, if any. */
export function identityFromClaims(
  claims: client.IDToken,
  expectedAcr: ReadonlySet<string> | null,
): BrokerIdentity {
  const hetu = claims[HETU_CLAIM];
  if (typeof hetu !== "string" || hetu.length === 0) throw new BrokerError("no identity code");
  const acr = typeof claims.acr === "string" ? claims.acr : null;
  if (!acr) throw new BrokerError("no acr");
  // The level we asked for is the level we accept: a weaker one (a test
  // emulator, a lower LoA) is a broker misconfiguration, not a login.
  if (expectedAcr && !expectedAcr.has(acr)) throw new BrokerError("unexpected acr");
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((v) => typeof v === "string") : [];
  const authTime = typeof claims.auth_time === "number" ? claims.auth_time : claims.iat;
  return {
    hetu,
    subject: claims.sub,
    sessionIndex: typeof claims.session_index === "string" ? claims.session_index : null,
    tokenId: typeof claims.jti === "string" ? claims.jti : null,
    authenticatedAt: new Date(authTime * 1000),
    acr,
    amr,
  };
}
