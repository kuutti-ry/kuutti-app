import { randomBytes } from "node:crypto";
import { ACR_LOATEST2, keyIdOf } from "@kuutti-ry/tunnistus-oidc";
import { checkCharacter } from "@kuutti-ry/tunnistus-oidc/hetu";
import {
  type FakeTelia,
  fakeTelia,
  TELIA_ISSUER,
  TELIA_TOKEN_ENDPOINT,
} from "@kuutti-ry/tunnistus-oidc/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { CHALLENGE, VERIFIER } from "../test/attempt.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import { BrokerError } from "./broker.ts";
import { deriveIdentity, hmacKeyFromHex } from "./hetu.ts";
import { brokerOptionsFromConfig, OidcBroker, teliaKeyIds } from "./oidc-broker.ts";

// What the adapter adds to the kit (ADR-017): the dialect itself is proven in
// the kit's own repository, kuutti-ry/tunnistus-oidc; here only Kuutti's part
// of a login is checked.

const random = () => randomBytes(24).toString("base64url");

/** The adapter against the double; `fetch` stands between them when a test watches the wire. */
async function brokerFor(telia: FakeTelia, fetch = telia.fetch) {
  return OidcBroker.create({
    issuer: TELIA_ISSUER,
    clientId: telia.clientId,
    redirectUri: telia.redirectUri,
    acrValues: ACR_LOATEST2,
    signingKeyPem: telia.signingKeyPem,
    encryptionKeyPem: telia.encryptionKeyPem,
    fetch,
  });
}

async function login(broker: OidcBroker, telia: FakeTelia) {
  const state = random();
  const nonce = random();
  const back = await telia.authorize(await broker.startLogin({ state, nonce, locale: "fi" }));
  return broker.completeLogin({ callbackUrl: back, state, nonce });
}

describe("OidcBroker, the adapter over @kuutti-ry/tunnistus-oidc", () => {
  let telia: FakeTelia;
  beforeEach(async () => {
    telia = await fakeTelia();
  });

  it("asks the bank every time (ADR-016) and keeps of the answer what the callback may hold, no name or date of birth", async () => {
    const broker = await brokerFor(telia);
    const answer = await login(broker, telia);
    expect(telia.seen.requestObject).toMatchObject({ prompt: "login", ui_locales: "fi" });
    expect(answer).toMatchObject({
      hetu: "010170-999R",
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      acr: ACR_LOATEST2,
    });
    expect(Object.keys(answer).sort()).toEqual(
      ["acr", "amr", "authenticatedAt", "hetu", "sessionIndex", "subject", "tokenId"].sort(),
    );
    expect(JSON.stringify(answer)).not.toContain("Äyrämö");
    expect(JSON.stringify(answer)).not.toContain("1970-01-01");
  });

  it("turns the kit's refusal into the API's error with the reason as its detail", async () => {
    const broker = await brokerFor(telia);
    telia.misbehave = { omitHetu: true };
    await expect(login(broker, telia)).rejects.toBeInstanceOf(BrokerError);
    telia.misbehave = { omitHetu: true };
    await expect(login(broker, telia)).rejects.toMatchObject({
      detail: { detail: "no identity code" },
    });
  });

  it("does not boot against a Telia issuer without both keys, naming the parameters", async () => {
    await expect(
      OidcBroker.create({
        issuer: TELIA_ISSUER,
        clientId: telia.clientId,
        redirectUri: telia.redirectUri,
        acrValues: ACR_LOATEST2,
        signingKeyPem: telia.signingKeyPem,
        encryptionKeyPem: null,
        fetch: telia.fetch,
      }),
    ).rejects.toThrow(/TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY/);
  });

  it("knows Telia's issuer in another spelling (capitals, the default port) and asks the keys of it too", async () => {
    await expect(
      OidcBroker.create({
        issuer: "https://TUNNISTUS-PP.telia.fi:443/uas",
        clientId: telia.clientId,
        redirectUri: telia.redirectUri,
        acrValues: ACR_LOATEST2,
        signingKeyPem: null,
        encryptionKeyPem: null,
        fetch: telia.fetch,
      }),
    ).rejects.toThrow("a Telia issuer needs TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY");
  });

  it("does not boot against Telia's host over http or on another port: the kit refuses it", async () => {
    for (const issuer of [
      "http://tunnistus-pp.telia.fi/uas",
      "https://tunnistus-pp.telia.fi:8443/uas",
    ]) {
      await expect(
        OidcBroker.create({
          issuer,
          clientId: telia.clientId,
          redirectUri: telia.redirectUri,
          acrValues: ACR_LOATEST2,
          signingKeyPem: telia.signingKeyPem,
          encryptionKeyPem: telia.encryptionKeyPem,
          fetch: telia.fetch,
        }),
      ).rejects.toMatchObject({
        name: "TunnistusError",
        reason: "Telia's host takes the telia dialect only, over https on the default port",
      });
    }
  });
});

describe("the broker's configuration", () => {
  const OIDC = {
    OIDC_ISSUER: "https://broker.test/uas",
    OIDC_CLIENT_ID: "kuutti-test",
    OIDC_REDIRECT_URI: "https://api.test/auth/callback",
  };

  it("names no broker unless the issuer, the client and the redirect are all set", () => {
    expect(brokerOptionsFromConfig(testConfig())).toBeNull();
    for (const missing of Object.keys(OIDC)) {
      expect(brokerOptionsFromConfig(testConfig({ ...OIDC, [missing]: undefined })), missing).toBe(
        null,
      );
    }
  });

  it("carries the acr and the two keys when they are set, and null for each that is not", async () => {
    expect(brokerOptionsFromConfig(testConfig(OIDC))).toEqual({
      issuer: OIDC.OIDC_ISSUER,
      clientId: OIDC.OIDC_CLIENT_ID,
      redirectUri: OIDC.OIDC_REDIRECT_URI,
      acrValues: null,
      signingKeyPem: null,
      encryptionKeyPem: null,
    });
    const telia = await fakeTelia();
    const full = testConfig({
      ...OIDC,
      OIDC_ACR_VALUES: ACR_LOATEST2,
      TELIA_SIGNING_KEY: telia.signingKeyPem,
      TELIA_ENCRYPTION_KEY: telia.encryptionKeyPem,
    });
    expect(brokerOptionsFromConfig(full)).toMatchObject({
      acrValues: ACR_LOATEST2,
      signingKeyPem: telia.signingKeyPem,
      encryptionKeyPem: telia.encryptionKeyPem,
    });
  });

  it("logs the public key ids of the keys it has, and null for a key it lacks", async () => {
    const telia = await fakeTelia();
    expect(teliaKeyIds(testConfig())).toEqual({ signing: null, encryption: null });
    const ids = teliaKeyIds(
      testConfig({
        TELIA_SIGNING_KEY: telia.signingKeyPem,
        TELIA_ENCRYPTION_KEY: telia.encryptionKeyPem,
      }),
    );
    expect(ids).toEqual({
      signing: keyIdOf(telia.signingKeyPem),
      encryption: keyIdOf(telia.encryptionKeyPem),
    });
    expect(ids.signing).not.toBe(ids.encryption);
    // A kid is a thumbprint of the public half: nothing of the private key is in it.
    expect(telia.signingKeyPem).not.toContain(ids.signing);
    expect(teliaKeyIds(testConfig({ TELIA_SIGNING_KEY: telia.signingKeyPem }))).toEqual({
      signing: keyIdOf(telia.signingKeyPem),
      encryption: null,
    });
  });
});

describe("a bank login through the Telia test double, end to end", () => {
  const KEY_HEX = "9a".repeat(32);

  /** The double's person, with the individual number chosen: odd and even read as different legal sexes. */
  const personWith = (individual: string) => ({
    hetu: `010170-${individual}${checkCharacter("010170", individual)}`,
    dateOfBirth: "1970-01-01",
  });

  test("keeps the HMAC, the year and the month, and no code, name, date of birth or legal sex", async ({
    ctx,
  }) => {
    for (const individual of ["999", "998"]) {
      const telia = await fakeTelia({ person: personWith(individual) });
      const hetu = telia.person.hetu;
      const { logger, lines } = await captureLogger();
      const app = createApp({
        config: testConfig({ HETU_HMAC_KEY: KEY_HEX }),
        logger,
        db: ctx.client,
        broker: await brokerFor(telia),
      });
      const started = await app.request(
        `/auth/start?platform=android&locale=sv&code_challenge=${CHALLENGE}`,
      );
      expect(started.status).toBe(302);
      const back = await telia.authorize(new URL(started.headers.get("location") ?? ""));
      expect(telia.seen.requestObject).toMatchObject({ prompt: "login", ui_locales: "sv" });
      const returned = await app.request(`/auth/callback${back.search}`);
      expect(returned.status).toBe(302);
      const code = new URL(returned.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const exchanged = await app.request("/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier: VERIFIER }),
      });
      expect(exchanged.status).toBe(200);
      // The app's challenge binds our own one-time code (ADR-027), not Telia's:
      // no PKCE in the request object, and nothing of the pair reaches the broker.
      expect(telia.seen.requestObject).not.toHaveProperty("code_challenge");
      expect(JSON.stringify(telia.seen)).not.toContain(CHALLENGE);
      expect(JSON.stringify(telia.seen)).not.toContain(VERIFIER);
      const { accessToken } = (await exchanged.json()) as { accessToken: string };
      const me = (await (
        await app.request("/auth/session", { headers: { authorization: `Bearer ${accessToken}` } })
      ).json()) as { accountId: string };

      const { hetuHmac } = deriveIdentity(hetu, hmacKeyFromHex(KEY_HEX), new Date());
      const account = await ctx.client.query(
        "SELECT birth_year, birth_month, gender, state FROM account WHERE id = $1",
        [me.accountId],
      );
      // Rule 3: the year and the month of birth, and a gender only the person will declare.
      expect(account.rows).toEqual([
        { birth_year: 1970, birth_month: 1, gender: null, state: "registered" },
      ]);
      const rows = await ctx.client.query(
        `SELECT row_to_json(i) AS identity, row_to_json(a) AS account,
                (SELECT json_agg(r) FROM auth_request r WHERE r.account_id = a.id) AS attempts,
                (SELECT json_agg(s) FROM session s WHERE s.account_id = a.id) AS sessions
         FROM identity i JOIN account a ON a.identity_id = i.id WHERE a.id = $1`,
        [me.accountId],
      );
      expect(rows.rows[0]?.identity).toMatchObject({ hetu_hmac: hetuHmac, acr: ACR_LOATEST2 });
      // Rule 1: the code is in no row and no log line, nor its date part; nor the name or the date of birth.
      const stored = JSON.stringify(rows.rows);
      const logged = JSON.stringify(lines());
      for (const secret of [hetu, hetu.slice(0, 6), "Äyrämö", "Tero", "1970-01-01"]) {
        expect(stored, `${individual}: ${secret}`).not.toContain(secret);
        expect(logged, `${individual}: ${secret}`).not.toContain(secret);
      }
    }
    // No column could hold them either: the hash is the only trace of the code.
    const columns = await ctx.client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('identity', 'account', 'auth_request', 'session')`,
    );
    const names = columns.rows.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).toContain("identity.hetu_hmac");
    expect(
      names.filter((n) =>
        /hetu|sex|birth_day|birth_date|date_of_birth|dob|given_name|surname/.test(n),
      ),
    ).toEqual(["identity.hetu_hmac"]);
  });

  test("answers a return once: after Telia refuses a forged code, the real return costs no token call", async ({
    ctx,
  }) => {
    const telia = await fakeTelia();
    let tokenCalls = 0;
    const counting: FakeTelia["fetch"] = (url, init) => {
      if (init.method === "POST" && String(url) === TELIA_TOKEN_ENDPOINT) tokenCalls += 1;
      return telia.fetch(url, init);
    };
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({ HETU_HMAC_KEY: KEY_HEX }),
      logger,
      db: ctx.client,
      broker: await brokerFor(telia, counting),
    });
    const sentBack = (res: Response) => {
      expect(res.status).toBe(302);
      return new URL(res.headers.get("location") ?? "").searchParams.get("error");
    };
    const started = await app.request(
      `/auth/start?platform=ios&locale=fi&code_challenge=${CHALLENGE}`,
    );
    const back = await telia.authorize(new URL(started.headers.get("location") ?? ""));
    // Whoever holds the state returns first, with a code Telia never issued.
    const forged = new URL(back);
    forged.searchParams.set("code", random());
    expect(sentBack(await app.request(`/auth/callback${forged.search}`))).toBe(
      "auth_provider_error",
    );
    expect(tokenCalls).toBe(1);
    expect(telia.seen.tokenForm?.code).toBe(forged.searchParams.get("code"));
    // The person's own return with the code Telia did issue: the attempt is
    // spent, so the API refuses it without asking Telia (#324, ADR-026 §8).
    expect(sentBack(await app.request(`/auth/callback${back.search}`))).toBe("auth_state_mismatch");
    expect(tokenCalls).toBe(1);
    const created = await ctx.client.query(
      "SELECT (SELECT count(*)::int FROM identity) AS identities, (SELECT count(*)::int FROM account) AS accounts",
    );
    expect(created.rows[0]).toEqual({ identities: 0, accounts: 0 });
  });
});
