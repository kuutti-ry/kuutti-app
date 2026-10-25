import type { Queryable } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { type App, createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { hashToken } from "../lib/auth-middleware.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { interleaved } from "../test/chat.ts";
import { openExport } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { deviceOf, tokensLeft } from "../test/push.ts";

// A device's push token (#102, ADR-055 §2, §3, §11): PUT /push-token with
// each validation rule, unauthenticated, a revoked session, the moves
// between sessions and accounts, the race with a revocation and an erasure;
// the trigger that takes a revoked session's token and the cascade a
// deleted one's; the erasure's count and the export's devices
// (features/notifications/push.feature, features/identity/erasure.feature).

/** 12:00 in Helsinki, a Friday in summer time. */
const T = new Date("2026-10-16T09:00:00.000Z");
const LATER = new Date("2026-10-17T09:00:00.000Z");

type Person = Awaited<ReturnType<typeof signedInAccount>>;
type Row = {
  account_id: string;
  session_id: string;
  token: string;
  platform: string;
  locale: string;
  created_at: Date;
};

const token = (name: string) => `ExponentPushToken[tokens-test-${name}]`;

async function appAt(ctx: TestContext, at: Date = T, db: Queryable = ctx.client): Promise<App> {
  return createApp({
    config: testConfig(),
    logger: (await captureLogger()).logger,
    db,
    now: () => at,
  });
}

const register = (
  app: App,
  headers: Record<string, string>,
  body: unknown,
  language?: string,
): Promise<Response> =>
  Promise.resolve(
    app.request("/push-token", {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(language === undefined ? {} : { "accept-language": language }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

async function rowsOf(ctx: TestContext, accountIds: string[]): Promise<Row[]> {
  const { rows } = await ctx.client.query<Row>(
    `SELECT account_id, session_id, token, platform::text AS platform, locale, created_at
       FROM push_token WHERE account_id = ANY($1::uuid[]) ORDER BY created_at, token`,
    [accountIds],
  );
  return rows;
}

const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;

let devices = 0;

/** Another device of `who`: a live session of its own, written as signInAs writes one, with its id. */
async function anotherDevice(ctx: TestContext, who: Person) {
  devices += 1;
  const accessToken = `tokens-test-access-${process.pid}-${devices}`.padEnd(43, "x");
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, expires_at)
     VALUES ($1, 'android', $2, now() + interval '15 minutes', $3, now() + interval '90 days')
     RETURNING id`,
    [who.accountId, hashToken(accessToken), hashToken(`${accessToken}-refresh`)],
  );
  const sessionId = rows[0]?.id;
  if (!sessionId) throw new Error("no second session");
  return { headers: { authorization: `Bearer ${accessToken}` }, sessionId };
}

describe("PUT /push-token (ADR-055 §2)", () => {
  test("registers the caller's session's token in the language the request was answered in", async ({
    ctx,
  }) => {
    const app = await appAt(ctx);
    const cases = [
      ["fi", "fi", "ios"],
      ["sv-FI,sv;q=0.9", "sv", "android"],
      ["en-GB", "en", "ios"],
      ["de", "en", "android"],
      [undefined, "en", "ios"],
    ] as const;
    for (const [i, [language, locale, platform]] of cases.entries()) {
      const who = await signedInAccount(ctx.client);
      const answer = await register(
        app,
        who.headers,
        { token: token(`lang-${i}`), platform },
        language,
      );
      expect(answer.status, String(language)).toBe(204);
      expect(await answer.text()).toBe("");
      expect(await rowsOf(ctx, [who.accountId])).toEqual([
        {
          account_id: who.accountId,
          session_id: who.sessionId,
          token: token(`lang-${i}`),
          platform,
          locale,
          created_at: T,
        },
      ]);
    }
  });

  test("takes both of Expo's spellings of a token", async ({ ctx }) => {
    const app = await appAt(ctx);
    const who = await signedInAccount(ctx.client);
    const second = await anotherDevice(ctx, who);
    for (const [headers, value] of [
      [who.headers, "ExpoPushToken[abc_DEF-123]"],
      [second.headers, `ExponentPushToken[${"x".repeat(160)}]`],
    ] as const) {
      expect((await register(app, headers, { token: value, platform: "ios" })).status).toBe(204);
    }
    expect((await rowsOf(ctx, [who.accountId])).map((row) => row.token).sort()).toEqual(
      ["ExpoPushToken[abc_DEF-123]", `ExponentPushToken[${"x".repeat(160)}]`].sort(),
    );
  });

  test("the same token again keeps when it was registered and takes the new language and platform", async ({
    ctx,
  }) => {
    const who = await signedInAccount(ctx.client);
    expect(
      (
        await register(
          await appAt(ctx),
          who.headers,
          { token: token("same"), platform: "ios" },
          "fi",
        )
      ).status,
    ).toBe(204);
    const later = await appAt(ctx, LATER);
    expect(
      (await register(later, who.headers, { token: token("same"), platform: "android" }, "sv"))
        .status,
    ).toBe(204);
    expect(await rowsOf(ctx, [who.accountId])).toEqual([
      expect.objectContaining({
        token: token("same"),
        platform: "android",
        locale: "sv",
        created_at: T,
      }),
    ]);
  });

  test("a new token replaces the session's earlier one, and each session keeps its own", async ({
    ctx,
  }) => {
    const who = await signedInAccount(ctx.client);
    const second = await anotherDevice(ctx, who);
    const app = await appAt(ctx);
    await register(app, who.headers, { token: token("old"), platform: "ios" });
    await register(app, second.headers, { token: token("second"), platform: "android" });
    const later = await appAt(ctx, LATER);
    expect(
      (await register(later, who.headers, { token: token("new"), platform: "ios" })).status,
    ).toBe(204);
    expect(
      (await rowsOf(ctx, [who.accountId])).map((row) => [
        row.session_id,
        row.token,
        row.created_at,
      ]),
    ).toEqual([
      [second.sessionId, token("second"), T],
      [who.sessionId, token("new"), LATER],
    ]);
  });

  test("a token another account's session holds moves to the caller, and the other keeps none", async ({
    ctx,
  }) => {
    const earlier = await signedInAccount(ctx.client);
    const next = await signedInAccount(ctx.client);
    await register(
      await appAt(ctx),
      earlier.headers,
      { token: token("phone"), platform: "ios" },
      "fi",
    );
    // The app reinstalled without a sign-out, and somebody else signs in on the phone.
    const answer = await register(
      await appAt(ctx, LATER),
      next.headers,
      { token: token("phone"), platform: "ios" },
      "en",
    );
    expect(answer.status).toBe(204);
    expect(await rowsOf(ctx, [earlier.accountId])).toEqual([]);
    expect(await rowsOf(ctx, [next.accountId])).toEqual([
      {
        account_id: next.accountId,
        session_id: next.sessionId,
        token: token("phone"),
        platform: "ios",
        locale: "en",
        created_at: LATER,
      },
    ]);
  });

  test("a token of the caller's other device moves to this one, which drops its own", async ({
    ctx,
  }) => {
    const who = await signedInAccount(ctx.client);
    const second = await anotherDevice(ctx, who);
    const app = await appAt(ctx);
    await register(app, who.headers, { token: token("mine"), platform: "ios" });
    await register(app, second.headers, { token: token("moving"), platform: "ios" });
    await register(await appAt(ctx, LATER), who.headers, {
      token: token("moving"),
      platform: "ios",
    });
    expect(
      (await rowsOf(ctx, [who.accountId])).map((row) => [
        row.session_id,
        row.token,
        row.created_at,
      ]),
    ).toEqual([[who.sessionId, token("moving"), LATER]]);
  });

  test("refuses what is not an Expo token, an unknown platform, an unknown key and no body, writing nothing", async ({
    ctx,
  }) => {
    const app = await appAt(ctx);
    const who = await signedInAccount(ctx.client);
    for (const body of [
      { token: "abc", platform: "ios" },
      { token: "ExponentPushToken[]", platform: "ios" },
      { token: "ExponentPushToken[a b]", platform: "ios" },
      { token: "ExponentPushToken[abc", platform: "ios" },
      { token: "exponentpushtoken[abc]", platform: "ios" },
      { token: `ExponentPushToken[${"x".repeat(161)}]`, platform: "ios" },
      { token: `ExponentPushToken[${"x".repeat(200)}]`, platform: "ios" },
      { token: 42, platform: "ios" },
      { platform: "ios" },
      { token: token("valid"), platform: "web" },
      { token: token("valid"), platform: "IOS" },
      { token: token("valid") },
      { token: token("valid"), platform: "ios", locale: "fi" },
      { token: token("valid"), platform: "ios", accountId: who.accountId },
      {},
      [],
      null,
    ]) {
      const answer = await register(app, who.headers, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(answer)).toBe("validation_failed");
    }
    // No body, and a body that is no JSON: refused as the app refuses either anywhere.
    const none = await app.request("/push-token", {
      method: "PUT",
      headers: { ...who.headers, "content-type": "application/json" },
    });
    expect(none.status).toBe(400);
    expect((await register(app, who.headers, "{not json")).status).toBe(400);
    expect(await rowsOf(ctx, [who.accountId])).toEqual([]);
  });

  test("refuses nobody, a token nobody issued, and a revoked session's, with 401", async ({
    ctx,
  }) => {
    const app = await appAt(ctx);
    const who = await signedInAccount(ctx.client);
    const body = { token: token("anyone"), platform: "ios" };
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      const answer = await register(app, headers, body);
      expect(answer.status).toBe(401);
      expect(await errorCode(answer)).toBe("unauthenticated");
    }
    await ctx.client.query("UPDATE session SET revoked_at = $2 WHERE id = $1", [
      who.sessionId,
      new Date(T.getTime() - 1000),
    ]);
    const revoked = await register(app, who.headers, body);
    expect(revoked.status).toBe(401);
    expect(await errorCode(revoked)).toBe("session_revoked");
    expect(await tokensLeft(ctx.client, [who.accountId])).toEqual([]);
  });

  test("a session revoked, or an account erased, between the guard and the write writes nothing", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    for (const what of ["revoked", "erased"] as const) {
      const who = await signedInAccount(ctx.client);
      const racing = interleaved(ctx.client, /FOR SHARE OF a FOR UPDATE OF s/, () =>
        what === "revoked"
          ? ctx.client.query("UPDATE session SET revoked_at = $2 WHERE id = $1", [who.sessionId, T])
          : eraseAccount({ db: ctx.client, logger, now: () => T }, who.accountId),
      );
      const app = await appAt(ctx, T, racing);
      const answer = await register(app, who.headers, {
        token: token(`race-${what}`),
        platform: "ios",
      });
      expect(racing.ran(), what).toBe(true);
      expect(answer.status, what).toBe(204);
      expect(await tokensLeft(ctx.client, [who.accountId]), what).toEqual([]);
    }
  });
});

describe("a token and its session (ADR-055 §3)", () => {
  test("A device's token goes when its session ends", async ({ ctx }) => {
    const app = await appAt(ctx);
    const a = await signedInAccount(ctx.client);
    const second = await anotherDevice(ctx, a);
    const b = await signedInAccount(ctx.client);
    await register(app, a.headers, { token: token("a-first"), platform: "ios" });
    await register(app, second.headers, { token: token("a-second"), platform: "android" });
    await register(app, b.headers, { token: token("b"), platform: "ios" });

    // Signing out this device takes its token and no other.
    expect((await app.request("/auth/logout", { method: "POST", headers: a.headers })).status).toBe(
      204,
    );
    expect(await tokensLeft(ctx.client, [a.accountId, b.accountId])).toEqual([
      token("a-second"),
      token("b"),
    ]);
    // Signing out everywhere takes every token of the account, and nobody else's.
    const third = await anotherDevice(ctx, a);
    await register(app, third.headers, { token: token("a-third"), platform: "ios" });
    expect(
      (await app.request("/auth/logout-all", { method: "POST", headers: second.headers })).status,
    ).toBe(204);
    expect(await tokensLeft(ctx.client, [a.accountId, b.accountId])).toEqual([token("b")]);
  });

  test("whatever revokes a session takes its token, once; a deleted session takes it by the cascade", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const kept = await deviceOf(ctx.client, a.accountId);
    const revoked = await deviceOf(ctx.client, a.accountId);
    const deleted = await deviceOf(ctx.client, a.accountId);
    const touched = await deviceOf(ctx.client, a.accountId);
    // Any statement that sets revoked_at, the identity slice's or not.
    await ctx.client.query(
      "UPDATE session SET revoked_at = $2, revoked_reason = 'sanction' WHERE id = $1",
      [revoked.sessionId, T],
    );
    expect(await tokensLeft(ctx.client, [a.accountId])).toEqual([
      kept.token,
      deleted.token,
      touched.token,
    ]);
    // A session revoked already is not revoked again: a token written to it since stays (and is never sent to).
    await ctx.client.query(
      `INSERT INTO push_token (account_id, session_id, token, platform, locale)
       VALUES ($1, $2, $3, 'ios', 'en')`,
      [a.accountId, revoked.sessionId, token("after")],
    );
    await ctx.client.query("UPDATE session SET revoked_at = $2 WHERE id = $1", [
      revoked.sessionId,
      LATER,
    ]);
    expect(await tokensLeft(ctx.client, [a.accountId])).toContain(token("after"));
    // Any other change to a live session leaves its token.
    await ctx.client.query("UPDATE session SET last_used_at = $2 WHERE id = $1", [
      touched.sessionId,
      LATER,
    ]);
    // Deleted, as the night's prune and erasure delete: the cascade.
    await ctx.client.query("DELETE FROM session WHERE id = $1", [deleted.sessionId]);
    expect(await tokensLeft(ctx.client, [a.accountId])).toEqual([
      kept.token,
      touched.token,
      token("after"),
    ]);
  });

  test("a token belongs to one session and a session has one token, by the table's own rules", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const first = await deviceOf(ctx.client, a.accountId);
    const second = await anotherDevice(ctx, a);
    const insert = (sessionId: string, value: string) =>
      ctx.client
        .query("SAVEPOINT unique_rule")
        .then(() =>
          ctx.client.query(
            `INSERT INTO push_token (account_id, session_id, token, platform, locale)
             VALUES ($1, $2, $3, 'ios', 'en')`,
            [a.accountId, sessionId, value],
          ),
        )
        .then(
          () => "written",
          (error: { constraint?: string }) => error.constraint,
        )
        .finally(() => ctx.client.query("ROLLBACK TO SAVEPOINT unique_rule"));
    expect(await insert(first.sessionId, token("another"))).toBe("push_token_session_id_unique");
    expect(await insert(second.sessionId, first.token)).toBe("push_token_token_unique");
  });
});

describe("the push tokens in erasure and export (ADR-055 §3, §11)", () => {
  test("The devices' push tokens go with the account, and the export names the devices that had one, never a token", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { exports_per_day: 3 });
    const app = await appAt(ctx);
    const a = await signedInAccount(ctx.client);
    const phone = await anotherDevice(ctx, a);
    const quiet = await anotherDevice(ctx, a);
    const b = await signedInAccount(ctx.client);
    await register(app, a.headers, { token: token("a-ios"), platform: "ios" }, "fi");
    await register(app, phone.headers, { token: token("a-android"), platform: "android" }, "sv");
    await register(app, b.headers, { token: token("b"), platform: "ios" });

    const opened = await openExport(await app.request("/account/export", { headers: a.headers }));
    const pushes = new Map(opened.document.sessions.map((s) => [s.sessionId, s.push]));
    expect(Object.fromEntries(pushes)).toEqual({
      [a.sessionId]: { platform: "ios", locale: "fi", registeredAt: T.toISOString() },
      [phone.sessionId]: { platform: "android", locale: "sv", registeredAt: T.toISOString() },
      [quiet.sessionId]: null,
    });
    // Never a token, in the document as the zip carries it.
    for (const value of [token("a-ios"), token("a-android"), "tokens-test", "PushToken["]) {
      expect(opened.raw).not.toContain(value);
    }

    const summary = await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => T },
      a.accountId,
    );
    expect(summary).toMatchObject({ pushTokens: 2, sessions: 3 });
    expect(await tokensLeft(ctx.client, [a.accountId])).toEqual([]);
    expect(await tokensLeft(ctx.client, [b.accountId])).toEqual([token("b")]);
  });
});
