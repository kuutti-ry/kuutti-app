import fc from "fast-check";
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

const SEEDED = { seed: 20261011 };
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

  it("takes the query only: the request's fragment, user info and port stay behind", () => {
    const seen = new URL("http://user:pw@10.0.0.7:8080/auth/callback?code=abc&state=xyz#frag");
    const url = registeredCallbackUrl("https://api.kuutti.app/auth/callback", seen);
    expect(url.href).toBe("https://api.kuutti.app/auth/callback?code=abc&state=xyz");
  });

  it("replaces a query the registered URI might carry, and adds none when the request has none", () => {
    expect(
      registeredCallbackUrl(
        "https://api.kuutti.app/auth/callback?from=registration",
        new URL("https://x.example/cb?code=1&state=2"),
      ).search,
    ).toBe("?code=1&state=2");
    expect(
      registeredCallbackUrl("https://api.kuutti.app/auth/callback", new URL("https://x.example/cb"))
        .href,
    ).toBe("https://api.kuutti.app/auth/callback");
  });

  it("carries the broker's answer byte for byte: percent-encoding, plus signs, Unicode and repeated keys", () => {
    const seen = new URL(
      "http://x.example/cb?code=a%2Bb+c&state=%C3%A4%F0%9F%98%80&error_description=Peruttu%20%E2%80%93%20k%C3%A4ytt%C3%A4j%C3%A4&x=1&x=2",
    );
    const url = registeredCallbackUrl("https://api.kuutti.app/auth/callback", seen);
    expect(url.search).toBe(seen.search);
    expect(url.searchParams.get("code")).toBe("a+b c");
    expect(url.searchParams.get("state")).toBe("ä😀");
    expect(url.searchParams.getAll("x")).toEqual(["1", "2"]);
  });

  it("refuses a registered value that is not a URL, before anything is sent", () => {
    expect(() => registeredCallbackUrl("/auth/callback", new URL("https://x.example/cb"))).toThrow(
      TypeError,
    );
  });

  it("keeps the registered URI and the request's query for any query (property)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ maxLength: 12 }), {
          maxKeys: 5,
        }),
        (params) => {
          const seen = new URL("http://internal:3000/auth/callback");
          for (const [key, value] of Object.entries(params)) seen.searchParams.append(key, value);
          const url = registeredCallbackUrl("https://api.kuutti.app/auth/callback", seen);
          expect(url.origin + url.pathname).toBe("https://api.kuutti.app/auth/callback");
          expect([...url.searchParams.entries()]).toEqual([...seen.searchParams.entries()]);
        },
      ),
      SEEDED,
    );
  });
});

describe("TunnistusError", () => {
  it("names the broker, carries the reason, and nothing else", () => {
    const error = new TunnistusError("no auth_time");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TunnistusError");
    expect(error.message).toBe("Telia Tunnistus: no auth_time");
    expect(error.reason).toBe("no auth_time");
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual(["reason", "name"]);
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

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["null", null],
    ["a number", 290793],
    ["an array", ["290793V6787"]],
    ["an object", { value: "290793V6787" }],
    ["a boolean", true],
  ])("refuses an identity code that is %s", (_name, value) => {
    expect(reasonOf(() => identityFromClaims(claims({ [HETU_CLAIM]: value }), null))).toBe(
      "no identity code",
    );
  });

  it("passes the identity code through as sent: its format is the caller's check (./hetu)", () => {
    for (const code of [" ", "not-a-hetu", "290793v6787"]) {
      expect(identityFromClaims(claims({ [HETU_CLAIM]: code }), null).personalIdentityCode).toBe(
        code,
      );
    }
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["null", null],
    ["a number", 2],
    ["an array", [LOA]],
  ])("refuses an acr that is %s, whatever level was asked for", (_name, value) => {
    expect(reasonOf(() => identityFromClaims(claims({ acr: value }), null))).toBe("no acr");
    expect(reasonOf(() => identityFromClaims(claims({ acr: value }), new Set([LOA])))).toBe(
      "no acr",
    );
  });

  it("compares the level exactly: case, whitespace and a near miss are another level", () => {
    const expected = new Set([LOA]);
    for (const acr of [LOA.toUpperCase(), ` ${LOA}`, `${LOA}/`, "http://ftn.ficora.fi/2017/loa2"]) {
      expect(reasonOf(() => identityFromClaims(claims({ acr }), expected))).toBe("unexpected acr");
    }
  });

  it("checks the identity code before the level", () => {
    expect(
      reasonOf(() => identityFromClaims(claims({ [HETU_CLAIM]: undefined, acr: "x" }), new Set())),
    ).toBe("no identity code");
  });

  it.each([
    ["missing", undefined, []],
    ["a single string, not an array", "oidc.aktia.1", []],
    ["an empty array", [], []],
    ["mixed", ["a", 1, null, "b", { c: 1 }], ["a", "b"]],
  ])("reads amr that is %s", (_name, value, expected) => {
    expect(identityFromClaims(claims({ amr: value }), null).amr).toEqual(expected);
  });

  it.each([
    ["empty", ""],
    ["a number", 19930729],
    ["null", null],
    ["an object", { fi: "Tero" }],
    ["an array", ["Tero"]],
  ])("reads an optional text claim that is %s as null", (_name, value) => {
    const identity = identityFromClaims(
      claims({
        session_index: value,
        jti: value,
        [FTN_CLAIMS.dateOfBirth]: value,
        [FTN_CLAIMS.givenNames]: value,
        [FTN_CLAIMS.surname]: value,
        [FTN_CLAIMS.displayName]: value,
      }),
      null,
    );
    expect([
      identity.sessionIndex,
      identity.tokenId,
      identity.dateOfBirth,
      identity.givenNames,
      identity.surname,
      identity.displayName,
    ]).toEqual([null, null, null, null, null, null]);
  });

  it("keeps names exactly as sent: no trimming, no Unicode normalisation", () => {
    const decomposed = "Äyrämö"; // Äyrämö as NFD
    const identity = identityFromClaims(
      claims({ [FTN_CLAIMS.surname]: decomposed, [FTN_CLAIMS.givenNames]: " Tero  Testi " }),
      null,
    );
    expect(identity.surname).toBe(decomposed);
    expect(identity.surname).not.toBe(decomposed.normalize("NFC"));
    expect(identity.givenNames).toBe(" Tero  Testi ");
  });

  it("takes auth_time only as a number; anything else falls back to iat", () => {
    expect(identityFromClaims(claims({ auth_time: 0 }), null).authenticatedAt).toEqual(new Date(0));
    expect(identityFromClaims(claims({ auth_time: "1799999500" }), null).authenticatedAt).toEqual(
      new Date(1_799_999_000 * 1000),
    );
  });

  it("answers with the identity's fields only: bank-tupasid and other claims stay behind", () => {
    const identity = identityFromClaims(
      claims({ "bank-tupasid": "Aktia-tupasid", nonce: "n", azp: "kuutti", email: "x@example.fi" }),
      null,
    );
    expect(Object.keys(identity).sort()).toEqual([
      "acr",
      "amr",
      "authenticatedAt",
      "dateOfBirth",
      "displayName",
      "givenNames",
      "personalIdentityCode",
      "sessionIndex",
      "subject",
      "surname",
      "tokenId",
    ]);
  });

  it("reads any value of the optional claims as the string itself or null, and never throws (property)", () => {
    const anyValue = fc.jsonValue();
    fc.assert(
      fc.property(
        fc.record({
          session_index: anyValue,
          jti: anyValue,
          amr: anyValue,
          dob: anyValue,
          given: anyValue,
          surname: anyValue,
          display: anyValue,
          authTime: fc.oneof(fc.integer({ min: 0, max: 4_000_000_000 }), anyValue),
        }),
        (v) => {
          const identity = identityFromClaims(
            claims({
              session_index: v.session_index,
              jti: v.jti,
              amr: v.amr,
              auth_time: v.authTime,
              [FTN_CLAIMS.dateOfBirth]: v.dob,
              [FTN_CLAIMS.givenNames]: v.given,
              [FTN_CLAIMS.surname]: v.surname,
              [FTN_CLAIMS.displayName]: v.display,
            }),
            null,
          );
          const text = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : null);
          expect(identity.sessionIndex).toBe(text(v.session_index));
          expect(identity.tokenId).toBe(text(v.jti));
          expect(identity.dateOfBirth).toBe(text(v.dob));
          expect(identity.givenNames).toBe(text(v.given));
          expect(identity.surname).toBe(text(v.surname));
          expect(identity.displayName).toBe(text(v.display));
          expect(identity.amr).toEqual(
            Array.isArray(v.amr) ? v.amr.filter((x) => typeof x === "string") : [],
          );
          expect(identity.authenticatedAt.getTime()).toBe(
            new Date(
              (typeof v.authTime === "number" ? v.authTime : 1_799_999_000) * 1000,
            ).getTime(),
          );
        },
      ),
      { ...SEEDED, numRuns: 300 },
    );
  });

  it("refuses any identity code that is not a non-empty string (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        fc.pre(!(typeof value === "string" && value.length > 0));
        expect(reasonOf(() => identityFromClaims(claims({ [HETU_CLAIM]: value }), null))).toBe(
          "no identity code",
        );
      }),
      SEEDED,
    );
  });
});
