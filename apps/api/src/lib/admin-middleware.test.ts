import type { ModeratorRole } from "@kuutti/schema";
import { ErrorResponse } from "@kuutti/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { type AdminLookup, hashToken, requireAdmin, staffOf } from "./admin-middleware.ts";
import type { AppEnv } from "./env.ts";
import { onError } from "./errors.ts";
import { serverRequestId } from "./request-id.ts";

// The staff guard's own decisions (#49, security checklist line 10), one by
// one: the token, the session, the identity's standing, and the role held
// now against the roles the route admits. The store is the seam the guard is
// given; the real one is exercised by the admin route tests.

const NOW = new Date("2026-10-11T09:00:00.000Z");
// 43 characters of base64url, the shape of an admin token.
const TOKEN = `${"Z".repeat(21)}${"y".repeat(21)}-`;
const DB = { query: () => Promise.reject(new Error("the guard's store is the only reader")) };

const live: AdminLookup = {
  sessionId: "adm-ses-1",
  identityId: "idn-1",
  role: "moderator",
  currentRole: "moderator",
  expiresAt: new Date("2026-10-11T17:00:00.000Z"),
  revokedAt: null,
  identityStanding: "ok",
};

/** A limiter that writes what it was handed into `events`, built over the guard's own record. */
type LimitOf = (events: string[]) => MiddlewareHandler<AppEnv>;

async function guarded(
  found: AdminLookup | null,
  roles: readonly ModeratorRole[] = ["moderator", "admin"],
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
  const { logger, lines } = await captureLogger();
  const app = new Hono<AppEnv>();
  app.use("*", serverRequestId());
  app.onError(onError<AppEnv>(logger));
  const { limit, ...rest } = options;
  app.use("/queue", requireAdmin({ db: DB, store, roles, ...rest, limit: limit?.(events) }));
  app.get("/queue", (c) => {
    events.push("handler");
    return c.json(staffOf(c));
  });
  // A staff route someone forgot to guard.
  app.get("/unguarded", (c) => c.json(staffOf(c)));
  const call = async (authorization?: string, path = "/queue") => {
    const res = await app.request(path, authorization ? { headers: { authorization } } : {});
    const body: unknown = await res.json();
    return { status: res.status, body };
  };
  const code = (body: unknown) => ErrorResponse.parse(body).error.code;
  return { call, code, asked, touched, lines, events };
}

describe("requireAdmin", () => {
  it("lets a live staff session through with the role held now, and marks it used", async () => {
    const { call, asked, touched } = await guarded(live, ["moderator", "admin"], {
      now: () => NOW,
    });
    expect(await call(`Bearer ${TOKEN}`)).toEqual({
      status: 200,
      body: {
        identityId: "idn-1",
        role: "moderator",
        sessionId: "adm-ses-1",
        expiresAt: "2026-10-11T17:00:00.000Z",
      },
    });
    expect(asked).toEqual([hashToken(TOKEN)]);
    expect(touched).toEqual([{ sessionId: "adm-ses-1", at: NOW }]);
  });

  it("refuses a missing, malformed or differently spelled token without asking the store", async () => {
    const { call, code, asked } = await guarded(live, undefined, { now: () => NOW });
    for (const header of [
      undefined,
      "Bearer ",
      `bearer ${TOKEN}`,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN.slice(2)}`,
      `Bearer ${TOKEN.slice(1)}/`,
    ]) {
      const answer = await call(header);
      expect(answer.status, String(header)).toBe(401);
      expect(code(answer.body)).toBe("unauthenticated");
    }
    expect(asked).toEqual([]);
  });

  it("refuses a well-formed token the store does not know (a product session's included)", async () => {
    const { call, code } = await guarded(null, undefined, { now: () => NOW });
    const answer = await call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("unauthenticated");
  });

  it.each([
    ["revoked", { revokedAt: new Date("2026-10-11T08:00:00.000Z") }],
    ["of a banned identity", { identityStanding: "banned" }],
    ["of a suspended identity", { identityStanding: "suspended" }],
    // A role taken away today ends the access today, eight-hour token or not.
    ["whose role was taken away", { currentRole: null }],
    [
      "whose role was taken away after it expired",
      { currentRole: null, expiresAt: new Date("2026-10-11T08:00:00.000Z") },
    ],
  ] as const)("a staff session %s is ended: session_revoked", async (_, change) => {
    const { call, code, touched } = await guarded({ ...live, ...change }, undefined, {
      now: () => NOW,
    });
    const answer = await call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("session_revoked");
    expect(touched).toEqual([]);
  });

  it("an admin session past its eight hours is expired, and good to its last millisecond", async () => {
    const expired = await guarded({ ...live, expiresAt: new Date(NOW.getTime() - 1) }, undefined, {
      now: () => NOW,
    });
    const answer = await expired.call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(401);
    expect(expired.code(answer.body)).toBe("session_expired");

    const lastMoment = await guarded({ ...live, expiresAt: NOW }, undefined, { now: () => NOW });
    expect((await lastMoment.call(`Bearer ${TOKEN}`)).status).toBe(200);
  });

  it("a role the route does not admit is forbidden, by the role held now, not the one signed in with", async () => {
    // Signed in as an admin, a researcher now: the moderation queue is closed to them.
    const demoted = await guarded(
      { ...live, role: "admin", currentRole: "researcher" },
      ["moderator", "admin"],
      { now: () => NOW },
    );
    const answer = await demoted.call(`Bearer ${TOKEN}`);
    expect(answer.status).toBe(403);
    expect(demoted.code(answer.body)).toBe("admin_forbidden");
    expect(demoted.touched).toEqual([]);
    expect(demoted.lines().find((l) => l.msg === "This role does not allow that")).toMatchObject({
      detail: { role: "researcher" },
    });

    // Signed in as a researcher, promoted since: let in as what they are now.
    const promoted = await guarded(
      { ...live, role: "researcher", currentRole: "admin" },
      ["admin"],
      { now: () => NOW },
    );
    expect(await promoted.call(`Bearer ${TOKEN}`)).toMatchObject({
      status: 200,
      body: { role: "admin" },
    });
  });

  it("reads the clock when none is given", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { call, touched } = await guarded(live);
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
      expect(touched).toEqual([{ sessionId: "adm-ses-1", at: NOW }]);
      vi.setSystemTime(new Date(live.expiresAt.getTime() + 1));
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The person's limiter as the staff guard sees it (ADR-026 §1-3): it records
 * the member of staff the guard has set by then, and admits or refuses.
 */
function personLimiter(answer: "admit" | "refuse") {
  const seen: { identityId?: string; role?: string; sessionId?: string }[] = [];
  const limit: LimitOf = (events) => async (c, next) => {
    events.push("limit");
    seen.push({
      identityId: c.get("adminIdentityId"),
      role: c.get("adminRole"),
      sessionId: c.get("adminSessionId"),
    });
    if (answer === "refuse") return c.json({ refusedBy: "the person's limiter" }, 429);
    await next();
  };
  return { limit, seen };
}

describe("requireAdmin and the person's limiter (ADR-026)", () => {
  it("hands an admitted request to the limiter with the member of staff set, and marks the session used only once it lets the request on", async () => {
    const { limit, seen } = personLimiter("admit");
    const { call, events, touched } = await guarded(live, undefined, { now: () => NOW, limit });
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
    expect(seen).toEqual([{ identityId: "idn-1", role: "moderator", sessionId: "adm-ses-1" }]);
    expect(events).toEqual(["limit", "touch", "handler"]);
    expect(touched).toEqual([{ sessionId: "adm-ses-1", at: NOW }]);
  });

  it("answers with the limiter's refusal, and a refused request writes nothing, not even the touch", async () => {
    const { limit, seen } = personLimiter("refuse");
    const { call, events, touched } = await guarded(live, undefined, { now: () => NOW, limit });
    expect(await call(`Bearer ${TOKEN}`)).toEqual({
      status: 429,
      body: { refusedBy: "the person's limiter" },
    });
    expect(seen).toHaveLength(1);
    expect(events).toEqual(["limit"]);
    expect(touched).toEqual([]);
  });

  // What the guard refuses itself stays on the address's count (ADR-026 §2),
  // a role the route does not admit included.
  it.each([
    ["no token", undefined, live, ["moderator", "admin"], 401, "unauthenticated"],
    [
      "a malformed token",
      `Bearer ${TOKEN.slice(2)}`,
      live,
      ["moderator", "admin"],
      401,
      "unauthenticated",
    ],
    ["an unknown token", `Bearer ${TOKEN}`, null, ["moderator", "admin"], 401, "unauthenticated"],
    [
      "a revoked session",
      `Bearer ${TOKEN}`,
      { ...live, revokedAt: new Date("2026-10-11T08:00:00.000Z") },
      ["moderator", "admin"],
      401,
      "session_revoked",
    ],
    [
      "a role taken away",
      `Bearer ${TOKEN}`,
      { ...live, currentRole: null },
      ["moderator", "admin"],
      401,
      "session_revoked",
    ],
    [
      "an expired session",
      `Bearer ${TOKEN}`,
      { ...live, expiresAt: new Date(NOW.getTime() - 1) },
      ["moderator", "admin"],
      401,
      "session_expired",
    ],
    ["a role the route does not admit", `Bearer ${TOKEN}`, live, ["admin"], 403, "admin_forbidden"],
  ] as const)(
    "%s never reaches the limiter",
    async (_, authorization, found, roles, status, expected) => {
      const { limit, seen } = personLimiter("refuse");
      const { call, code, events } = await guarded(found, roles, { now: () => NOW, limit });
      const answer = await call(authorization);
      expect(answer.status).toBe(status);
      expect(code(answer.body)).toBe(expected);
      expect(seen).toEqual([]);
      expect(events).toEqual([]);
    },
  );
});

describe("staffOf", () => {
  it("refuses a staff route that is not behind the guard rather than answer without a member of staff", async () => {
    const { call, code } = await guarded(live, undefined, { now: () => NOW });
    const answer = await call(`Bearer ${TOKEN}`, "/unguarded");
    expect(answer.status).toBe(401);
    expect(code(answer.body)).toBe("unauthenticated");
  });
});
