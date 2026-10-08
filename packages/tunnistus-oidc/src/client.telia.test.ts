import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACR_LOATEST2,
  createTunnistusClient,
  type TunnistusClient,
  TunnistusError,
} from "./client.ts";
import { keyIdOf } from "./keys.ts";
import {
  AKTIA,
  CLIENT_ASSERTION_TYPE,
  type FakeTelia,
  fakeTelia,
  headerOf,
  TELIA_AUTHORIZATION_ENDPOINT,
  TELIA_ISSUER,
  TELIA_TOKEN_ENDPOINT,
} from "./testing/fake-telia.ts";

// The Telia dialect against the guide (v2.36 sections 2.4–2.7), with Telia
// played by the double under the real issuer: every requirement the guide
// states is either produced by the client and checked by the double, or
// produced wrongly by the double and refused by the client. No network.

const random = () => randomBytes(24).toString("base64url");

async function clientFor(telia: FakeTelia, acrValues: string | null = ACR_LOATEST2) {
  return createTunnistusClient({
    issuer: TELIA_ISSUER,
    clientId: telia.clientId,
    redirectUri: telia.redirectUri,
    acrValues,
    signingKeyPem: telia.signingKeyPem,
    encryptionKeyPem: telia.encryptionKeyPem,
    fetch: telia.fetch,
  });
}

/** One whole login: the browser's trip and the exchange. */
async function login(client: TunnistusClient, telia: FakeTelia, uiLocales: string | null = "fi") {
  const state = random();
  const nonce = random();
  const url = await client.startLogin({ state, nonce, uiLocales, prompt: "login" });
  const back = await telia.authorize(url);
  return {
    state,
    nonce,
    url,
    back,
    identity: () => client.completeLogin({ callbackUrl: back, state, nonce }),
  };
}

describe("the Telia dialect against the guide", () => {
  let telia: FakeTelia;
  beforeEach(async () => {
    telia = await fakeTelia();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the authentication request as a signed request object with the claims of 2.4.2", async () => {
    const client = await clientFor(telia);
    expect(client.dialect).toBe("telia");
    expect(client.keyIds).toEqual({
      signing: keyIdOf(telia.signingKeyPem),
      encryption: keyIdOf(telia.encryptionKeyPem),
    });
    const { url, back, state, nonce } = await login(client, telia);
    expect(`${url.origin}${url.pathname}`).toBe(TELIA_AUTHORIZATION_ENDPOINT);
    // Everything travels inside the request object; the query carries it and the client id only.
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "request"]);
    expect(telia.seen.refusals).toEqual([]);
    expect(telia.seen.requestHeader).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(telia.seen.requestObject).toMatchObject({
      iss: telia.clientId,
      aud: TELIA_ISSUER,
      client_id: telia.clientId,
      response_type: "code",
      scope: "openid",
      redirect_uri: telia.redirectUri,
      acr_values: ACR_LOATEST2,
      state,
      nonce,
      ui_locales: "fi",
      prompt: "login",
    });
    const { jti, exp, iat } = telia.seen.requestObject ?? {};
    expect(typeof jti).toBe("string");
    expect((exp ?? 0) - (iat ?? 0)).toBe(600); // 2.4.3 suggests ten minutes
    expect(telia.seen.requestObject?.nbf).toBeUndefined();
    expect(back.origin + back.pathname).toBe(telia.redirectUri);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("code")).toBeTruthy();
  });

  it("authenticates the token request with private_key_jwt as 2.6 requires, then decrypts and verifies the ID token", async () => {
    const client = await clientFor(telia);
    const { identity } = await login(client, telia);
    const answer = await identity();

    // 2.6.1: the form.
    expect(telia.seen.tokenForm).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: telia.redirectUri,
      client_id: telia.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
    });
    expect(telia.seen.tokenForm?.code).toBeTruthy();
    expect(telia.seen.tokenForm?.client_secret).toBeUndefined();
    // 2.6.2: the assertion's claims; aud is the token endpoint, not the issuer.
    expect(telia.seen.assertionHeader).toMatchObject({ alg: "RS256" });
    expect(telia.seen.assertion).toMatchObject({
      iss: telia.clientId,
      sub: telia.clientId,
      aud: TELIA_TOKEN_ENDPOINT,
    });
    expect(typeof telia.seen.assertion?.jti).toBe("string");
    expect(telia.seen.assertion?.exp ?? 0).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 3600,
    );

    // 2.6.3–2.6.4: a JWE around a JWS, every claim of the person as sent.
    expect(answer).toEqual({
      personalIdentityCode: "010170-999R",
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      sessionIndex: "_cb08aaa8c860fed8c798aac35885f4004fe15bb5",
      tokenId: null,
      authenticatedAt: answer.authenticatedAt,
      acr: ACR_LOATEST2,
      amr: [AKTIA],
      dateOfBirth: "1970-01-01",
      givenNames: "Tero Testi",
      surname: "Äyrämö",
      displayName: "Tero Testi Äyrämö",
    });
    expect(answer.authenticatedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("decrypts an ID token under either content encryption Telia's metadata lists (A128GCM too)", async () => {
    // tunnistus-pp.telia.fi and tunnistus.telia.fi both publish
    // id_token_encryption_enc_values_supported: A128GCM, A128CBC-HS256 (read 2026-10-07).
    telia.enc = "A128GCM";
    const client = await clientFor(telia);
    const answer = await (await login(client, telia)).identity();
    expect(answer).toMatchObject({ personalIdentityCode: "010170-999R", acr: ACR_LOATEST2 });
  });

  it("refuses an ID token without auth_time (2.6.4), which a caller's freshness rule stands on", async () => {
    telia.misbehave.omitAuthTime = true;
    const client = await clientFor(telia);
    await expect((await login(client, telia)).identity()).rejects.toMatchObject({
      reason: "no auth_time",
    });
  });

  it("refuses an ID token that is not encrypted, is signed by a stranger, names another nonce or another audience", async () => {
    const client = await clientFor(telia);
    for (const misbehave of [
      { plainIdToken: true },
      { rogueKey: true },
      { wrongNonce: true },
      { wrongAudience: true },
    ] as const) {
      telia.misbehave = misbehave;
      await expect((await login(client, telia)).identity()).rejects.toBeInstanceOf(TunnistusError);
    }
  });

  it("throws an error that carries the reason and nothing of the person, whatever the library attached", async () => {
    // The underlying library attaches the decoded claims to its own errors
    // (the audience check, for one); the kit's error must not carry them on.
    const client = await clientFor(telia);
    telia.misbehave = { wrongAudience: true };
    const error = await (await login(client, telia)).identity().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnistusError);
    const everything = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    expect(everything).not.toContain("010170-999R");
    expect(everything).not.toContain("Äyrämö");
    expect((error as TunnistusError).cause).toBeUndefined();
  });

  it("refuses a level other than the one asked for, and a token without the identity code (2.6.5)", async () => {
    const client = await clientFor(telia);
    telia.person = { ...telia.person, acr: "mpki.telia.emulator.1" };
    await expect((await login(client, telia)).identity()).rejects.toMatchObject({
      reason: "unexpected acr",
    });
    telia.person = { ...telia.person, acr: ACR_LOATEST2 };
    telia.misbehave = { omitHetu: true };
    await expect((await login(client, telia)).identity()).rejects.toMatchObject({
      reason: "no identity code",
    });
  });

  it("sends the person who cancels back with access_denied and no code (2.5.2)", async () => {
    const client = await clientFor(telia);
    telia.userCancels = true;
    const { back, state } = await login(client, telia);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("picks up a rotated Telia signing key without a restart (2.7.1)", async () => {
    const client = await clientFor(telia);
    await (await login(client, telia)).identity();
    const fetchesBefore = telia.seen.jwksFetches;
    expect(fetchesBefore).toBeGreaterThan(0); // the signature was verified against the JWKS
    await telia.rotateSigningKey();
    // The library refuses to hammer the JWKS: an unknown kid causes a fetch
    // only once the cached set is a minute old. Telia publishes keys in
    // advance (2.7.1), so in practice the new key is there before it signs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const answer = await (await login(client, telia)).identity();
    expect(answer.personalIdentityCode).toBe("010170-999R");
    expect(telia.seen.jwksFetches).toBeGreaterThan(fetchesBefore);
  });

  it("uses the registered redirect URI in the token request whatever the callback's host was", async () => {
    const client = await clientFor(telia);
    const { back, state, nonce } = await login(client, telia);
    const seenBehindProxy = new URL(`http://api.staging.kuutti.app/auth/callback${back.search}`);
    const answer = await client.completeLogin({ callbackUrl: seenBehindProxy, state, nonce });
    expect(answer.personalIdentityCode).toBe("010170-999R");
    expect(telia.seen.tokenForm?.redirect_uri).toBe(telia.redirectUri);
  });

  it("does not start against a Telia issuer without both keys, sends no locale or prompt unasked, and signs RS256", async () => {
    await expect(
      createTunnistusClient({
        issuer: TELIA_ISSUER,
        clientId: telia.clientId,
        redirectUri: telia.redirectUri,
        acrValues: ACR_LOATEST2,
        signingKeyPem: telia.signingKeyPem,
        encryptionKeyPem: null,
        fetch: telia.fetch,
      }),
    ).rejects.toThrow(/signing and encryption keys/);
    // The request object the browser carries is what a bank sees of the client: RS256, typ JWT.
    const client = await clientFor(telia);
    const url = await client.startLogin({ state: random(), nonce: random() });
    const request = url.searchParams.get("request") ?? "";
    expect(headerOf(request)).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(decodeJwt(request).ui_locales).toBeUndefined();
    expect(decodeJwt(request).prompt).toBeUndefined();
  });
});
