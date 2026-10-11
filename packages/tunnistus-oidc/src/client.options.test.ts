import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ID,
  callback,
  documentedJwks,
  fixtureClient,
  fixtureProvider,
  ftnClaims,
  ISSUER,
  idToken,
  type Keys,
  makeKeys,
  NOT_A_KEY_PEM,
  NOW,
  REDIRECT_URI,
  refusal,
  tokenResponse,
} from "../test/telia-fixtures.ts";
import {
  ACR_LOA2,
  ACR_LOATEST2,
  createTunnistusClient,
  TELIA_PRODUCTION_ISSUER,
  type TunnistusClientOptions,
} from "./client.ts";
import { keyIdOf } from "./keys.ts";

// The client's options and the requests it builds from them: which dialect,
// which keys, which level, which parameters. Against fixtures in Telia's
// documented shape (test/telia-fixtures.ts), no network.

const MOCK_ISSUER = "http://mock-idp.test/ftn";

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
  vi.unstubAllGlobals();
});

/** A provider whose token endpoint answers with the documented, encrypted ID token for nonce "n". */
const teliaProvider = (claims: Record<string, unknown> = {}) =>
  fixtureProvider({
    jwks,
    token: async () => tokenResponse(await idToken(keys, ftnClaims("n", claims))),
  });

/** An ordinary OpenID provider over http, as the plain dialect meets the mock IdP: a signed, unencrypted ID token. */
const plainProvider = (claims: Record<string, unknown> = {}) =>
  fixtureProvider({
    issuer: MOCK_ISSUER,
    jwks,
    token: async () =>
      tokenResponse(
        await idToken(
          keys,
          ftnClaims("n", { iss: MOCK_ISSUER, aud: "kuutti-local", azp: undefined, ...claims }),
          { jweHeader: false },
        ),
      ),
  });

const plainOptions = (
  provider: ReturnType<typeof fixtureProvider>,
  overrides: Partial<TunnistusClientOptions> = {},
): TunnistusClientOptions => ({
  issuer: MOCK_ISSUER,
  clientId: "kuutti-local",
  redirectUri: "http://localhost:3000/auth/callback",
  acrValues: ACR_LOATEST2,
  signingKeyPem: null,
  encryptionKeyPem: null,
  fetch: provider.fetch,
  ...overrides,
});

describe("choosing the dialect", () => {
  it("takes Telia's two hosts for the Telia dialect, and names the issuer and the keys' thumbprints", async () => {
    for (const issuer of [ISSUER, TELIA_PRODUCTION_ISSUER]) {
      const provider = fixtureProvider({ issuer, jwks });
      const client = await fixtureClient(keys, provider, { issuer });
      expect(client.dialect).toBe("telia");
      expect(client.issuer).toBe(issuer);
      expect(client.keyIds).toEqual({
        signing: keyIdOf(keys.client.sigPem),
        encryption: keys.client.encKid,
      });
    }
  });

  it("takes any other issuer for the plain dialect, which carries no keys", async () => {
    const client = await createTunnistusClient(plainOptions(plainProvider()));
    expect(client.dialect).toBe("plain");
    expect(client.keyIds).toBeNull();
  });

  it("lets the caller name the plain dialect for a Telia issuer: the keys are then ignored", async () => {
    const provider = teliaProvider();
    const client = await fixtureClient(keys, provider, { dialect: "plain" });
    expect(client.dialect).toBe("plain");
    expect(client.keyIds).toBeNull();
    const url = await client.startLogin({ state: "s", nonce: "n" });
    expect(url.searchParams.get("request")).toBeNull();
    expect(url.searchParams.get("scope")).toBe("openid");
  });

  it("lets the caller name the Telia dialect for another host, with the same demand for both keys", async () => {
    const provider = fixtureProvider({ issuer: "https://broker.example/uas", jwks });
    const client = await fixtureClient(keys, provider, {
      issuer: "https://broker.example/uas",
      dialect: "telia",
    });
    expect(client.dialect).toBe("telia");
    expect(client.keyIds).not.toBeNull();
    await expect(
      fixtureClient(keys, provider, {
        issuer: "https://broker.example/uas",
        dialect: "telia",
        signingKeyPem: null,
      }),
    ).rejects.toMatchObject({ reason: "the telia dialect needs the signing and encryption keys" });
  });

  it("refuses an http issuer in the Telia dialect: only the plain one allows it", async () => {
    const provider = plainProvider();
    const error = await refusal(
      createTunnistusClient({
        ...plainOptions(provider),
        dialect: "telia",
        signingKeyPem: keys.client.sigPem,
        encryptionKeyPem: keys.client.encPem,
      }),
    );
    expect(error.reason).toBe("only requests to HTTPS are allowed");
    expect(provider.requests).toEqual([]);
  });

  it("uses the platform's fetch when none is handed in", async () => {
    const provider = teliaProvider();
    vi.stubGlobal("fetch", (url: string, init: Parameters<typeof provider.fetch>[1]) =>
      provider.fetch(url, init),
    );
    const client = await fixtureClient(keys, provider, { fetch: undefined });
    const identity = await client.completeLogin({
      callbackUrl: callback("s"),
      state: "s",
      nonce: "n",
    });
    expect(identity.acr).toBe(ACR_LOATEST2);
    expect(provider.requests.map((r) => r.url)).toContain(`${ISSUER}/oauth2/token`);
  });
});

describe("the keys", () => {
  it.each([
    ["without a signing key", { signingKeyPem: null }],
    ["without an encryption key", { encryptionKeyPem: null }],
    ["without either", { signingKeyPem: null, encryptionKeyPem: null }],
    ["with empty keys", { signingKeyPem: "", encryptionKeyPem: "" }],
  ])(
    "does not start in the Telia dialect %s, and asks nothing of the broker",
    async (_name, keyOptions) => {
      const provider = teliaProvider();
      await expect(fixtureClient(keys, provider, keyOptions)).rejects.toMatchObject({
        name: "TunnistusError",
        reason: "the telia dialect needs the signing and encryption keys",
      });
      expect(provider.requests).toEqual([]);
    },
  );

  it("does not start with a key that is not PKCS#8 (a PKCS#1 PEM) or not a key at all", async () => {
    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs1",
    }) as string;
    await expect(fixtureClient(keys, teliaProvider(), { signingKeyPem: pkcs1 })).rejects.toThrow(
      /PKCS#8/,
    );
    await expect(
      fixtureClient(keys, teliaProvider(), {
        encryptionKeyPem: NOT_A_KEY_PEM,
      }),
    ).rejects.toThrow();
  });

  it("signs nothing with an RSA key under 2048 bits (guide 2.1.1): the request and the token request fail", async () => {
    // The client starts with it; the signature is refused when it is made.
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    const provider = teliaProvider();
    const client = await fixtureClient(keys, provider, { signingKeyPem: small });
    await expect(client.startLogin({ state: "s", nonce: "n" })).rejects.toThrow(
      "unsupported operation",
    );
    await expect(
      client.completeLogin({ callbackUrl: callback("s"), state: "s", nonce: "n" }),
    ).rejects.toMatchObject({ reason: "unsupported operation" });
    expect(provider.lastTokenForm()).toBeNull();
  });
});

describe("the level asked for (acr_values)", () => {
  it("asks for several levels, space-separated, and accepts any one of them", async () => {
    const both = `${ACR_LOA2} ${ACR_LOATEST2}`;
    const provider = teliaProvider({ acr: ACR_LOA2 });
    const client = await fixtureClient(keys, provider, { acrValues: both });
    const request = decodeJwt(
      (await client.startLogin({ state: "s", nonce: "n" })).searchParams.get("request") ?? "",
    );
    expect(request.acr_values).toBe(both);
    expect(
      (await client.completeLogin({ callbackUrl: callback("s"), state: "s", nonce: "n" })).acr,
    ).toBe(ACR_LOA2);
  });

  it("refuses a level outside the ones asked for", async () => {
    const client = await fixtureClient(keys, teliaProvider({ acr: "mpki.telia.emulator.1" }));
    await expect(
      client.completeLogin({ callbackUrl: callback("s"), state: "s", nonce: "n" }),
    ).rejects.toMatchObject({ reason: "unexpected acr" });
  });

  it.each([
    ["null", null],
    ["empty", ""],
  ])(
    "with acrValues %s the plain dialect asks for no level and accepts the one the mock sends",
    async (_name, acrValues) => {
      const provider = plainProvider({ acr: "mpki.telia.emulator.1" });
      const client = await createTunnistusClient(plainOptions(provider, { acrValues }));
      const url = await client.startLogin({ state: "s", nonce: "n" });
      expect(url.searchParams.has("acr_values")).toBe(false);
      const identity = await client.completeLogin({
        callbackUrl: new URL("http://localhost:3000/auth/callback?code=c&state=s"),
        state: "s",
        nonce: "n",
      });
      expect(identity.acr).toBe("mpki.telia.emulator.1");
    },
  );
});

describe("startLogin", () => {
  it("in the Telia dialect sends client_id and the signed request object, and nothing else in the query", async () => {
    const client = await fixtureClient(keys, teliaProvider());
    const url = await client.startLogin({
      state: "s",
      nonce: "n",
      uiLocales: "sv",
      prompt: "none",
    });
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth2/authorization`);
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "request"]);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    const request = decodeJwt(url.searchParams.get("request") ?? "");
    expect(request).toMatchObject({ ui_locales: "sv", prompt: "none", state: "s", nonce: "n" });
  });

  it.each([
    ["absent", {}],
    ["null", { uiLocales: null, prompt: null }],
    ["empty", { uiLocales: "", prompt: null }],
  ])("leaves out ui_locales and prompt that are %s", async (_name, extra) => {
    const client = await fixtureClient(keys, teliaProvider());
    const request = decodeJwt(
      (await client.startLogin({ state: "s", nonce: "n", ...extra })).searchParams.get("request") ??
        "",
    );
    expect(request).not.toHaveProperty("ui_locales");
    expect(request).not.toHaveProperty("prompt");
  });

  it("carries state and nonce exactly, Unicode and reserved characters included", async () => {
    const client = await fixtureClient(keys, teliaProvider());
    const state = "ä/ö?&=+ 😀";
    const nonce = "%2F\u0000-";
    const request = decodeJwt(
      (await client.startLogin({ state, nonce })).searchParams.get("request") ?? "",
    );
    expect(request.state).toBe(state);
    expect(request.nonce).toBe(nonce);
  });

  it("signs every request object anew: its own jti, its own iat", async () => {
    const client = await fixtureClient(keys, teliaProvider());
    const first = decodeJwt(
      (await client.startLogin({ state: "s", nonce: "n" })).searchParams.get("request") ?? "",
    );
    vi.setSystemTime(NOW.getTime() + 5_000);
    const second = decodeJwt(
      (await client.startLogin({ state: "s", nonce: "n" })).searchParams.get("request") ?? "",
    );
    expect(first.jti).not.toBe(second.jti);
    expect((second.iat ?? 0) - (first.iat ?? 0)).toBe(5);
    expect(first.iat).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("in the plain dialect sends the parameters in the query, unsigned", async () => {
    const provider = plainProvider();
    const client = await createTunnistusClient(plainOptions(provider));
    const url = await client.startLogin({
      state: "s",
      nonce: "n",
      uiLocales: "fi",
      prompt: "login",
    });
    expect(`${url.origin}${url.pathname}`).toBe(`${MOCK_ISSUER}/oauth2/authorization`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "kuutti-local",
      redirect_uri: "http://localhost:3000/auth/callback",
      scope: "openid",
      response_type: "code",
      state: "s",
      nonce: "n",
      acr_values: ACR_LOATEST2,
      ui_locales: "fi",
      prompt: "login",
    });
  });
});

describe("completeLogin in the plain dialect", () => {
  it("exchanges the code without client authentication and reads a signed, unencrypted ID token", async () => {
    const provider = plainProvider({ auth_time: undefined });
    const client = await createTunnistusClient(plainOptions(provider));
    const identity = await client.completeLogin({
      callbackUrl: new URL("http://127.0.0.1:3000/auth/callback?code=c&state=s"),
      state: "s",
      nonce: "n",
    });
    // A mock that sends no auth_time: iat stands in, in this dialect only.
    expect(identity.authenticatedAt).toEqual(NOW);
    expect(identity.personalIdentityCode).toBe("010170-999R");
    const form = provider.lastTokenForm();
    expect(form?.get("client_id")).toBe("kuutti-local");
    expect(form?.get("client_assertion")).toBeNull();
    expect(form?.get("client_assertion_type")).toBeNull();
    expect(form?.get("redirect_uri")).toBe("http://localhost:3000/auth/callback");
  });

  it("cannot read an encrypted ID token: it holds no decryption key", async () => {
    const provider = fixtureProvider({
      issuer: MOCK_ISSUER,
      jwks,
      token: async () =>
        tokenResponse(
          await idToken(keys, ftnClaims("n", { iss: MOCK_ISSUER, aud: "kuutti-local" })),
        ),
    });
    const client = await createTunnistusClient(plainOptions(provider));
    await expect(
      client.completeLogin({
        callbackUrl: new URL("http://localhost:3000/auth/callback?code=c&state=s"),
        state: "s",
        nonce: "n",
      }),
    ).rejects.toMatchObject({ reason: "unsupported operation" });
  });

  it("reads the discovery document the mock serves, with nothing of Telia's in it", async () => {
    const provider = fixtureProvider({
      issuer: MOCK_ISSUER,
      discovery: {
        issuer: MOCK_ISSUER,
        authorization_endpoint: `${MOCK_ISSUER}/authorize`,
        token_endpoint: `${MOCK_ISSUER}/token`,
        jwks_uri: `${MOCK_ISSUER}/jwks`,
      },
    });
    const client = await createTunnistusClient(plainOptions(provider));
    const url = await client.startLogin({ state: "s", nonce: "n" });
    expect(`${url.origin}${url.pathname}`).toBe(`${MOCK_ISSUER}/authorize`);
  });
});

describe("the redirect URI", () => {
  it("sends the registered one in the request object and the token request, whatever the callback's own URL", async () => {
    const provider = teliaProvider();
    const client = await fixtureClient(keys, provider);
    const request = decodeJwt(
      (await client.startLogin({ state: "s", nonce: "n" })).searchParams.get("request") ?? "",
    );
    expect(request.redirect_uri).toBe(REDIRECT_URI);
    await client.completeLogin({
      callbackUrl: new URL("http://10.0.0.7:3000/auth/callback?code=c&state=s"),
      state: "s",
      nonce: "n",
    });
    expect(provider.lastTokenForm()?.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(provider.lastTokenForm()?.get("code")).toBe("c");
    expect(decodeProtectedHeader(provider.lastTokenForm()?.get("client_assertion") ?? "").alg).toBe(
      "RS256",
    );
  });
});
