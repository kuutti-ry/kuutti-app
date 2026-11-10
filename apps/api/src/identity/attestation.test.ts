import type { Queryable } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import { generateHetu } from "@kuutti-ry/tunnistus-oidc/hetu";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { hashToken } from "../lib/auth-middleware.ts";
import {
  AAGUID_DEVELOPMENT,
  appleExtensions,
  makeIssuer,
  makePhone,
  makeRoot,
} from "../test/app-attest.ts";
import { CHALLENGE, VERIFIER } from "../test/attempt.ts";
import { exportOf } from "../test/export.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import { clientDataHashOf } from "./app-attest.ts";
import type { IdentityBroker } from "./broker.ts";
import * as repo from "./repo.ts";

// App Attest through the routes (ADR-069): the exchange with an attestation,
// the refresh with an assertion, and the environment's switch. The phone and
// the authority are a test's own (test/app-attest.ts); the verifier's steps
// have their own tests, against Apple's bytes too (app-attest.test.ts).

const TEAM = "ABCDE12345";
const APP_ID = `${TEAM}.fi.kuutti.app`;
const { root, issuer: rootIssuer } = makeRoot();
const authority = makeIssuer(rootIssuer, "Test App Attestation CA 1");
const newPhone = () =>
  makePhone({ issuer: authority, chain: [authority.certificate], appId: APP_ID });
type Phone = ReturnType<typeof newPhone>;

/** A deterministic generator, so the hetu is the same every run. */
function rngFrom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const HETU = generateHetu(rngFrom(580), {
  at: new Date("2026-10-01T12:00:00Z"),
  minAge: 25,
  maxAge: 40,
});

/** A bank that identifies one adult. */
const bank: IdentityBroker = {
  issuer: "https://broker.test/uas",
  async startLogin(input) {
    const url = new URL("https://broker.test/uas/oauth2/authorization");
    url.searchParams.set("state", input.state);
    return url;
  },
  async completeLogin() {
    return {
      hetu: HETU,
      subject: "2BY5CDNFBEOSUFSKNGFSY4Y3DZISGL4I",
      sessionIndex: "_cb08aaa8",
      tokenId: "72b11a11",
      authenticatedAt: new Date(),
      acr: "http://ftn.ficora.fi/2017/loatest2",
      amr: ["https://tunnistus-pp.telia.fi/uas/saml2/names/ac/oidc.aktia.1"],
    };
  },
};

type Ctx = { client: Parameters<typeof createApp>[0]["db"] };
type App = ReturnType<typeof createApp>;

/**
 * An app with a bank, the test's authority for Apple's and, unless told
 * otherwise, a team id; `off` switches App Attest off. `required` and
 * `production` are set on the parsed configuration: the parser refuses the
 * first in a test environment, which is its own test (config.test.ts).
 */
async function appWith(
  ctx: Ctx,
  options: {
    teamId?: string | null;
    off?: boolean;
    required?: boolean;
    production?: boolean;
  } = {},
) {
  const { logger, lines } = await captureLogger();
  const config = {
    ...testConfig({
      HETU_HMAC_KEY: "ab".repeat(32),
      OIDC_ISSUER: "https://broker.test/uas",
      OIDC_CLIENT_ID: "kuutti-test",
      OIDC_REDIRECT_URI: "https://api.test/auth/callback",
      IOS_TEAM_ID: options.teamId === null ? undefined : (options.teamId ?? TEAM),
      IOS_ATTESTATION: options.off ? "off" : undefined,
    }),
    ...(options.required ? { IOS_ATTESTATION: "required" as const } : {}),
    ...(options.production ? { APP_ENV: "production" as const } : {}),
  };
  const app = createApp({ config, logger, db: ctx.client, broker: bank, attestRoot: root });
  return { app, logs: lines };
}

/** A bank login as the app of `platform` starts it, up to the one-time code. */
async function codeFor(app: App, platform: "ios" | "android" = "ios"): Promise<string> {
  const start = await app.request(
    `/auth/start?platform=${platform}&locale=fi&code_challenge=${CHALLENGE}`,
  );
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`);
  const code = new URL(back.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("the bank login gave no code");
  return code;
}

const post = (app: App, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** What the phone sends beside the code: its key's identifier and the attestation over the code. */
const attestationOf = (phone: Phone, code: string, change?: Parameters<Phone["attest"]>[1]) => ({
  keyId: phone.keyId.toString("base64"),
  attestation: phone.attest(clientDataHashOf(code), change).toString("base64"),
});

const exchange = (app: App, code: string, attestation?: unknown) =>
  post(app, "/auth/exchange", { code, verifier: VERIFIER, attestation });

/** The key's assertion over a refresh token, as the phone sends it. */
const assertionOf = (phone: Phone, refreshToken: string, counter: number) =>
  phone.assert(clientDataHashOf(refreshToken), counter).toString("base64");

const refresh = (app: App, refreshToken: string, assertion?: string) =>
  post(app, "/auth/refresh", { refreshToken, assertion });

type Tokens = { sessionId: string; accessToken: string; refreshToken: string };
const tokensOf = async (res: Response): Promise<Tokens> => {
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
};
const errorOf = async (res: Response) => ({
  status: res.status,
  code: ErrorResponse.parse(await res.json()).error.code,
});

async function sessionRow(db: Queryable, sessionId: string) {
  const { rows } = await db.query<{
    attest_key: string | null;
    attest_counter: string | null;
    revoked_at: Date | null;
    platform: string;
  }>("SELECT attest_key, attest_counter, revoked_at, platform FROM session WHERE id = $1", [
    sessionId,
  ]);
  const row = rows[0];
  if (!row) throw new Error("no such session");
  return row;
}

async function unspentCodes(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM auth_request WHERE code_hash IS NOT NULL AND code_used_at IS NULL",
  );
  return Number(rows[0]?.n);
}

/** An iPhone signed in with an attestation: its phone, its app and its tokens. */
async function boundSession(ctx: Ctx, options: Parameters<typeof appWith>[1] = {}) {
  const { app, logs } = await appWith(ctx, options);
  const phone = newPhone();
  const code = await codeFor(app);
  const tokens = await tokensOf(await exchange(app, code, attestationOf(phone, code)));
  return { app, logs, phone, tokens };
}

describe("the exchange with an attestation (ADR-069 §2)", () => {
  test("An iPhone's attested exchange binds the session to the phone's key", async ({ ctx }) => {
    const { phone, tokens, app } = await boundSession(ctx);
    expect(await sessionRow(ctx.client, tokens.sessionId)).toEqual({
      attest_key: phone.point.toString("base64"),
      attest_counter: "0",
      revoked_at: null,
      platform: "ios",
    });
    // And it answers as any session does.
    const me = await app.request("/auth/session", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(me.status).toBe(200);
  });

  test("A refused attestation leaves the one-time code unspent", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx);
    const phone = newPhone();
    const code = await codeFor(app);
    const other = attestationOf(phone, "another code");
    expect(await errorOf(await exchange(app, code, other))).toEqual({
      status: 403,
      code: "attestation_refused",
    });
    // The refusal's line names the step, and holds nothing of what was sent.
    expect(logs().find((line) => line.code === "attestation_refused")).toMatchObject({
      detail: { reason: "nonce" },
    });
    for (const sent of [other.keyId, other.attestation, code]) {
      expect(JSON.stringify(logs())).not.toContain(sent);
    }
    expect(await unspentCodes(ctx.client)).toBe(1);
    const tokens = await tokensOf(await exchange(app, code, attestationOf(newPhone(), code)));
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_key).not.toBeNull();
    expect(await unspentCodes(ctx.client)).toBe(0);
  });

  test("An iPhone's exchange without an attestation opens a session bound to nothing", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const tokens = await tokensOf(await exchange(app, await codeFor(app)));
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      attest_key: null,
      attest_counter: null,
    });
  });

  test("Where an attestation is required an iPhone's exchange without one is refused", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, { required: true });
    const code = await codeFor(app);
    expect(await errorOf(await exchange(app, code))).toEqual({
      status: 403,
      code: "attestation_refused",
    });
    expect(logs().find((line) => line.code === "attestation_refused")).toMatchObject({
      detail: { reason: "missing" },
    });
    expect(await unspentCodes(ctx.client)).toBe(1);
    const tokens = await tokensOf(await exchange(app, code, attestationOf(newPhone(), code)));
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("0");
  });

  test("Where an attestation is required an Android phone signs in without one", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { required: true });
    const tokens = await tokensOf(await exchange(app, await codeFor(app, "android")));
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      attest_key: null,
      platform: "android",
    });
  });

  test("where an attestation is required, a code nobody issued is still auth_code_used", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { required: true });
    await codeFor(app);
    expect(await errorOf(await exchange(app, "A".repeat(43)))).toEqual({
      status: 401,
      code: "auth_code_used",
    });
    // And so is an iPhone's good code with another attempt's verifier: the
    // answer about the attestation is for whoever could have spent the code.
    const code = await codeFor(app);
    const res = await post(app, "/auth/exchange", { code, verifier: "0dd5".repeat(16) });
    expect(await errorOf(res)).toEqual({ status: 401, code: "auth_code_used" });
  });

  test("where an attestation is required, a spent code and an expired one are still auth_code_used", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx, { required: true });
    const spent = await codeFor(app);
    await tokensOf(await exchange(app, spent, attestationOf(newPhone(), spent)));
    expect(await errorOf(await exchange(app, spent))).toEqual({
      status: 401,
      code: "auth_code_used",
    });
    const late = await codeFor(app);
    await ctx.client.query(
      "UPDATE auth_request SET code_expires_at = now() - interval '1 second' WHERE code_used_at IS NULL",
    );
    expect(await errorOf(await exchange(app, late))).toEqual({
      status: 401,
      code: "auth_code_used",
    });
  });

  test("an Android attempt is never spent with an iPhone's attestation", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const code = await codeFor(app, "android");
    const res = await exchange(app, code, attestationOf(newPhone(), code));
    expect(await errorOf(res)).toEqual({ status: 401, code: "auth_code_used" });
    expect(await unspentCodes(ctx.client)).toBe(1);
    await tokensOf(await exchange(app, code));
  });

  test("with no team id an attestation is left unread and the session is bound to nothing", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, { teamId: null });
    const code = await codeFor(app);
    // Not even a good one: there is no App ID to hold it to.
    const junk = { keyId: `${"A".repeat(43)}=`, attestation: "AAAA" };
    const tokens = await tokensOf(await exchange(app, code, junk));
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_key).toBeNull();
    // The line says one came and was not read: a box missing its team id shows.
    expect(logs().find((line) => line.msg === "session issued")).toMatchObject({
      attested: false,
      unread: true,
    });
  });

  test("where App Attest is switched off, a good attestation is left unread too", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx, { off: true });
    const code = await codeFor(app);
    const tokens = await tokensOf(await exchange(app, code, attestationOf(newPhone(), code)));
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      attest_key: null,
      attest_counter: null,
    });
    expect(logs().find((line) => line.msg === "session issued")).toMatchObject({
      attested: false,
      unread: true,
    });
  });

  test("an attestation for another team's app is refused", async ({ ctx }) => {
    const { app, logs } = await appWith(ctx, { teamId: "ZZZZZ99999" });
    const code = await codeFor(app);
    const res = await exchange(app, code, attestationOf(newPhone(), code));
    expect(await errorOf(res)).toEqual({ status: 403, code: "attestation_refused" });
    expect(logs().find((line) => line.code === "attestation_refused")).toMatchObject({
      detail: { reason: "app_id" },
    });
  });

  test("a development key counts everywhere but in production", async ({ ctx }) => {
    const development = { aaguid: AAGUID_DEVELOPMENT };
    const staging = await appWith(ctx);
    const code = await codeFor(staging.app);
    await tokensOf(await exchange(staging.app, code, attestationOf(newPhone(), code, development)));

    const production = await appWith(ctx, { production: true });
    const again = await codeFor(production.app);
    const res = await exchange(
      production.app,
      again,
      attestationOf(newPhone(), again, development),
    );
    expect(await errorOf(res)).toEqual({ status: 403, code: "attestation_refused" });
    expect(production.logs().find((line) => line.code === "attestation_refused")).toMatchObject({
      detail: { reason: "environment" },
    });
    // A production key is taken there.
    await tokensOf(await exchange(production.app, again, attestationOf(newPhone(), again)));
  });

  test.for([
    ["no key identifier", { attestation: "AAAA" }],
    ["no attestation", { keyId: `${"A".repeat(43)}=` }],
    ["a key identifier of another length", { keyId: "AAAA", attestation: "AAAA" }],
    ["a key identifier in the URL alphabet", { keyId: `${"-".repeat(43)}=`, attestation: "AAAA" }],
    [
      "an attestation that is no base64",
      { keyId: `${"A".repeat(43)}=`, attestation: "not base64!" },
    ],
    ["an empty attestation", { keyId: `${"A".repeat(43)}=`, attestation: "" }],
    [
      "an attestation past its length",
      { keyId: `${"A".repeat(43)}=`, attestation: "A".repeat(16_385) },
    ],
    [
      "a field nobody asked for",
      { keyId: `${"A".repeat(43)}=`, attestation: "AAAA", receipt: "AAAA" },
    ],
    ["text where the object goes", "AAAA"],
    ["null where the object goes", null],
  ] as const)(
    "the exchange refuses %s as a validation failure, the code unspent",
    async ([, attestation], { ctx }) => {
      const { app } = await appWith(ctx);
      const code = await codeFor(app);
      expect(await errorOf(await exchange(app, code, attestation))).toEqual({
        status: 400,
        code: "validation_failed",
      });
      expect(await unspentCodes(ctx.client)).toBe(1);
    },
  );

  test("the exchange takes an attestation of the longest length it allows as far as the verifier", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const code = await codeFor(app);
    const longest = { keyId: `${"A".repeat(43)}=`, attestation: "A".repeat(16_384) };
    expect(await errorOf(await exchange(app, code, longest))).toEqual({
      status: 403,
      code: "attestation_refused",
    });
  });

  test("the session's line says whether it was attested and what Apple said of the build, and no line holds the key", async ({
    ctx,
  }) => {
    const { app, logs } = await appWith(ctx);
    const phone = newPhone();
    const code = await codeFor(app);
    const sent = attestationOf(phone, code, { afterKey: appleExtensions(2, "118") });
    const tokens = await tokensOf(await exchange(app, code, sent));
    expect(logs().find((line) => line.msg === "session issued")).toMatchObject({
      platform: "ios",
      attested: true,
      unread: false,
      validationCategory: 2,
      bundleVersion: "118",
    });
    const bare = await codeFor(app, "android");
    await tokensOf(await exchange(app, bare));
    expect(logs().filter((line) => line.msg === "session issued")[1]).toMatchObject({
      platform: "android",
      attested: false,
      unread: false,
      validationCategory: null,
      bundleVersion: null,
    });
    // A version of any length is logged as far as a version goes.
    const long = await codeFor(app);
    const wordy = attestationOf(newPhone(), long, {
      afterKey: appleExtensions(4, "9".repeat(200)),
    });
    await tokensOf(await exchange(app, long, wordy));
    expect(logs().filter((line) => line.msg === "session issued")[2]).toMatchObject({
      attested: true,
      bundleVersion: "9".repeat(32),
    });
    const all = JSON.stringify(logs());
    for (const secret of [
      sent.keyId,
      sent.attestation,
      phone.point.toString("base64"),
      tokens.refreshToken,
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  test("the export says of each device whether it was attested, and never the key", async ({
    ctx,
  }) => {
    const { app, phone, tokens } = await boundSession(ctx);
    const bare = await tokensOf(await exchange(app, await codeFor(app, "android")));
    const document = await exportOf(app, { authorization: `Bearer ${tokens.accessToken}` });
    const attested = new Map(document.sessions.map((s) => [s.sessionId, s.attested]));
    expect(attested).toEqual(
      new Map([
        [tokens.sessionId, true],
        [bare.sessionId, false],
      ]),
    );
    expect(JSON.stringify(document)).not.toContain(phone.point.toString("base64"));
  });
});

describe("the refresh with an assertion (ADR-069 §3)", () => {
  test("A session bound to a key is refreshed with the key's assertion over the refresh token", async ({
    ctx,
  }) => {
    const { app, phone, tokens } = await boundSession(ctx);
    const next = await tokensOf(
      await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 1)),
    );
    expect(next.sessionId).toBe(tokens.sessionId);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("1");
    // A phone that asserted elsewhere in between comes back with a later counter.
    await tokensOf(await refresh(app, next.refreshToken, assertionOf(phone, next.refreshToken, 7)));
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("7");
  });

  test("A refresh without an assertion is refused and leaves a bound session as it is", async ({
    ctx,
  }) => {
    const { app, logs, phone, tokens } = await boundSession(ctx);
    expect(await errorOf(await refresh(app, tokens.refreshToken))).toEqual({
      status: 401,
      code: "session_revoked",
    });
    expect(logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "assertion" },
    });
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      revoked_at: null,
      attest_counter: "0",
    });
    await tokensOf(
      await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 1)),
    );
  });

  test("An assertion's counter never goes back", async ({ ctx }) => {
    const { app, logs, phone, tokens } = await boundSession(ctx);
    const next = await tokensOf(
      await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 5)),
    );
    const again = await refresh(app, next.refreshToken, assertionOf(phone, next.refreshToken, 5));
    expect(await errorOf(again)).toEqual({ status: 401, code: "session_revoked" });
    expect(logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "assertion", step: "counter" },
    });
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      revoked_at: null,
      attest_counter: "5",
    });
    await tokensOf(await refresh(app, next.refreshToken, assertionOf(phone, next.refreshToken, 6)));
  });

  test("A session bound to nothing is refreshed as it always was", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const tokens = await tokensOf(await exchange(app, await codeFor(app)));
    const next = await tokensOf(await refresh(app, tokens.refreshToken));
    // An assertion beside it means nothing: there is no key to hold it to.
    const stray = assertionOf(newPhone(), next.refreshToken, 1);
    await tokensOf(await refresh(app, next.refreshToken, stray));
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      attest_key: null,
      attest_counter: null,
    });
  });

  test.for([
    [
      "another phone's key",
      (_: Phone, token: string) => assertionOf(newPhone(), token, 1),
      "signature",
    ],
    [
      "an assertion over another refresh token",
      (phone: Phone) => assertionOf(phone, "another.token", 1),
      "signature",
    ],
    [
      "an assertion made for another app",
      (phone: Phone, token: string) =>
        phone
          .assert(clientDataHashOf(token), 1, { appId: "ABCDE12345.fi.kuutti.other" })
          .toString("base64"),
      "app_id",
    ],
    ["bytes that are no assertion", () => "AAAA", "format"],
    ["an assertion of the longest length the refresh allows", () => "A".repeat(2048), "format"],
  ] as const)(
    "a bound session is not refreshed with %s, and stays as it is",
    async ([, make, step], { ctx }) => {
      const { app, logs, phone, tokens } = await boundSession(ctx);
      const sent = make(phone, tokens.refreshToken);
      const res = await refresh(app, tokens.refreshToken, sent);
      expect(await errorOf(res)).toEqual({ status: 401, code: "session_revoked" });
      expect(logs().find((line) => line.code === "session_revoked")).toMatchObject({
        detail: { reason: "assertion", step },
      });
      for (const secret of [sent, tokens.refreshToken]) {
        expect(JSON.stringify(logs())).not.toContain(secret);
      }
      expect((await sessionRow(ctx.client, tokens.sessionId)).revoked_at).toBeNull();
      await tokensOf(
        await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 1)),
      );
    },
  );

  test("a bound session is not refreshed where the team id it was attested under is gone", async ({
    ctx,
  }) => {
    const { phone, tokens } = await boundSession(ctx);
    const without = await appWith(ctx, { teamId: null });
    const res = await refresh(
      without.app,
      tokens.refreshToken,
      assertionOf(phone, tokens.refreshToken, 1),
    );
    expect(await errorOf(res)).toEqual({ status: 401, code: "session_revoked" });
    expect(without.logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "assertion", step: "app_id" },
    });
  });

  test("where App Attest is switched off a bound session is refreshed without its assertion, and asked for it again once it is back on", async ({
    ctx,
  }) => {
    const { app, phone, tokens } = await boundSession(ctx);
    const first = await tokensOf(
      await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 3)),
    );
    const off = await appWith(ctx, { off: true });
    // With none, and with one that would be refused: neither is read.
    const second = await tokensOf(await refresh(off.app, first.refreshToken));
    const third = await tokensOf(await refresh(off.app, second.refreshToken, "AAAA"));
    expect(await sessionRow(ctx.client, tokens.sessionId)).toMatchObject({
      attest_key: phone.point.toString("base64"),
      attest_counter: "3",
      revoked_at: null,
    });
    // Back on, the key is still the session's and its counter where it was.
    for (const assertion of [undefined, assertionOf(phone, third.refreshToken, 3)]) {
      expect(await errorOf(await refresh(app, third.refreshToken, assertion))).toEqual({
        status: 401,
        code: "session_revoked",
      });
    }
    await tokensOf(
      await refresh(app, third.refreshToken, assertionOf(phone, third.refreshToken, 4)),
    );
  });

  test("where App Attest is switched off an ended bound session is still over, and not for want of an assertion", async ({
    ctx,
  }) => {
    const { tokens } = await boundSession(ctx);
    const off = await appWith(ctx, { off: true });
    await ctx.client.query(
      "UPDATE session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [tokens.sessionId],
    );
    expect(await errorOf(await refresh(off.app, tokens.refreshToken))).toEqual({
      status: 401,
      code: "session_revoked",
    });
    expect(off.logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "unknown_or_expired" },
    });
  });

  test("a retired token of a bound session still ends it, assertion or not", async ({ ctx }) => {
    const { app, logs, phone, tokens } = await boundSession(ctx);
    await tokensOf(
      await refresh(app, tokens.refreshToken, assertionOf(phone, tokens.refreshToken, 1)),
    );
    const reused = await refresh(
      app,
      tokens.refreshToken,
      assertionOf(phone, tokens.refreshToken, 2),
    );
    expect(await errorOf(reused)).toEqual({ status: 401, code: "session_revoked" });
    expect(logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "reuse" },
    });
    expect((await sessionRow(ctx.client, tokens.sessionId)).revoked_at).not.toBeNull();
  });

  test("an ended bound session reads as any ended session, with a good assertion and with none", async ({
    ctx,
  }) => {
    const { app, logs, phone, tokens } = await boundSession(ctx);
    await ctx.client.query(
      "UPDATE session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [tokens.sessionId],
    );
    const asserted = await refresh(
      app,
      tokens.refreshToken,
      assertionOf(phone, tokens.refreshToken, 1),
    );
    expect(await errorOf(asserted)).toEqual({ status: 401, code: "session_revoked" });
    expect(logs().find((line) => line.code === "session_revoked")).toMatchObject({
      detail: { reason: "unknown_or_expired" },
    });
    expect(await errorOf(await refresh(app, tokens.refreshToken))).toEqual({
      status: 401,
      code: "session_revoked",
    });
  });

  test.for([
    ["an assertion that is no base64", "not base64!"],
    ["an empty assertion", ""],
    ["an assertion past its length", "A".repeat(2049)],
    ["a number where the assertion goes", 7],
  ] as const)("the refresh refuses %s as a validation failure", async ([, assertion], { ctx }) => {
    const { app, tokens } = await boundSession(ctx);
    const res = await post(app, "/auth/refresh", { refreshToken: tokens.refreshToken, assertion });
    expect(await errorOf(res)).toEqual({ status: 400, code: "validation_failed" });
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("0");
  });

  test("the rotation itself takes no counter that is not past the one kept, and none for a bound session", async ({
    ctx,
  }) => {
    const { tokens } = await boundSession(ctx);
    await ctx.client.query("UPDATE session SET attest_counter = 3 WHERE id = $1", [
      tokens.sessionId,
    ]);
    const rotate = (attestCounter: number | null) =>
      repo.rotateSession(ctx.client, {
        refreshHash: hashToken(tokens.refreshToken),
        nextAccessHash: hashToken("next access"),
        nextAccessExpiresAt: new Date(Date.now() + 60_000),
        nextRefreshHash: hashToken("next refresh"),
        nextExpiresAt: new Date(Date.now() + 60_000),
        ceilingMs: 365 * 24 * 60 * 60 * 1000,
        attestCounter,
        unasserted: false,
        at: new Date(),
      });
    expect(await rotate(2)).toBeNull();
    expect(await rotate(3)).toBeNull();
    expect(await rotate(null)).toBeNull();
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("3");
    expect(await rotate(4)).toMatchObject({ id: tokens.sessionId, attested: true });
    expect((await sessionRow(ctx.client, tokens.sessionId)).attest_counter).toBe("4");
  });

  test("a key belongs to one session, and is kept with its counter or not at all", async ({
    ctx,
  }) => {
    const { tokens } = await boundSession(ctx);
    const row = await sessionRow(ctx.client, tokens.sessionId);
    const insert = (key: string | null, counter: number | null) =>
      ctx.client.query(
        `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, family_hash, expires_at, attest_key, attest_counter)
         SELECT account_id, 'ios', $1, now(), $1, $1, now(), $2, $3 FROM session WHERE id = $4`,
        [hashToken(`${key}${counter}`), key, counter, tokens.sessionId],
      );
    for (const [key, counter, constraint] of [
      [row.attest_key, 0, "session_attest_key_unique"],
      ["another key", null, "session_attest_check"],
      [null, 0, "session_attest_check"],
      ["another key", -1, "session_attest_check"],
    ] as const) {
      await ctx.client.query("SAVEPOINT attempt");
      await expect(insert(key, counter)).rejects.toMatchObject({ constraint });
      await ctx.client.query("ROLLBACK TO SAVEPOINT attempt");
    }
  });
});
