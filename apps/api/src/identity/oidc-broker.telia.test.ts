import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AKTIA,
  CLIENT_ASSERTION_TYPE,
  type FakeTelia,
  fakeTelia,
  headerOf,
  LOATEST2,
  TELIA_AUTHORIZATION_ENDPOINT,
  TELIA_ISSUER,
  TELIA_TOKEN_ENDPOINT,
} from "../test/fake-telia.ts";
import { BrokerError } from "./broker.ts";
import { OidcBroker } from "./oidc-broker.ts";

// The Telia dialect against the guide (docs/vendors/telia.md, v2.36 sections
// 2.4–2.7), with Telia played by src/test/fake-telia.ts under the real issuer:
// every requirement the guide states is either produced by the adapter and
// checked by the fake, or produced wrongly by the fake and refused by the
// adapter. No network, no contract.

const random = () => randomBytes(24).toString("base64url");

async function brokerFor(telia: FakeTelia, acrValues = LOATEST2) {
  return OidcBroker.create({
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
async function login(broker: OidcBroker, telia: FakeTelia, locale: string | null = "fi") {
  const state = random();
  const nonce = random();
  const url = await broker.startLogin({ state, nonce, locale });
  const back = await telia.authorize(url);
  return {
    state,
    nonce,
    url,
    back,
    identity: () => broker.completeLogin({ callbackUrl: back, state, nonce }),
  };
}

describe("OidcBroker against Telia's guide", () => {
  let telia: FakeTelia;
  beforeEach(async () => {
    telia = await fakeTelia();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the authentication request as a signed request object with the claims of 2.4.2", async () => {
    const broker = await brokerFor(telia);
    const { url, back, state, nonce } = await login(broker, telia);
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
      acr_values: LOATEST2,
      state,
      nonce,
      ui_locales: "fi",
      prompt: "login", // ADR-016
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
    const broker = await brokerFor(telia);
    const { identity } = await login(broker, telia);
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

    // 2.6.3–2.6.4: a JWE around a JWS, reduced to what the identity keeps.
    expect(answer).toMatchObject({
      hetu: "010170-999R",
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      sessionIndex: "_cb08aaa8c860fed8c798aac35885f4004fe15bb5",
      acr: LOATEST2,
      amr: [AKTIA],
    });
    expect(answer.authenticatedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(answer).sort()).toEqual(
      ["acr", "amr", "authenticatedAt", "hetu", "sessionIndex", "subject", "tokenId"].sort(),
    );
  });

  it("decrypts an ID token under either content encryption Telia's metadata lists (A128GCM too)", async () => {
    // tunnistus-pp.telia.fi and tunnistus.telia.fi both publish
    // id_token_encryption_enc_values_supported: A128GCM, A128CBC-HS256 (read 2026-10-07).
    telia.enc = "A128GCM";
    const broker = await brokerFor(telia);
    const { identity } = await login(broker, telia);
    const answer = await identity();
    expect(answer).toMatchObject({ hetu: "010170-999R", acr: LOATEST2 });
  });

  it("refuses an ID token without auth_time (2.6.4), which the freshness check of ADR-016 stands on", async () => {
    telia.misbehave.omitAuthTime = true;
    const broker = await brokerFor(telia);
    const { identity } = await login(broker, telia);
    await expect(identity()).rejects.toMatchObject({ detail: { detail: "no auth_time" } });
  });

  it("refuses an ID token that is not encrypted, is signed by a stranger, names another nonce or another audience", async () => {
    const broker = await brokerFor(telia);
    for (const misbehave of [
      { plainIdToken: true },
      { rogueKey: true },
      { wrongNonce: true },
      { wrongAudience: true },
    ] as const) {
      telia.misbehave = misbehave;
      const { identity } = await login(broker, telia);
      await expect(identity()).rejects.toBeInstanceOf(BrokerError);
    }
  });

  it("refuses a level other than the one asked for, and a token without the identity code (2.6.5)", async () => {
    const broker = await brokerFor(telia);
    telia.person = { ...telia.person, acr: "mpki.telia.emulator.1" };
    await expect((await login(broker, telia)).identity()).rejects.toMatchObject({
      detail: { detail: "unexpected acr" },
    });
    telia.person = { ...telia.person, acr: LOATEST2 };
    telia.misbehave = { omitHetu: true };
    await expect((await login(broker, telia)).identity()).rejects.toMatchObject({
      detail: { detail: "no identity code" },
    });
  });

  it("sends the person who cancels back with access_denied and no code (2.5.2)", async () => {
    const broker = await brokerFor(telia);
    telia.userCancels = true;
    const { back, state } = await login(broker, telia);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("picks up a rotated Telia signing key without a restart (2.7.1)", async () => {
    const broker = await brokerFor(telia);
    await (await login(broker, telia)).identity();
    const fetchesBefore = telia.seen.jwksFetches;
    expect(fetchesBefore).toBeGreaterThan(0); // the signature was verified against the JWKS
    await telia.rotateSigningKey();
    // The library refuses to hammer the JWKS: an unknown kid causes a fetch
    // only once the cached set is a minute old. Telia publishes keys in
    // advance (2.7.1), so in practice the new key is there before it signs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const answer = await (await login(broker, telia)).identity();
    expect(answer.hetu).toBe("010170-999R");
    expect(telia.seen.jwksFetches).toBeGreaterThan(fetchesBefore);
  });

  it("uses the registered redirect URI in the token request whatever the callback's host was", async () => {
    const broker = await brokerFor(telia);
    const { back, state, nonce } = await login(broker, telia);
    const seenBehindProxy = new URL(`http://api.staging.kuutti.app/auth/callback${back.search}`);
    const answer = await broker.completeLogin({ callbackUrl: seenBehindProxy, state, nonce });
    expect(answer.hetu).toBe("010170-999R");
    expect(telia.seen.tokenForm?.redirect_uri).toBe(telia.redirectUri);
  });

  it("does not boot against a Telia issuer without both keys, and never over plain http", async () => {
    await expect(
      OidcBroker.create({
        issuer: TELIA_ISSUER,
        clientId: telia.clientId,
        redirectUri: telia.redirectUri,
        acrValues: LOATEST2,
        signingKeyPem: telia.signingKeyPem,
        encryptionKeyPem: null,
        fetch: telia.fetch,
      }),
    ).rejects.toThrow(/TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY/);
    // The request object the browser carries is what a bank sees of us: RS256, typ JWT.
    const broker = await brokerFor(telia);
    const url = await broker.startLogin({ state: random(), nonce: random(), locale: null });
    expect(headerOf(url.searchParams.get("request") ?? "")).toMatchObject({ alg: "RS256" });
    expect(decodeJwt(url.searchParams.get("request") ?? "").ui_locales).toBeUndefined();
  });
});
