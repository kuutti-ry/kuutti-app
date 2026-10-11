import { ErrorResponse, SessionTokens } from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";
import type { BrokerIdentity, IdentityBroker } from "./broker.ts";
import { issueSession, sweepSessions } from "./sessions.ts";

// features/identity/sessions.feature (#35): scenario names verbatim, plus the
// route checklist (validation, unauthenticated, wrong-user). Real Postgres,
// one rolled-back transaction per test; time moves by updating the rows.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type Ctx = { client: Parameters<typeof createApp>[0]["db"] };

async function accountRow(ctx: Ctx, label: string): Promise<string> {
  const identity = await ctx.client.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [`test-${label}-${"0".repeat(50)}`.slice(0, 64)],
  );
  const account = await ctx.client.query<{ id: string }>(
    "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'registered', 1990, 6) RETURNING id",
    [identity.rows[0]?.id],
  );
  const id = account.rows[0]?.id;
  if (!id) throw new Error("no account");
  return id;
}

async function device(ctx: Ctx, accountId: string) {
  return issueSession(
    { db: ctx.client, now: () => new Date() },
    { accountId, platform: "ios", userAgent: "test" },
  );
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function whoami(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request("/auth/session", bearer(token));
  const body = await res.json();
  return { status: res.status, code: res.ok ? null : ErrorResponse.parse(body).error.code, body };
}

async function refresh(app: ReturnType<typeof createApp>, refreshToken: string) {
  return app.request("/auth/refresh", {
    method: "post",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

describe("sessions", () => {
  test("An exchanged code yields a session that answers as the account", async ({ ctx }) => {
    // The one route that needs the bank: a broker whose person is an adult.
    const hetu = generateHetu(
      (() => {
        let x = 11;
        return () => {
          x = (x * 1103515245 + 12345) % 2147483648;
          return x / 2147483648;
        };
      })(),
      { at: new Date(), minAge: 30, maxAge: 40 },
    );
    const broker: IdentityBroker = {
      issuer: "https://broker.test/uas",
      async startLogin(input) {
        return new URL(`https://broker.test/uas/authorize?state=${input.state}`);
      },
      async completeLogin(): Promise<BrokerIdentity> {
        return {
          hetu,
          subject: "SUBJ",
          sessionIndex: null,
          tokenId: null,
          authenticatedAt: new Date(),
          acr: "http://ftn.ficora.fi/2017/loatest2",
          amr: [],
        };
      },
    };
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({
        HETU_HMAC_KEY: "ab".repeat(32),
        OIDC_ISSUER: "https://broker.test/uas",
        OIDC_CLIENT_ID: "kuutti-test",
        OIDC_REDIRECT_URI: "https://api.test/auth/callback",
      }),
      logger,
      db: ctx.client,
      broker,
    });
    const started = await app.request("/auth/start?platform=android");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await app.request(`/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchanged = await app.request("/auth/exchange", {
      method: "post",
      headers: { "content-type": "application/json", "user-agent": "Kuutti/1 (Android)" },
      body: JSON.stringify({ code }),
    });
    expect(exchanged.status).toBe(200);
    const tokens = SessionTokens.parse(await exchanged.json());
    expect(tokens.accessToken).toMatch(TOKEN);
    expect(tokens.refreshToken).toMatch(TOKEN);
    expect(tokens.accessToken).not.toBe(tokens.refreshToken);

    const me = await whoami(app, tokens.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.sessionId).toBe(tokens.sessionId);
    expect(me.body.platform).toBe("android");
    // Scoped to this account: another test file may hold committed rows of its own meanwhile.
    const rows = await ctx.client.query(
      "SELECT account_id, platform, user_agent FROM session WHERE account_id = $1",
      [me.body.accountId],
    );
    expect(rows.rows).toEqual([
      { account_id: me.body.accountId, platform: "android", user_agent: "Kuutti/1 (Android)" },
    ]);
  });

  test("A refresh rotates both tokens and retires the old ones", async ({ ctx }) => {
    const a = await device(ctx, await accountRow(ctx, "a"));
    const res = await refresh(ctx.app, a.refreshToken);
    expect(res.status).toBe(200);
    const next = SessionTokens.parse(await res.json());
    expect(next.sessionId).toBe(a.sessionId);
    expect(next.accessToken).not.toBe(a.accessToken);
    expect(next.refreshToken).not.toBe(a.refreshToken);
    expect(next.refreshExpiresAt).toBe(a.refreshExpiresAt);
    expect((await whoami(ctx.app, next.accessToken)).status).toBe(200);
    expect((await whoami(ctx.app, a.accessToken)).code).toBe("unauthenticated");
  });

  test("A refresh token used twice ends the device's session", async ({ ctx }) => {
    const a = await device(ctx, await accountRow(ctx, "a"));
    const next = SessionTokens.parse(await (await refresh(ctx.app, a.refreshToken)).json());
    const again = await refresh(ctx.app, a.refreshToken);
    expect(again.status).toBe(401);
    expect(await errorCode(again)).toBe("session_revoked");
    expect((await whoami(ctx.app, next.accessToken)).code).toBe("session_revoked");
    expect((await refresh(ctx.app, next.refreshToken)).status).toBe(401);
    const row = await ctx.client.query("SELECT revoked_reason FROM session");
    expect(row.rows[0]).toEqual({ revoked_reason: "refresh_reuse" });
  });

  test("An expired access token asks for a refresh", async ({ ctx }) => {
    const a = await device(ctx, await accountRow(ctx, "a"));
    await ctx.client.query("UPDATE session SET access_expires_at = now() - interval '1 second'");
    expect((await whoami(ctx.app, a.accessToken)).code).toBe("session_expired");
    const res = await refresh(ctx.app, a.refreshToken);
    expect(res.status).toBe(200);
    expect((await whoami(ctx.app, SessionTokens.parse(await res.json()).accessToken)).status).toBe(
      200,
    );
  });

  test("Logging out this device leaves the other devices signed in", async ({ ctx }) => {
    const account = await accountRow(ctx, "a");
    const phone = await device(ctx, account);
    const tablet = await device(ctx, account);
    const out = await ctx.app.request("/auth/logout", {
      method: "post",
      ...bearer(phone.accessToken),
    });
    expect(out.status).toBe(204);
    expect((await whoami(ctx.app, phone.accessToken)).code).toBe("session_revoked");
    expect((await refresh(ctx.app, phone.refreshToken)).status).toBe(401);
    expect((await whoami(ctx.app, tablet.accessToken)).status).toBe(200);
  });

  test("Logging out everywhere ends every device's session", async ({ ctx }) => {
    const account = await accountRow(ctx, "a");
    const phone = await device(ctx, account);
    const tablet = await device(ctx, account);
    // The device of another person is not touched: the update is scoped by account (rule 6).
    const stranger = await device(ctx, await accountRow(ctx, "b"));
    const out = await ctx.app.request("/auth/logout-all", {
      method: "post",
      ...bearer(tablet.accessToken),
    });
    expect(out.status).toBe(204);
    expect((await whoami(ctx.app, phone.accessToken)).code).toBe("session_revoked");
    expect((await whoami(ctx.app, tablet.accessToken)).code).toBe("session_revoked");
    expect((await whoami(ctx.app, stranger.accessToken)).status).toBe(200);
  });

  test("wrong user: the session route names the caller and a logout ends the caller's session only", async ({
    ctx,
  }) => {
    const a = await device(ctx, await accountRow(ctx, "a"));
    const bAccount = await accountRow(ctx, "b");
    const b = await device(ctx, bAccount);
    // Each token answers as its own account, never the other's (rule 6).
    const mine = await whoami(ctx.app, b.accessToken);
    expect(mine.status).toBe(200);
    expect((mine.body as { accountId: string }).accountId).toBe(bAccount);
    expect((mine.body as { accountId: string }).accountId).not.toBe(
      ((await whoami(ctx.app, a.accessToken)).body as { accountId: string }).accountId,
    );
    // B's logout revokes B's device and leaves A signed in.
    const out = await ctx.app.request("/auth/logout", { method: "post", ...bearer(b.accessToken) });
    expect(out.status).toBe(204);
    expect((await whoami(ctx.app, b.accessToken)).code).toBe("session_revoked");
    expect((await whoami(ctx.app, a.accessToken)).status).toBe(200);
  });

  test("A session of a sanctioned account stops answering", async ({ ctx }) => {
    // A ban is set on the identity (rules/api.md); the account may also be suspended on its own.
    const account = await accountRow(ctx, "a");
    const a = await device(ctx, account);
    await ctx.client.query(
      "UPDATE identity SET standing = 'banned' WHERE id = (SELECT identity_id FROM account WHERE id = $1)",
      [account],
    );
    expect((await whoami(ctx.app, a.accessToken)).code).toBe("session_revoked");
    expect(await errorCode(await refresh(ctx.app, a.refreshToken))).toBe("session_revoked");

    const other = await accountRow(ctx, "b");
    const b = await device(ctx, other);
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [other]);
    expect((await whoami(ctx.app, b.accessToken)).code).toBe("session_revoked");
    expect((await refresh(ctx.app, b.refreshToken)).status).toBe(401);
  });

  test("protected routes: no token, a malformed token and an unknown token are unauthenticated", async ({
    ctx,
  }) => {
    for (const path of ["/auth/session", "/auth/logout", "/auth/logout-all"]) {
      const method = path === "/auth/session" ? "get" : "post";
      const bare = await ctx.app.request(path, { method });
      expect(bare.status).toBe(401);
      expect(await errorCode(bare)).toBe("unauthenticated");
      const malformed = await ctx.app.request(path, { method, ...bearer("not-a-token") });
      expect(malformed.status).toBe(401);
      const unknown = await ctx.app.request(path, { method, ...bearer("A".repeat(43)) });
      expect(unknown.status).toBe(401);
      expect(await errorCode(unknown)).toBe("unauthenticated");
    }
  });

  test("refresh: validation, an unknown token, and a refresh past its ninety days", async ({
    ctx,
  }) => {
    expect((await refresh(ctx.app, "short")).status).toBe(400);
    const unknown = await refresh(ctx.app, "B".repeat(43));
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe("session_revoked");
    const a = await device(ctx, await accountRow(ctx, "a"));
    await ctx.client.query("UPDATE session SET expires_at = now() - interval '1 second'");
    expect((await refresh(ctx.app, a.refreshToken)).status).toBe(401);
    expect((await whoami(ctx.app, a.accessToken)).code).toBe("session_expired");
  });

  test("the row keeps hashes only, and the sweep removes what is over", async ({ ctx }) => {
    const account = await accountRow(ctx, "a");
    const a = await device(ctx, account);
    const b = await device(ctx, account);
    const c = await device(ctx, account);
    const dump = JSON.stringify((await ctx.client.query("SELECT * FROM session")).rows);
    for (const secret of [a.accessToken, a.refreshToken]) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // never an address

    await ctx.client.query(
      "UPDATE session SET revoked_at = now() - interval '31 days' WHERE id = $1",
      [a.sessionId],
    );
    await ctx.client.query(
      "UPDATE session SET expires_at = now() - interval '1 day' WHERE id = $1",
      [b.sessionId],
    );
    await ctx.client.query(
      "INSERT INTO auth_request (state, nonce, platform, expires_at) VALUES ('old', 'n', 'ios', now() - interval '1 hour')",
    );
    const swept = await sweepSessions({ db: ctx.client, now: () => new Date() });
    expect(swept).toEqual({ sessions: 2, authRequests: 1 });
    const left = await ctx.client.query("SELECT id FROM session");
    expect(left.rows).toEqual([{ id: c.sessionId }]);
  });
});
