import { AdminSession, ErrorResponse } from "@kuutti/schema";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { staffSession } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { ADMIN_SESSION_TTL_MS, sweepAdminSessions } from "./admin-session.ts";
import type { BrokerIdentity, IdentityBroker } from "./broker.ts";
import { deriveIdentity, hmacKeyFromHex } from "./hetu.ts";

// Staff sessions (#49, features/identity/admin-session.feature): the bank
// login marked as a staff attempt, through the routes, with a broker that
// answers what a bank would.

const KEY_HEX = "cd".repeat(32);
const NOW = new Date("2026-10-01T12:00:00Z");
const ADMIN_URL = "http://localhost:5173";

function rngFrom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const STAFF_HETU = generateHetu(rngFrom(11), { at: NOW, minAge: 30, maxAge: 50 });

function fakeBroker(hetu: string): IdentityBroker {
  return {
    issuer: "https://broker.test/uas",
    async startLogin(input) {
      const url = new URL("https://broker.test/uas/oauth2/authorization");
      url.searchParams.set("state", input.state);
      return url;
    },
    async completeLogin(): Promise<BrokerIdentity> {
      return {
        hetu,
        subject: "STAFFSUBJECT",
        sessionIndex: null,
        tokenId: null,
        authenticatedAt: new Date(),
        acr: "http://ftn.ficora.fi/2017/loatest2",
        amr: [],
      };
    },
  };
}

async function appWith(ctx: TestContext, hetu = STAFF_HETU) {
  const { logger, lines } = await captureLogger();
  const app = createApp({
    config: testConfig({
      HETU_HMAC_KEY: KEY_HEX,
      OIDC_ISSUER: "https://broker.test/uas",
      OIDC_CLIENT_ID: "kuutti-test",
      OIDC_REDIRECT_URI: "https://api.test/auth/callback",
      ADMIN_APP_URL: ADMIN_URL,
    }),
    logger,
    db: ctx.client,
    broker: fakeBroker(hetu),
  });
  return { app, logs: lines };
}

/** The identity row of the staff hetu, with a role. */
async function allowlisted(ctx: TestContext, role = "moderator") {
  const { hetuHmac } = deriveIdentity(STAFF_HETU, hmacKeyFromHex(KEY_HEX), NOW);
  const { rows } = await ctx.client.query<{ id: string }>(
    "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
    [hetuHmac],
  );
  const id = rows[0]?.id ?? "";
  await ctx.client.query(
    "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, $2, 'test')",
    [id, role],
  );
  return id;
}

async function start(app: ReturnType<typeof createApp>) {
  const res = await app.request("/admin/auth/start?locale=fi");
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
}

async function callback(app: ReturnType<typeof createApp>, state: string) {
  const res = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

const exchange = (app: ReturnType<typeof createApp>, path: string, code: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

const errorCode = async (res: Response) => ErrorResponse.parse(await res.json()).error.code;

describe("staff sessions", () => {
  test("An allowlisted bank login yields an eight-hour admin session with the role", async ({
    ctx,
  }) => {
    const identityId = await allowlisted(ctx, "moderator");
    const { app, logs } = await appWith(ctx);
    const state = await start(app);
    const back = await callback(app, state);
    expect(back.origin).toBe(ADMIN_URL);
    const code = new URLSearchParams(back.hash.slice(1)).get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(back.search).toBe(""); // the code rides in the fragment, never the query

    const res = await exchange(app, "/admin/auth/exchange", code);
    expect(res.status).toBe(200);
    const session = AdminSession.parse(await res.json());
    expect(session.role).toBe("moderator");
    const ttl = new Date(session.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(ADMIN_SESSION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(ADMIN_SESSION_TTL_MS);

    const me = await app.request("/admin/whoami", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ role: "moderator", expiresAt: session.expiresAt });

    const accounts = await ctx.client.query("SELECT count(*) AS n FROM account");
    expect(Number(accounts.rows[0]?.n)).toBe(0);
    const rows = await ctx.client.query("SELECT identity_id, role FROM admin_session");
    expect(rows.rows).toEqual([{ identity_id: identityId, role: "moderator" }]);
    expect(JSON.stringify(logs())).not.toContain(session.accessToken);
    expect(JSON.stringify(logs())).not.toContain(STAFF_HETU);
  });

  test("A bank login without a role is refused and nothing is created", async ({ ctx }) => {
    // Never seen.
    const { app } = await appWith(ctx);
    const back = await callback(app, await start(app));
    expect(back.origin).toBe(ADMIN_URL);
    expect(new URLSearchParams(back.hash.slice(1)).get("error")).toBe("admin_not_allowed");
    for (const table of ["identity", "account", "admin_session"]) {
      expect(
        Number((await ctx.client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n),
      ).toBe(0);
    }
    // Known, but no role.
    const { hetuHmac } = deriveIdentity(STAFF_HETU, hmacKeyFromHex(KEY_HEX), NOW);
    await ctx.client.query("INSERT INTO identity (hetu_hmac) VALUES ($1)", [hetuHmac]);
    const again = await callback(app, await start(app));
    expect(new URLSearchParams(again.hash.slice(1)).get("error")).toBe("admin_not_allowed");
    expect(
      Number((await ctx.client.query("SELECT count(*) AS n FROM admin_session")).rows[0]?.n),
    ).toBe(0);
  });

  test("A moderator who cancels at the bank is sent back to the panel, not to the app", async ({
    ctx,
  }) => {
    await allowlisted(ctx);
    const { app } = await appWith(ctx);
    const state = await start(app);
    const res = await app.request(
      `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.origin).toBe(ADMIN_URL);
    expect(new URLSearchParams(back.hash.slice(1)).get("error")).toBe("auth_cancelled");
  });

  test("A staff code is exchanged once and never as a product code", async ({ ctx }) => {
    await allowlisted(ctx);
    const { app } = await appWith(ctx);
    const back = await callback(app, await start(app));
    const code = new URLSearchParams(back.hash.slice(1)).get("code") ?? "";
    // The exchange route of the app does not take a staff code.
    const wrongRoute = await exchange(app, "/auth/exchange", code);
    expect(wrongRoute.status).toBe(401);
    expect(await errorCode(wrongRoute)).toBe("auth_code_used");
    expect((await exchange(app, "/admin/auth/exchange", code)).status).toBe(200);
    const second = await exchange(app, "/admin/auth/exchange", code);
    expect(second.status).toBe(401);
    expect(await errorCode(second)).toBe("auth_code_used");
  });

  test("An admin session ends after eight hours and has no refresh", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [staff.sessionId],
    );
    const res = await app.request("/admin/whoami", { headers: staff.headers });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("session_expired");
    const refresh = await app.request("/admin/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: staff.accessToken }),
    });
    expect(refresh.status).toBe(404);
  });

  test("A role taken away ends the session's access at once", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    expect((await app.request("/admin/whoami", { headers: staff.headers })).status).toBe(200);
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      staff.identityId,
    ]);
    const res = await app.request("/admin/whoami", { headers: staff.headers });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("session_revoked");
  });

  test("An admin token never opens a product route and a product token never opens an admin route", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    const product = await app.request("/auth/session", { headers: staff.headers });
    expect(product.status).toBe(401);
    // The other direction is covered per route in media/admin-routes.test.ts; here the session route.
    const { signedInAccount } = await import("../test/account.ts");
    const me = await signedInAccount(ctx.client);
    const admin = await app.request("/admin/whoami", { headers: me.headers });
    expect(admin.status).toBe(401);
  });

  test("Logging out ends the admin session", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const staff = await staffSession(ctx.client);
    expect(
      (await app.request("/admin/auth/logout", { method: "POST", headers: staff.headers })).status,
    ).toBe(204);
    const res = await app.request("/admin/whoami", { headers: staff.headers });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("session_revoked");
  });
});

describe("staff sessions: refusals, validation and the sweep", () => {
  const codeOf = (back: URL) => new URLSearchParams(back.hash.slice(1)).get("code") ?? "";
  const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
    Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

  test("A role taken away between the bank and the exchange is refused at the exchange", async ({
    ctx,
  }) => {
    const identityId = await allowlisted(ctx);
    const { app } = await appWith(ctx);
    const code = codeOf(await callback(app, await start(app)));
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [identityId]);
    const res = await exchange(app, "/admin/auth/exchange", code);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("admin_not_allowed");
    expect(
      await count(ctx, "SELECT count(*) AS n FROM admin_session WHERE identity_id = $1", [
        identityId,
      ]),
    ).toBe(0);
  });

  test("A product code never opens an admin session and stays good for the app", async ({
    ctx,
  }) => {
    await allowlisted(ctx);
    const { app } = await appWith(ctx);
    const started = await app.request("/auth/start?platform=ios");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const refused = await exchange(app, "/admin/auth/exchange", code);
    expect(refused.status).toBe(401);
    expect(await errorCode(refused)).toBe("auth_code_used");
    expect(await count(ctx, "SELECT count(*) AS n FROM admin_session")).toBe(0);
    // Refused before it was spent: the app's own exchange still takes it.
    expect((await exchange(app, "/auth/exchange", code)).status).toBe(200);
  });

  test("An expired staff code is refused and opens nothing", async ({ ctx }) => {
    await allowlisted(ctx);
    const { app } = await appWith(ctx);
    const state = await start(app);
    const code = codeOf(await callback(app, state));
    await ctx.client.query(
      "UPDATE auth_request SET code_expires_at = now() - interval '1 second' WHERE state = $1",
      [state],
    );
    const res = await exchange(app, "/admin/auth/exchange", code);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth_code_used");
    expect(await count(ctx, "SELECT count(*) AS n FROM admin_session")).toBe(0);
  });

  test("A banned member of staff is refused at the bank and the attempt is spent", async ({
    ctx,
  }) => {
    const identityId = await allowlisted(ctx, "admin");
    await ctx.client.query("UPDATE identity SET standing = 'banned' WHERE id = $1", [identityId]);
    const { app, logs } = await appWith(ctx);
    const state = await start(app);
    const back = await callback(app, state);
    expect(back.origin).toBe(ADMIN_URL);
    expect(new URLSearchParams(back.hash.slice(1))).toEqual(
      new URLSearchParams({ error: "admin_not_allowed" }),
    );
    // The refusal says the identity is known and banned, in the log only.
    expect(logs().find((l) => l.code === "admin_not_allowed")).toMatchObject({
      detail: { known: true, standing: "banned", platform: "admin" },
    });
    // The attempt is spent: the same state cannot be completed again.
    const again = await callback(app, state);
    expect(again.href).toContain("error=auth_state_mismatch");
    expect(again.href).not.toContain("code=");
    expect(await count(ctx, "SELECT count(*) AS n FROM admin_session")).toBe(0);
  });

  test("The staff start and exchange validate their input", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const start = await app.request("/admin/auth/start?locale=de");
    expect(start.status).toBe(400);
    expect(await errorCode(start)).toBe("validation_failed");
    for (const code of ["short", "A".repeat(44)]) {
      const res = await exchange(app, "/admin/auth/exchange", code);
      expect(res.status, code).toBe(400);
      expect(await errorCode(res)).toBe("validation_failed");
    }
    const extra = await app.request("/admin/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "A".repeat(43), role: "admin" }),
    });
    expect(extra.status).toBe(400);
    const unknown = await exchange(app, "/admin/auth/exchange", "A".repeat(43));
    expect(unknown.status).toBe(401);
    expect(await errorCode(unknown)).toBe("auth_code_used");
  });

  test("Without a broker the staff login answers 503", async ({ ctx }) => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const res = await app.request("/admin/auth/start");
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("auth_provider_error");
  });

  test("A staff login without a language takes the request's", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const res = await app.request("/admin/auth/start", { headers: { "accept-language": "sv" } });
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
    const rows = await ctx.client.query(
      "SELECT platform, locale FROM auth_request WHERE state = $1",
      [state],
    );
    expect(rows.rows).toEqual([{ platform: "admin", locale: "sv" }]);
  });

  test("unauthenticated: whoami and logout need a staff token", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    for (const [method, path] of [
      ["GET", "/admin/whoami"],
      ["POST", "/admin/auth/logout"],
    ] as const) {
      const tokens: Array<Record<string, string>> = [
        {},
        { authorization: "Bearer not-a-token" },
        { authorization: `Bearer ${"A".repeat(43)}` },
      ];
      for (const headers of tokens) {
        const res = await app.request(path, { method, headers });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await errorCode(res)).toBe("unauthenticated");
      }
    }
  });

  test("wrong user: whoami names the caller and a logout ends the caller's session only", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const moderator = await staffSession(ctx.client, "moderator");
    const researcher = await staffSession(ctx.client, "researcher");
    const whoami = async (headers: Record<string, string>) =>
      app.request("/admin/whoami", { headers });
    expect(await (await whoami(researcher.headers)).json()).toMatchObject({ role: "researcher" });
    expect(
      (await app.request("/admin/auth/logout", { method: "POST", headers: researcher.headers }))
        .status,
    ).toBe(204);
    expect((await whoami(researcher.headers)).status).toBe(401);
    const still = await whoami(moderator.headers);
    expect(still.status).toBe(200);
    expect(await still.json()).toMatchObject({ role: "moderator" });
  });

  test("The sweep removes expired and ended admin sessions and keeps the live ones", async ({
    ctx,
  }) => {
    const live = await staffSession(ctx.client);
    const expired = await staffSession(ctx.client);
    const ended = await staffSession(ctx.client);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.sessionId],
    );
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const swept = await sweepAdminSessions({ db: ctx.client, now: () => new Date() });
    expect(swept.adminSessions).toBeGreaterThanOrEqual(2);
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM admin_session WHERE id = ANY($1)",
      [[live.sessionId, expired.sessionId, ended.sessionId]],
    );
    expect(rows).toEqual([{ id: live.sessionId }]);
  });
});
