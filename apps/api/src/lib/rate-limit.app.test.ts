import { randomBytes } from "node:crypto";
import { ErrorResponse } from "@kuutti/schema";
import { createApp, ENDS_SESSION } from "../app.ts";
import { type SignedIn, signedInAccount, signInAs, staffSession } from "../test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";

/**
 * The two keys of ADR-026 through the whole app (#41): every request comes
 * from one address, as people behind a mobile network's shared address do,
 * and the budget is two a minute so that a third request is the one refused.
 */
const ADDRESS = "203.0.113.7";
const OTHER_ADDRESS = "198.51.100.23";

type Who = { headers: { authorization: string } };

async function appAt(ctx: TestContext, options: { limit?: number; media?: boolean } = {}) {
  const { logger, lines } = await captureLogger();
  const app = createApp({
    // Behind Traefik, which appends the address it saw (ADR-008 §5).
    config: testConfig({
      TRUSTED_PROXY: "traefik",
      RATE_LIMIT_PER_MINUTE: String(options.limit ?? 2),
    }),
    logger,
    db: ctx.client,
    ...(options.media ? { media: testMediaDeps().deps } : {}),
  });
  return {
    app,
    get: async (path: string, who?: Who, from = ADDRESS) =>
      app.request(path, { headers: { ...who?.headers, "x-forwarded-for": from } }),
    put: async (path: string, body: unknown, who: Who) =>
      app.request(path, {
        method: "PUT",
        headers: {
          ...who.headers,
          "content-type": "application/json",
          "x-forwarded-for": ADDRESS,
        },
        body: JSON.stringify(body),
      }),
    post: async (path: string, who: Who, from = ADDRESS, body: unknown = {}) =>
      app.request(path, {
        method: "POST",
        headers: { ...who.headers, "content-type": "application/json", "x-forwarded-for": from },
        body: JSON.stringify(body),
      }),
    logs: lines,
    requests: () => lines().filter((l) => l.msg === "request"),
    refusedSignIns: () => lines().filter((l) => l.msg === "sign-in refused"),
  };
}

async function errorCode(res: Response): Promise<string> {
  return ErrorResponse.parse(await res.json()).error.code;
}

async function lastUsed(ctx: TestContext, table: "session" | "admin_session", id: string) {
  const { rows } = await ctx.client.query<{ last_used_at: Date }>(
    `SELECT last_used_at FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]?.last_used_at.toISOString();
}

const LONG_AGO = "2001-01-01T00:00:00.000Z";

describe("a budget per person (ADR-026 §1-2)", () => {
  test("a signed-in person past their budget is refused with Retry-After, and another account at the same address is not", async ({
    ctx,
  }) => {
    const { get, requests } = await appAt(ctx);
    const a = await signedInAccount(ctx.client, "rate-a");
    const b = await signedInAccount(ctx.client, "rate-b");

    expect((await get("/auth/session", a)).status).toBe(200);
    expect((await get("/auth/session", a)).status).toBe(200);
    await ctx.client.query("UPDATE session SET last_used_at = $2 WHERE id = $1", [
      a.sessionId,
      LONG_AGO,
    ]);
    const refused = await get("/auth/session", a);
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(refused.headers.get("ratelimit-limit")).toBe("2");
    expect(refused.headers.get("ratelimit-remaining")).toBe("0");
    expect(await errorCode(refused)).toBe("rate_limited");
    // A refused request writes nothing, not even the session's last use.
    expect(await lastUsed(ctx, "session", a.sessionId)).toBe(LONG_AGO);
    // The line names whose budget it was.
    expect(requests().at(-1)).toMatchObject({ accountId: a.accountId, status: 429 });

    await ctx.client.query("UPDATE session SET last_used_at = $2 WHERE id = $1", [
      b.sessionId,
      LONG_AGO,
    ]);
    expect((await get("/auth/session", b)).status).toBe(200);
    expect(await lastUsed(ctx, "session", b.sessionId)).not.toBe(LONG_AGO);
  });

  test("what a person spends is given back to the address, the refused requests included", async ({
    ctx,
  }) => {
    const { get } = await appAt(ctx);
    const a = await signedInAccount(ctx.client, "rate-a");
    const b = await signedInAccount(ctx.client, "rate-b");
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await get("/auth/session", a)).status);
    statuses.push((await get("/auth/session", b)).status);
    expect(statuses).toEqual([200, 200, 429, 200]);
    // Four requests from the address, none of them left on its count.
    expect((await get("/waitlist")).status).toBe(200);
    expect((await get("/waitlist")).status).toBe(200);
    expect((await get("/waitlist")).status).toBe(429);
  });

  test("a token that opens no session stays on the address's count, whatever is wrong with it", async ({
    ctx,
  }) => {
    const { get, requests } = await appAt(ctx, { limit: 5 });
    const revoked = await signedInAccount(ctx.client, "rate-revoked");
    await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [
      revoked.sessionId,
    ]);
    const expired = await signedInAccount(ctx.client, "rate-expired");
    await ctx.client.query(
      "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
    const nobody: [string, Who | undefined][] = [
      ["unauthenticated", undefined],
      ["unauthenticated", bearer("not-a-token")],
      ["unauthenticated", bearer(randomBytes(32).toString("base64url"))],
      ["session_revoked", revoked],
      ["session_expired", expired],
    ];
    for (const [code, who] of nobody) {
      const res = await get("/auth/session", who);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe(code);
    }
    const spent = await get("/waitlist");
    expect(spent.status).toBe(429);
    expect(await errorCode(spent)).toBe("rate_limited");
    expect(requests().at(-1)).not.toHaveProperty("accountId");
  });

  // The address is counted first, before any guard knows who asks (ADR-026
  // §2), so an address spent by requests nobody signed for refuses everyone
  // behind it until its window ends; the edge rule stops such a flood first.
  test("an address spent by requests nobody signed for refuses a live session there too, and only there", async ({
    ctx,
  }) => {
    const { get } = await appAt(ctx);
    const a = await signedInAccount(ctx.client, "rate-a");
    await get("/waitlist");
    await get("/waitlist");
    const refused = await get("/auth/session", a);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("rate_limited");
    expect((await get("/auth/session", a, OTHER_ADDRESS)).status).toBe(200);
  });
});

describe("a budget per member of staff (ADR-026 §1-3)", () => {
  test("is one budget by identity across the three staff guards, and another member of staff at the address keeps theirs", async ({
    ctx,
  }) => {
    const { get, requests } = await appAt(ctx);
    const admin = await staffSession(ctx.client, "admin", "rate-admin");
    const moderator = await staffSession(ctx.client, "moderator", "rate-moderator");

    // Any staff, moderators, admins: three guards, one limiter.
    expect((await get("/admin/whoami", admin)).status).toBe(200);
    expect((await get("/admin/feedback", admin)).status).toBe(200);
    await ctx.client.query("UPDATE admin_session SET last_used_at = $2 WHERE id = $1", [
      admin.sessionId,
      LONG_AGO,
    ]);
    const refused = await get("/admin/staff", admin);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("rate_limited");
    expect(await lastUsed(ctx, "admin_session", admin.sessionId)).toBe(LONG_AGO);
    // Refused by the person's limiter, after the guard: the line says who.
    const line = requests().at(-1);
    expect(line).toMatchObject({ staffIdentityId: admin.identityId, status: 429 });
    expect(line).not.toHaveProperty("accountId");

    expect((await get("/admin/whoami", moderator)).status).toBe(200);
    // And the address was given back every one of them.
    expect((await get("/waitlist")).status).toBe(200);
    expect((await get("/waitlist")).status).toBe(200);
  });
});

describe("one request, counted once (ADR-026 §3)", () => {
  test("PUT /photos/order, which passes the session guard twice, spends one request of the person's budget", async ({
    ctx,
  }) => {
    const { app, put } = await appAt(ctx, { media: true });
    // The overlap the test is about: two guards whose patterns this path matches.
    const guards = app.routes
      .filter((r) => r.handler.name === "requireSession")
      .map((r) => r.path)
      .filter((path) => path === "/photos/order" || path === "/photos/:id");
    expect(guards.sort()).toEqual(["/photos/:id", "/photos/order"]);

    const me: SignedIn = await signedInAccount(ctx.client, "rate-photos");
    const first = await put("/photos/order", { order: [] }, me);
    expect(first.status).not.toBe(429);
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect((await put("/photos/order", { order: [] }, me)).status).not.toBe(429);
    expect((await put("/photos/order", { order: [] }, me)).status).toBe(429);
  });
});

describe("a sign-in start the address's limit refuses (ADR-026 §4)", () => {
  test("goes back to the app or the panel as the doors send one, and every other path keeps the 429", async ({
    ctx,
  }) => {
    const { app, get, refusedSignIns, logs } = await appAt(ctx);
    // Spent on a route nobody signs in for.
    expect((await get("/waitlist")).status).toBe(200);
    expect((await get("/waitlist")).status).toBe(200);

    const appStart = await get("/auth/start?platform=ios");
    expect(appStart.status).toBe(302);
    expect(appStart.headers.get("location")).toBe("kuutti://auth?error=auth_rate_limited");
    expect(Number(appStart.headers.get("retry-after"))).toBeGreaterThan(0);
    const staffStart = await get("/admin/auth/start");
    expect(staffStart.status).toBe(302);
    expect(new URL(staffStart.headers.get("location") ?? "").hash).toBe("#error=auth_rate_limited");
    expect(Number(staffStart.headers.get("retry-after"))).toBeGreaterThan(0);

    // The callback, the exchange and the rest answer in the envelope.
    const exchange = await app.request("/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ADDRESS },
      body: JSON.stringify({ code: "A".repeat(43) }),
    });
    for (const res of [
      await get("/auth/callback?code=x&state=y"),
      exchange,
      await get("/waitlist"),
    ]) {
      expect(res.status).toBe(429);
      expect(await errorCode(res)).toBe("rate_limited");
    }
    const address = expect.objectContaining({
      level: 40,
      code: "auth_rate_limited",
      detail: { limiter: "address" },
    });
    expect(refusedSignIns()).toEqual([address, address]);
    expect(JSON.stringify(logs())).not.toContain("203.0.113");
    // Another address is not refused: here, with no bank configured, the start says so.
    expect((await get("/auth/start?platform=ios", undefined, OTHER_ADDRESS)).status).toBe(503);
  });
});

/** An address of its own, from the third documentation range. */
const THIRD_ADDRESS = "192.0.2.10";

describe("the routes that end a session (ADR-026 §2)", () => {
  test("a stolen session that spends the person's budget cannot keep the owner from signing every device out or deleting the account", async ({
    ctx,
  }) => {
    const { get, post } = await appAt(ctx);
    const owner = await signedInAccount(ctx.client, "rate-owner");
    const thief = await signInAs(ctx.client, owner.accountId);
    // The thief spends the account's budget, which every session of it shares.
    expect((await get("/auth/session", thief)).status).toBe(200);
    expect((await get("/auth/session", thief)).status).toBe(200);
    expect((await get("/auth/session", thief)).status).toBe(429);
    expect((await get("/auth/session", owner, OTHER_ADDRESS)).status).toBe(429);
    // Signing every device out is not refused, and the thief's token is over.
    expect((await post("/auth/logout-all", owner, OTHER_ADDRESS)).status).toBe(204);
    const over = await get("/auth/session", thief);
    expect(over.status).toBe(401);
    expect(await errorCode(over)).toBe("session_revoked");

    // Nor is the deletion, for another account whose budget a thief has spent.
    const victim = await signedInAccount(ctx.client, "rate-victim");
    const other = await signInAs(ctx.client, victim.accountId);
    for (const _ of [1, 2]) await get("/auth/session", other, THIRD_ADDRESS);
    expect((await get("/auth/session", other, THIRD_ADDRESS)).status).toBe(429);
    const deleted = await post("/account/delete", victim, OTHER_ADDRESS, { confirm: true });
    expect(deleted.status).toBe(204);
    const { rows } = await ctx.client.query<{ state: string }>(
      "SELECT state FROM account WHERE id = $1",
      [victim.accountId],
    );
    expect(rows[0]?.state).toBe("deleted");
  });

  test("they stay on the address's count: never given back, and refused once the address is spent", async ({
    ctx,
  }) => {
    const { get, post } = await appAt(ctx);
    // A pause the account cannot take yet (onboarding is not finished) changes nothing.
    const a = await signedInAccount(ctx.client, "rate-pause", { state: "registered" });
    for (const _ of [1, 2]) {
      const res = await post("/account/pause", a, ADDRESS, { confirm: true });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("not_active");
    }
    // Neither was given back: the address is spent, for anybody and for these routes too.
    expect((await get("/waitlist")).status).toBe(429);
    const refused = await post("/auth/logout-all", a);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("rate_limited");
    // The session lives on, and from another address the person's budget is untouched.
    expect((await get("/auth/session", a, OTHER_ADDRESS)).status).toBe(200);
    expect((await get("/auth/session", a, OTHER_ADDRESS)).status).toBe(200);
  });

  test("names POST routes that are there, each behind a guard", async ({ ctx }) => {
    const { app } = await appAt(ctx);
    expect(ENDS_SESSION.size).toBe(5);
    for (const path of ENDS_SESSION) {
      const onPath = app.routes.filter((r) => r.path === path);
      expect(onPath.map((r) => r.method)).toContain("POST");
      expect(
        onPath.some(
          (r) => r.handler.name === "requireSession" || r.handler.name === "requireAdmin",
        ),
      ).toBe(true);
    }
  });
});
