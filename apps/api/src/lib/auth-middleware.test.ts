import { ErrorResponse } from "@kuutti/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { callerOf, hashToken, requireSession, type SessionLookup } from "./auth-middleware.ts";
import type { AppEnv } from "./env.ts";
import { onError } from "./errors.ts";
import { serverRequestId } from "./request-id.ts";

// The session guard's own decisions (#35, security checklist "session
// tokens"), one by one. The store is the seam the guard is given; the real
// one, against Postgres, is exercised by every route test behind the guard.

const NOW = new Date("2026-10-11T09:00:00.000Z");
// 43 characters of base64url, the shape of a session token.
const TOKEN = `${"A".repeat(20)}${"b".repeat(20)}_-9`;
const DB = { query: () => Promise.reject(new Error("the guard's store is the only reader")) };

const live: SessionLookup = {
  accountId: "acc-1",
  sessionId: "ses-1",
  accessExpiresAt: new Date("2026-10-11T09:15:00.000Z"),
  revokedAt: null,
  accountState: "active",
  identityStanding: "ok",
};

/** A limiter that writes what it was handed into `events`, built over the guard's own record. */
type LimitOf = (events: string[]) => MiddlewareHandler<AppEnv>;

async function guarded(
  found: SessionLookup | null,
  options: { now?: () => Date; limit?: LimitOf } = {},
) {
  const asked: string[] = [];
  const touched: { sessionId: string; at: Date }[] = [];
  // What ran, in order: the limiter, the touch, the handler.
  const events: string[] = [];
  const store = {
    findByAccessHash: async (_db: unknown, hash: string) => {
      asked.push(hash);
      return found;
    },
    touch: async (_db: unknown, sessionId: string, at: Date) => {
      touched.push({ sessionId, at });
      events.push("touch");
    },
  };
  const { logger } = await captureLogger();
  const app = new Hono<AppEnv>();
  app.use("*", serverRequestId());
  app.onError(onError<AppEnv>(logger));
  const { limit, ...rest } = options;
  app.use("/me", requireSession({ db: DB, store, ...rest, limit: limit?.(events) }));
  app.get("/me", (c) => {
    events.push("handler");
    return c.json(callerOf(c));
  });
  // A route someone forgot to guard: the caller cannot be read there.
  app.get("/unguarded", (c) => c.json(callerOf(c)));
  const call = async (authorization?: string, path = "/me") => {
    const res = await app.request(path, authorization ? { headers: { authorization } } : {});
    const body: unknown = await res.json();
    return { status: res.status, body };
  };
  const code = (body: unknown) => ErrorResponse.parse(body).error.code;
  return { call, code, asked, touched, events };
}

describe("requireSession", () => {
  it("lets a live session through, names the caller, and marks the session used at that instant", async () => {
    const { call, asked, touched } = await guarded(live, { now: () => NOW });
    expect(await call(`Bearer ${TOKEN}`)).toEqual({
      status: 200,
      body: { accountId: "acc-1", sessionId: "ses-1" },
    });
    // The store is asked by the token's hash, never by the token.
    expect(asked).toEqual([hashToken(TOKEN)]);
    expect(asked[0]).not.toContain(TOKEN);
    expect(touched).toEqual([{ sessionId: "ses-1", at: NOW }]);
  });

  it("tolerates spaces around the token, not another scheme or spelling", async () => {
    const { call, code, asked } = await guarded(live, { now: () => NOW });
    expect((await call(`Bearer   ${TOKEN}  `)).status).toBe(200);
    for (const header of [`bearer ${TOKEN}`, `Basic ${TOKEN}`, TOKEN, `Token ${TOKEN}`]) {
      const answer = await call(header);
      expect(answer.status, header).toBe(401);
      expect(code(answer.body)).toBe("unauthenticated");
    }
    expect(asked).toHaveLength(1);
  });

  it("refuses a missing or malformed token without asking the store", async () => {
    const { call, code, asked } = await guarded(live, { now: () => NOW });
    for (const header of [
      undefined,
      "Bearer ",
      `Bearer ${TOKEN.slice(1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}+`,
      `Bearer ${TOKEN.slice(1)}=`,
    ]) {
      const answer = await call(header);
      expect(answer.status, String(header)).toBe(401);
      expect(code(answer.body)).toBe("unauthenticated");
    }
    expect(asked).toEqual([]);
  });

  it("refuses a well-formed token the store does not know", async () => {
    const { call, code, touched } = await guarded(null, { now: () => NOW });
    const answer = await call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("unauthenticated");
    expect(touched).toEqual([]);
  });

  it.each([
    ["revoked", { revokedAt: new Date("2026-10-11T08:00:00.000Z") }],
    ["of a deleted account", { accountState: "deleted" }],
    ["of a suspended account", { accountState: "suspended" }],
    ["of a banned account", { accountState: "banned" }],
    ["of a suspended identity", { identityStanding: "suspended" }],
    ["of a banned identity", { identityStanding: "banned" }],
    // Ended weighs more than expired: the app must not try a refresh.
    [
      "revoked and expired",
      {
        revokedAt: new Date("2026-10-11T08:00:00.000Z"),
        accessExpiresAt: new Date("2026-10-11T08:30:00.000Z"),
      },
    ],
  ] as const)("a session %s is ended: session_revoked, not used", async (_, change) => {
    const { call, code, touched } = await guarded({ ...live, ...change }, { now: () => NOW });
    const answer = await call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("session_revoked");
    expect(touched).toEqual([]);
  });

  it.each(["registered", "active", "paused", "shadow_banned"])(
    "an account that is %s keeps its session",
    async (accountState) => {
      const { call } = await guarded({ ...live, accountState }, { now: () => NOW });
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
    },
  );

  it("an access token past its time is expired, and good to its last millisecond", async () => {
    const expired = await guarded(
      { ...live, accessExpiresAt: new Date(NOW.getTime() - 1) },
      { now: () => NOW },
    );
    const answer = await expired.call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(expired.code(answer.body)).toBe("session_expired");
    expect(expired.touched).toEqual([]);

    const lastMoment = await guarded({ ...live, accessExpiresAt: NOW }, { now: () => NOW });
    expect((await lastMoment.call(`Bearer ${TOKEN}`)).status).toBe(200);
  });

  it("reads the clock when none is given", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { call, touched } = await guarded(live);
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
      expect(touched).toEqual([{ sessionId: "ses-1", at: NOW }]);
      vi.setSystemTime(new Date(live.accessExpiresAt.getTime() + 1));
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The person's limiter as the guard sees it (ADR-026 §1-2): it records the
 * caller the guard has set by then, and admits or refuses.
 */
function personLimiter(answer: "admit" | "refuse") {
  const seen: { accountId?: string; sessionId?: string }[] = [];
  const limit: LimitOf = (events) => async (c, next) => {
    events.push("limit");
    seen.push({ accountId: c.get("accountId"), sessionId: c.get("sessionId") });
    if (answer === "refuse") return c.json({ refusedBy: "the person's limiter" }, 429);
    await next();
  };
  return { limit, seen };
}

describe("requireSession and the person's limiter (ADR-026)", () => {
  it("hands an admitted request to the limiter with the caller set, and marks the session used only once it lets the request on", async () => {
    const { limit, seen } = personLimiter("admit");
    const { call, events, touched } = await guarded(live, { now: () => NOW, limit });
    expect(await call(`Bearer ${TOKEN}`)).toEqual({
      status: 200,
      body: { accountId: "acc-1", sessionId: "ses-1" },
    });
    expect(seen).toEqual([{ accountId: "acc-1", sessionId: "ses-1" }]);
    expect(events).toEqual(["limit", "touch", "handler"]);
    expect(touched).toEqual([{ sessionId: "ses-1", at: NOW }]);
  });

  it("answers with the limiter's refusal, and a refused request writes nothing, not even the touch", async () => {
    const { limit, seen } = personLimiter("refuse");
    const { call, events, touched } = await guarded(live, { now: () => NOW, limit });
    expect(await call(`Bearer ${TOKEN}`)).toEqual({
      status: 429,
      body: { refusedBy: "the person's limiter" },
    });
    expect(seen).toEqual([{ accountId: "acc-1", sessionId: "ses-1" }]);
    expect(events).toEqual(["limit"]);
    expect(touched).toEqual([]);
  });

  // A token that opens no session stays on the address's count (ADR-026 §2):
  // the person's limiter never sees it.
  it.each([
    ["no token", undefined, live, "unauthenticated"],
    ["a malformed token", `Bearer ${TOKEN.slice(1)}`, live, "unauthenticated"],
    ["an unknown token", `Bearer ${TOKEN}`, null, "unauthenticated"],
    [
      "a revoked session",
      `Bearer ${TOKEN}`,
      { ...live, revokedAt: new Date("2026-10-11T08:00:00.000Z") },
      "session_revoked",
    ],
    [
      "an expired access token",
      `Bearer ${TOKEN}`,
      { ...live, accessExpiresAt: new Date(NOW.getTime() - 1) },
      "session_expired",
    ],
  ] as const)("%s never reaches the limiter", async (_, authorization, found, expected) => {
    const { limit, seen } = personLimiter("refuse");
    const { call, code, events } = await guarded(found, { now: () => NOW, limit });
    const answer = await call(authorization);
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe(expected);
    expect(seen).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("callerOf", () => {
  it("refuses a route that is not behind the guard rather than answer without a caller", async () => {
    const { call, code } = await guarded(live, { now: () => NOW });
    const answer = await call(`Bearer ${TOKEN}`, "/unguarded");
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("unauthenticated");
  });
});
