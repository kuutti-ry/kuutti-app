import { describe, expect, it } from "vitest";
import {
  FTN_CLAIMS,
  HETU_CLAIM,
  identityFromClaims,
  registeredCallbackUrl,
  TunnistusError,
} from "./client.ts";

// The two decisions of the client that need no provider: which URL the token
// request names as redirect_uri, and which ID tokens count as a login.

const LOA = "http://ftn.ficora.fi/2017/loatest2";
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://tunnistus-pp.telia.fi/uas",
  sub: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
  aud: "kuutti",
  exp: 1_800_000_000,
  iat: 1_799_999_000,
  [HETU_CLAIM]: "290793V6787",
  acr: LOA,
  amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1", 7],
  ...overrides,
});

/** The reason a TunnistusError carries. */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TunnistusError) return error.reason;
    throw error;
  }
  throw new Error("did not throw");
}

describe("registeredCallbackUrl", () => {
  it("names the registered redirect_uri, whatever Host and scheme the proxy passed on", () => {
    const seen = new URL("http://api.staging.kuutti.app/auth/callback?code=abc&state=xyz");
    const url = registeredCallbackUrl("https://api.staging.kuutti.app/auth/callback", seen);
    expect(url.origin + url.pathname).toBe("https://api.staging.kuutti.app/auth/callback");
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("xyz");
    const forged = new URL("http://evil.example/other/path?code=abc&state=xyz");
    expect(registeredCallbackUrl("https://api.kuutti.app/auth/callback", forged).host).toBe(
      "api.kuutti.app",
    );
  });
});

describe("identityFromClaims", () => {
  it("keeps the code, subject, level, methods and names; auth_time falls back to iat", () => {
    const identity = identityFromClaims(
      claims({
        session_index: "_cb08",
        jti: "72b1",
        [FTN_CLAIMS.dateOfBirth]: "1993-07-29",
        [FTN_CLAIMS.surname]: "Äyrämö",
        [FTN_CLAIMS.givenNames]: "Tero Testi",
        [FTN_CLAIMS.displayName]: "Tero Testi Äyrämö",
      }),
      null,
    );
    expect(identity).toEqual({
      personalIdentityCode: "290793V6787",
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      sessionIndex: "_cb08",
      tokenId: "72b1",
      authenticatedAt: new Date(1_799_999_000 * 1000),
      acr: LOA,
      amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1"],
      dateOfBirth: "1993-07-29",
      givenNames: "Tero Testi",
      surname: "Äyrämö",
      displayName: "Tero Testi Äyrämö",
    });
    expect(identityFromClaims(claims({ auth_time: 1_799_999_500 }), null).authenticatedAt).toEqual(
      new Date(1_799_999_500 * 1000),
    );
    // What the token does not carry is null, never undefined or a guess.
    const bare = identityFromClaims(claims(), null);
    expect([bare.sessionIndex, bare.tokenId, bare.dateOfBirth, bare.surname]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("accepts only the level that was asked for", () => {
    const expected = new Set([LOA, "http://ftn.ficora.fi/2017/loa2"]);
    expect(identityFromClaims(claims(), expected).acr).toBe(LOA);
    expect(() => identityFromClaims(claims({ acr: "mpki.telia.emulator.1" }), expected)).toThrow(
      TunnistusError,
    );
    expect(reasonOf(() => identityFromClaims(claims({ acr: undefined }), expected))).toBe("no acr");
    expect(() => identityFromClaims(claims({ acr: "anything" }), null)).not.toThrow();
  });

  it("refuses a token without an identity code", () => {
    expect(() => identityFromClaims(claims({ [HETU_CLAIM]: "" }), null)).toThrow(TunnistusError);
    expect(reasonOf(() => identityFromClaims(claims({ [HETU_CLAIM]: undefined }), null))).toBe(
      "no identity code",
    );
  });
});
