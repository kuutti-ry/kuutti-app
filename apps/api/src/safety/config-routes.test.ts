import type { Queryable } from "@kuutti/db";
import { ConfigChange, ConfigList } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import { interleavedAfter as interleaved } from "../test/chat.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type LogLine,
  type TestContext,
  testConfig,
} from "../test/harness.ts";

// The panel's two tunable routes through the app (#304, #305): each answer's
// status and shape, every validation rule, each variant of the staff guard,
// the roles, the 404, the shape check, the race and the log line. What the
// domain writes is config.test.ts's; here it is checked as far as a route
// promises it. Every request is followed by a look at the log: the admin's
// reason reaches no line of it, whatever the request answered.

/** The routes' clock: 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00Z");

// The mark is letters no id, token or request id is made of.
const MARK = "jxqzv";
const REASON = `Fewer cards while the pond is small ${MARK}`;
const REASON_OF = (length: number) => MARK.repeat(Math.ceil(length / 5)).slice(0, length);

type Headers = Record<string, string>;
type Api = { app: App; logs: () => LogLine[] };

async function appOn(db: Queryable): Promise<Api> {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db, now: () => T }), logs: lines };
}

const test = base.extend<{ api: Api }>({
  api: async ({ ctx }, use) => {
    await use(await appOn(ctx.client));
  },
});

async function send(
  api: Api,
  method: "GET" | "POST",
  path: string,
  headers: Headers,
  body?: unknown,
): Promise<Response> {
  const response = await api.app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(JSON.stringify(api.logs()), `${method} ${path} logged the reason`).not.toContain(MARK);
  return response;
}

const list = (api: Api, headers: Headers) => send(api, "GET", "/admin/config", headers);
const change = (api: Api, headers: Headers, key: string, body: unknown) =>
  send(api, "POST", `/admin/config/${key}`, headers, body);

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await errorCode(response)).toBe(code);
}

/** Everything a change may write, to compare before and after a refusal. */
async function footprint(ctx: TestContext) {
  const config = await ctx.client.query(
    "SELECT id, key, version, value, valid_from, created_by, reason FROM matching_config ORDER BY key, version",
  );
  const audit = await ctx.client.query(
    "SELECT id FROM audit_log WHERE action = 'config.change' OR subject_type = 'config' ORDER BY id",
  );
  return { config: config.rows, audit: audit.rows };
}

async function admin(ctx: TestContext) {
  return staffSession(ctx.client, "admin");
}

describe("GET /admin/config", () => {
  test("an admin reads every key once with its versions, held to the contract", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const response = await list(api, staff.headers);
    expect(response.status).toBe(200);
    const { items } = ConfigList.parse(await response.json());
    const { rows } = await ctx.client.query<{ key: string }>(
      "SELECT DISTINCT key FROM matching_config ORDER BY key",
    );
    expect(items.map((i) => i.key)).toEqual(rows.map((r) => r.key));
    expect(items.find((i) => i.key === "deal_breakers_max")).toMatchObject({
      value: 7,
      version: 1,
      versions: [{ version: 1, value: 7, createdBy: "migration:0001", reason: null }],
    });
    expect(items.find((i) => i.key === "photo_fetches_per_day")?.value).toEqual({
      thumb: 600,
      card: 0,
      full: 60,
    });
  });

  test("a change from the panel tops the key's versions with its author and reason", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    expect(
      (await change(api, staff.headers, "like_budget_balanced", { value: 8, reason: REASON }))
        .status,
    ).toBe(200);
    const { items } = ConfigList.parse(await (await list(api, staff.headers)).json());
    const likes = items.find((i) => i.key === "like_budget_balanced");
    expect(likes).toMatchObject({ value: 8, version: 2 });
    expect(likes?.versions).toEqual([
      {
        version: 2,
        value: 8,
        validFrom: T.toISOString(),
        createdBy: staff.identityId,
        reason: REASON,
      },
      // The first cut's ten (#98, ADR-036), as the migrations write it.
      {
        version: 1,
        value: 10,
        validFrom: expect.any(String),
        createdBy: "migration:0001",
        reason: null,
      },
    ]);
  });
});

describe("POST /admin/config/{key}", () => {
  test("an admin's change answers the key with its new version, and the log names the key and the version, never the reason", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const response = await change(api, staff.headers, "exposure_cards_per_day", {
      value: 45,
      reason: REASON,
    });
    expect(response.status).toBe(200);
    // The answer is the row this change wrote; the list has the history.
    expect(ConfigChange.parse(await response.json())).toEqual({
      key: "exposure_cards_per_day",
      version: 2,
      value: 45,
      validFrom: T.toISOString(),
      createdBy: staff.identityId,
      reason: REASON,
    });
    const listed = ConfigList.parse(await (await list(api, staff.headers)).json()).items.find(
      (k) => k.key === "exposure_cards_per_day",
    );
    expect(listed?.versions.map((v) => [v.version, v.value, v.createdBy, v.reason])).toEqual([
      [2, 45, staff.identityId, REASON],
      [1, 0, "migration:0001", null],
    ]);

    const lines = api.logs().filter((l) => l.msg === "config changed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      staffIdentityId: staff.identityId,
      key: "exposure_cards_per_day",
      version: 2,
    });
    expect(lines[0]).not.toHaveProperty("reason");
    expect(JSON.stringify(api.logs())).not.toContain(MARK);
  });

  test("a string, a boolean, and an object with its keys in another order keep their shape and are written", async ({
    ctx,
    api,
  }) => {
    await withMatchingConfig(ctx.client, { config_routes_flag: true, config_routes_word: "one" });
    const staff = await admin(ctx);
    for (const [key, value, version] of [
      ["config_routes_word", "another", 2],
      ["config_routes_flag", false, 2],
      ["photo_fetches_per_day", { full: 30, card: 300, thumb: 600 }, 2],
    ] as const) {
      const response = await change(api, staff.headers, key, { value, reason: REASON });
      expect(response.status, key).toBe(200);
      const answer = ConfigChange.parse(await response.json());
      expect(answer, key).toMatchObject({ key, version });
      expect(answer.value, key).toEqual(value);
    }
  });

  test("an app without a clock of its own dates the version by the wall clock", async ({ ctx }) => {
    const staff = await admin(ctx);
    const before = Date.now();
    const response = await ctx.app.request("/admin/config/like_expiry_days", {
      method: "POST",
      headers: { ...staff.headers, "content-type": "application/json" },
      body: JSON.stringify({ value: 35, reason: REASON }),
    });
    const after = Date.now();
    expect(response.status).toBe(200);
    const validFrom = Date.parse(ConfigChange.parse(await response.json()).validFrom);
    expect(validFrom).toBeGreaterThanOrEqual(before);
    expect(validFrom).toBeLessThanOrEqual(after);
  });

  test("the reason is stored without its surrounding spaces, and 500 characters are enough", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const spaced = await change(api, staff.headers, "like_expiry_days", {
      value: 9,
      reason: `  ${REASON}\n `,
    });
    expect(spaced.status).toBe(200);
    expect(ConfigChange.parse(await spaced.json()).reason).toBe(REASON);

    const longest = REASON_OF(500);
    const full = await change(api, staff.headers, "like_expiry_days", {
      value: 8,
      reason: longest,
    });
    expect(full.status).toBe(200);
    expect(ConfigChange.parse(await full.json())).toMatchObject({
      version: 3,
      reason: longest,
    });
  });

  test.for([
    ["a key in upper case", "MAX_PHOTOS", { value: 10, reason: REASON }],
    ["a key with a dash", "max-photos", { value: 10, reason: REASON }],
    ["a key that starts with a digit", "1max_photos", { value: 10, reason: REASON }],
    ["a key of 65 characters", "a".repeat(65), { value: 10, reason: REASON }],
    ["a missing reason", "max_photos", { value: 10 }],
    ["an empty reason", "max_photos", { value: 10, reason: "" }],
    ["a reason of spaces", "max_photos", { value: 10, reason: " \t\n " }],
    ["a reason of 501 characters", "max_photos", { value: 10, reason: REASON_OF(501) }],
    ["a reason that is not a string", "max_photos", { value: 10, reason: 7 }],
    ["a missing value", "max_photos", { reason: REASON }],
    ["an extra key in the body", "max_photos", { value: 10, reason: REASON, note: MARK }],
    ["a value that is an array", "max_photos", { value: [10], reason: REASON }],
    [
      "a value that is a nested object",
      "photo_fetches_per_day",
      { value: { thumb: { x: 600 }, card: 300, full: 60 }, reason: REASON },
    ],
    ["a value that is null", "max_photos", { value: null, reason: REASON }],
  ] as const)(
    "refuses %s with validation_failed, and nothing is written",
    async ([, key, body], { ctx, api }) => {
      const staff = await admin(ctx);
      const before = await footprint(ctx);
      await refused(await change(api, staff.headers, key, body), 400, "validation_failed");
      expect(await footprint(ctx)).toEqual(before);
      expect(api.logs().some((l) => l.msg === "config changed")).toBe(false);
    },
  );

  test("a key of 64 characters passes the contract and is 404, as is any key no migration made", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const before = await footprint(ctx);
    for (const key of ["a".repeat(64), "no_such_tunable"]) {
      await refused(
        await change(api, staff.headers, key, { value: 1, reason: REASON }),
        404,
        "not_found",
      );
    }
    expect(await footprint(ctx)).toEqual(before);
  });

  test("the invitation's reward takes the shape its latest migration gave it, not the one its first version had (#503, ADR-044 §4)", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const value = { inviterFish: 2, friendFish: 0 };
    const written = await change(api, staff.headers, "invitation_reward", {
      value,
      reason: REASON,
    });
    expect(written.status).toBe(200);
    expect(ConfigChange.parse(await written.json())).toMatchObject({
      key: "invitation_reward",
      value,
    });
  });

  test("the invitation's reward refuses the shape of its first version, which the night and the app would refuse (#503)", async ({
    ctx,
    api,
  }) => {
    const staff = await admin(ctx);
    const before = await footprint(ctx);
    await refused(
      await change(api, staff.headers, "invitation_reward", {
        value: { fish: 2, likes: 0 },
        reason: REASON,
      }),
      400,
      "config_shape",
    );
    expect(await footprint(ctx)).toEqual(before);
  });

  test.for([
    ["inviterFish", { inviterFish: 11, friendFish: 1 }],
    ["friendFish", { inviterFish: 1, friendFish: 11 }],
  ] as const)(
    "the invitation's reward refuses %s past the ceiling its reader holds, which would answer 500 to everybody (#503)",
    async ([, value], { ctx, api }) => {
      const staff = await admin(ctx);
      const before = await footprint(ctx);
      await refused(
        await change(api, staff.headers, "invitation_reward", { value, reason: REASON }),
        400,
        "config_shape",
      );
      expect(await footprint(ctx)).toEqual(before);
    },
  );

  test("the invitation's reward takes the ceiling itself (#503)", async ({ ctx, api }) => {
    const staff = await admin(ctx);
    const written = await change(api, staff.headers, "invitation_reward", {
      value: { inviterFish: 10, friendFish: 10 },
      reason: REASON,
    });
    expect(written.status).toBe(200);
  });

  test("a value of another shape is config_shape, logged with the kind it expects, and nothing is written", async ({
    ctx,
    api,
  }) => {
    await withMatchingConfig(ctx.client, { config_routes_word: "one" });
    const staff = await admin(ctx);
    const before = await footprint(ctx);
    for (const [key, value, expected] of [
      ["max_photos", "10", "number"],
      ["config_routes_word", 1, "string"],
      ["photo_fetches_per_day", { thumb: 600, card: 300 }, "object"],
      ["photo_fetches_per_day", 600, "object"],
      // A count keeps its wholeness and sign: a fraction there answers 500 for everyone.
      ["feedback_per_day", 5.5, "number"],
      ["feedback_per_day", -1, "number"],
      ["photo_fetches_per_day", { thumb: 600.5, card: 300, full: 60 }, "object"],
    ] as const) {
      await refused(
        await change(api, staff.headers, key, { value, reason: REASON }),
        400,
        "config_shape",
      );
      expect(
        api
          .logs()
          .filter((l) => l.code === "config_shape")
          .at(-1)?.detail,
        key,
      ).toEqual({
        key,
        expected,
      });
    }
    expect(await footprint(ctx)).toEqual(before);
    expect(api.logs().some((l) => l.msg === "config changed")).toBe(false);
  });

  test("of two admins changing one key at once, one writes and the other is config_conflict", async ({
    ctx,
    api,
  }) => {
    const first = await admin(ctx);
    const second = await admin(ctx);
    // The second admin's change commits after the first has read version 1
    // and before it writes: both want version 2.
    const db = interleaved(
      ctx.client,
      /FROM matching_config WHERE key = \$1 ORDER BY version DESC LIMIT 1/,
      async () => {
        const theirs = await change(api, second.headers, "pass_cooldown_days", {
          value: 60,
          reason: REASON,
        });
        expect(theirs.status).toBe(200);
      },
    );
    const raced = await appOn(db);
    await refused(
      await change(raced, first.headers, "pass_cooldown_days", { value: 45, reason: REASON }),
      409,
      "config_conflict",
    );
    expect(db.ran()).toBe(true);
    const { rows } = await ctx.client.query<{
      version: number;
      value: unknown;
      created_by: string;
    }>(
      "SELECT version, value, created_by FROM matching_config WHERE key = 'pass_cooldown_days' ORDER BY version",
    );
    expect(rows).toEqual([
      { version: 1, value: 30, created_by: "migration:0001" },
      { version: 2, value: 60, created_by: second.identityId },
    ]);
    const audit = await ctx.client.query<{ actor_identity_id: string }>(
      "SELECT actor_identity_id FROM audit_log WHERE action = 'config.change'",
    );
    expect(audit.rows).toEqual([{ actor_identity_id: second.identityId }]);
    expect(raced.logs().some((l) => l.msg === "config changed")).toBe(false);
  });

  test("a change another admin follows at once still logs and answers the version it wrote", async ({
    ctx,
    api,
  }) => {
    const first = await admin(ctx);
    const second = await admin(ctx);
    // The second admin's change commits just after the first's, before the
    // first reads the key back for its answer and its log line.
    const db = interleaved(ctx.client, /^RELEASE SAVEPOINT/, async () => {
      const theirs = await change(api, second.headers, "silent_match_archive_days", {
        value: 5,
        reason: REASON,
      });
      expect(theirs.status).toBe(200);
    });
    const raced = await appOn(db);
    const response = await change(raced, first.headers, "silent_match_archive_days", {
      value: 6,
      reason: REASON,
    });
    expect(response.status).toBe(200);
    expect(db.ran()).toBe(true);
    // The answer and the log name the version this request wrote, whatever came just after it.
    expect(ConfigChange.parse(await response.json())).toMatchObject({
      version: 2,
      value: 6,
      createdBy: first.identityId,
    });
    const listed = ConfigList.parse(await (await list(api, first.headers)).json()).items.find(
      (k) => k.key === "silent_match_archive_days",
    );
    expect(listed?.versions.map((v) => [v.version, v.value, v.createdBy])).toEqual([
      [3, 5, second.identityId],
      [2, 6, first.identityId],
      [1, 7, "migration:0001"],
    ]);
    expect(raced.logs().find((l) => l.msg === "config changed")).toMatchObject({
      staffIdentityId: first.identityId,
      key: "silent_match_archive_days",
      version: 2,
    });
    expect(api.logs().find((l) => l.msg === "config changed")).toMatchObject({
      staffIdentityId: second.identityId,
      key: "silent_match_archive_days",
      version: 3,
    });
  });
});

describe("the admin guard on both routes", () => {
  const routes = [
    ["GET /admin/config", (api: Api, h: Headers) => list(api, h)],
    [
      "POST /admin/config/{key}",
      (api: Api, h: Headers) => change(api, h, "max_photos", { value: 10, reason: REASON }),
    ],
  ] as const;

  test("each variant of a missing or dead session is refused with its own code, and nothing is written", async ({
    ctx,
    api,
  }) => {
    const member = await signedInAccount(ctx.client);
    const ended = await admin(ctx);
    await ctx.client.query("UPDATE admin_session SET revoked_at = now() WHERE id = $1", [
      ended.sessionId,
    ]);
    const expired = await admin(ctx);
    await ctx.client.query(
      "UPDATE admin_session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    const demoted = await admin(ctx);
    await ctx.client.query("DELETE FROM moderator_roles WHERE identity_id = $1", [
      demoted.identityId,
    ]);
    const before = await footprint(ctx);
    for (const [what, headers, code] of [
      ["no token", {}, "unauthenticated"],
      ["another scheme", { authorization: `Basic ${"A".repeat(43)}` }, "unauthenticated"],
      ["a malformed token", { authorization: "Bearer not-a-token" }, "unauthenticated"],
      ["an unknown token", { authorization: `Bearer ${"A".repeat(43)}` }, "unauthenticated"],
      ["a product session's token", member.headers, "unauthenticated"],
      ["an ended session", ended.headers, "session_revoked"],
      ["a role taken away", demoted.headers, "session_revoked"],
      ["an expired session", expired.headers, "session_expired"],
    ] as const) {
      for (const [route, call] of routes) {
        const response = await call(api, headers);
        expect(response.status, `${what}: ${route}`).toBe(401);
        expect(await errorCode(response), `${what}: ${route}`).toBe(code);
      }
    }
    expect(await footprint(ctx)).toEqual(before);
  });

  test("the guard answers before the contract is read", async ({ api }) => {
    await refused(
      await change(api, {}, "NOT-A-KEY", { value: [], extra: 1 }),
      401,
      "unauthenticated",
    );
  });

  test("a moderator and a researcher are refused both routes with admin_forbidden, and nothing is written", async ({
    ctx,
    api,
  }) => {
    const moderator = await staffSession(ctx.client, "moderator");
    const researcher = await staffSession(ctx.client, "researcher");
    const before = await footprint(ctx);
    for (const staff of [moderator, researcher]) {
      for (const [route, call] of routes) {
        const response = await call(api, staff.headers);
        expect(response.status, `${staff.role}: ${route}`).toBe(403);
        expect(await errorCode(response), `${staff.role}: ${route}`).toBe("admin_forbidden");
      }
    }
    expect(await footprint(ctx)).toEqual(before);
    expect(api.logs().some((l) => l.msg === "config changed")).toBe(false);
  });
});
