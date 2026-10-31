import type { Queryable } from "@kuutti/db";
import { ConfigChange, ConfigList } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { type App, createApp } from "../app.ts";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "../test/account.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { changeConfig, listConfig, sameShape } from "./config.ts";

// The tunables in the panel (#304, #305, features/safety/config.feature): the
// three scenarios through the routes, then the domain's three functions on
// the real database. The routes' every answer is config-routes.test.ts's.

/** The routes' clock: 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00Z");

type Headers = Record<string, string>;
const test = base.extend<{ api: App }>({
  api: async ({ ctx }, use) => {
    const { logger } = await captureLogger();
    await use(createApp({ config: testConfig(), logger, db: ctx.client, now: () => T }));
  },
});

const asJson = (headers: Headers) => ({ ...headers, "content-type": "application/json" });
const sendFeedback = (api: App, headers: Headers) =>
  api.request("/feedback", {
    method: "POST",
    headers: asJson(headers),
    body: JSON.stringify({
      kind: "idea",
      text: "More tunables, please.",
      appVersion: "0.23.0",
      platform: "ios",
      locale: "fi",
    }),
  });
const change = (api: App, headers: Headers, key: string, body: unknown) =>
  api.request(`/admin/config/${key}`, {
    method: "POST",
    headers: asJson(headers),
    body: JSON.stringify(body),
  });
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

type VersionRow = {
  id: string;
  version: number;
  value: unknown;
  valid_from: Date;
  created_by: string;
  reason: string | null;
};
const versionsOf = async (ctx: TestContext, key: string) =>
  (
    await ctx.client.query<VersionRow>(
      `SELECT id, version, value, valid_from, created_by, reason
       FROM matching_config WHERE key = $1 ORDER BY version`,
      [key],
    )
  ).rows;
const configAudit = async (ctx: TestContext) =>
  (
    await ctx.client.query<{
      actor_identity_id: string;
      action: string;
      subject_type: string;
      subject_id: string;
      detail: unknown;
    }>(
      `SELECT actor_identity_id, action, subject_type, subject_id, detail
       FROM audit_log WHERE action = 'config.change' OR subject_type = 'config'
       ORDER BY (detail->>'version')::int, actor_identity_id`,
    )
  ).rows;
const feedbackCount = async (ctx: TestContext, accountId: string) =>
  (
    await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM feedback WHERE account_id = $1",
      [accountId],
    )
  ).rows[0]?.n;

describe("features/safety/config.feature", () => {
  test("A changed tunable holds from the next request", async ({ ctx, api }) => {
    await withMatchingConfig(ctx.client, { feedback_per_day: 5 });
    const a = await signedInAccount(ctx.client);
    const admin = await staffSession(ctx.client, "admin");
    for (let i = 0; i < 5; i += 1) expect((await sendFeedback(api, a.headers)).status).toBe(204);
    const refused = await sendFeedback(api, a.headers);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("feedback_budget_exceeded");

    const changed = await change(api, admin.headers, "feedback_per_day", {
      value: 6,
      reason: "Testers send more than five on a busy day",
    });
    expect(changed.status).toBe(200);

    expect((await sendFeedback(api, a.headers)).status).toBe(204);
    expect(await feedbackCount(ctx, a.accountId)).toBe(6);
    // Six is the new cap, not no cap.
    const seventh = await sendFeedback(api, a.headers);
    expect(seventh.status).toBe(429);
    expect(await errorCode(seventh)).toBe("feedback_budget_exceeded");
    expect(await feedbackCount(ctx, a.accountId)).toBe(6);
  });

  test("A change is a new version with its reason and who", async ({ ctx, api }) => {
    const before = await versionsOf(ctx, "liked_you_cap");
    expect(before.map((r) => r.version)).toEqual([1]);
    const admin = await staffSession(ctx.client, "admin");

    const response = await change(api, admin.headers, "liked_you_cap", {
      value: 25,
      reason: "Smaller ponds first",
    });
    expect(response.status).toBe(200);
    const answer = ConfigChange.parse(await response.json());
    expect(answer).toMatchObject({
      key: "liked_you_cap",
      value: 25,
      version: 2,
      createdBy: admin.identityId,
      reason: "Smaller ponds first",
    });

    const after = await versionsOf(ctx, "liked_you_cap");
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    const written = after[1];
    expect(written).toMatchObject({
      version: 2,
      value: 25,
      created_by: admin.identityId,
      reason: "Smaller ponds first",
    });
    expect(written?.valid_from.toISOString()).toBe(T.toISOString());
    // Every reader takes it from here on.
    expect(await matchingConfigNumber(ctx.client, "liked_you_cap")).toBe(25);

    expect(await configAudit(ctx)).toEqual([
      {
        actor_identity_id: admin.identityId,
        action: "config.change",
        subject_type: "config",
        subject_id: written?.id,
        detail: { key: "liked_you_cap", version: 2 },
      },
    ]);
  });

  test("A change keeps the value's shape", async ({ ctx, api }) => {
    const before = await versionsOf(ctx, "photo_fetches_per_day");
    expect(before.at(-1)?.value).toEqual({ thumb: 600, card: 300, full: 60 });
    const admin = await staffSession(ctx.client, "admin");
    for (const value of [600, { thumb: 600, card: 300 }]) {
      const response = await change(api, admin.headers, "photo_fetches_per_day", {
        value,
        reason: "Fewer full photos a day",
      });
      expect(response.status, JSON.stringify(value)).toBe(400);
      expect(await errorCode(response)).toBe("config_shape");
    }
    expect(await versionsOf(ctx, "photo_fetches_per_day")).toEqual(before);
    expect(await configAudit(ctx)).toEqual([]);
  });
});

describe("sameShape", () => {
  test.for([
    ["a number for a number", 30, 25, true],
    ["a fraction for a whole number", 30, 0.5, false],
    ["a negative for a whole number from 0", 30, -1, false],
    ["0 for a whole number from 0", 30, 0, true],
    ["the largest int4 for a whole number", 30, 2_147_483_647, true],
    ["one past int4 for a whole number", 30, 2_147_483_648, false],
    ["3e9 for a whole number", 30, 3e9, false],
    ["a whole number for a fraction", 0.6, 1, true],
    ["a fraction for a fraction", 0.6, 0.55, true],
    ["a negative for a fraction from 0", 0.6, -0.1, false],
    ["a negative for a negative", -1, -2.5, true],
    ["a string for a number", 30, "30", false],
    ["a string for a string", "suomi", "paakaupunkiseutu", true],
    ["a number for a string", "suomi", 1, false],
    ["a boolean for a boolean", true, false, true],
    ["a string for a boolean", true, "true", false],
    ["null for null", null, null, true],
    ["a number for null", null, 0, false],
    ["null for a number", 0, null, false],
    ["null for an object", { thumb: 600 }, null, false],
    ["an array for an array", [1], [2, 3], true],
    ["an object for an array", [1], { 0: 1 }, false],
    ["an array for an object", {}, [], false],
    [
      "the same keys in another order",
      { thumb: 600, card: 300, full: 60 },
      { full: 1, card: 2, thumb: 3 },
      true,
    ],
    [
      "an object without one of the keys",
      { thumb: 600, card: 300, full: 60 },
      { thumb: 600, card: 300 },
      false,
    ],
    [
      "an object with a key more",
      { thumb: 600, card: 300 },
      { thumb: 600, card: 300, full: 60 },
      false,
    ],
    [
      "as many keys, one of them another",
      { thumb: 600, card: 300 },
      { thumb: 600, full: 300 },
      false,
    ],
    [
      "a string under a number's key",
      { thumb: 600, card: 300 },
      { thumb: 600, card: "300" },
      false,
    ],
    ["null under a number's key", { thumb: 600 }, { thumb: null }, false],
    ["an array under an object's key", { a: { x: 1 } }, { a: [1] }, false],
    [
      "a nested object with other keys, held as the declaration is",
      { a: { x: 1 } },
      { a: { y: "z" } },
      false,
    ],
    [
      "a fraction under a whole number's key",
      { thumb: 600, card: 300, full: 60 },
      { thumb: 600.5, card: 300, full: 60 },
      false,
    ],
    [
      "a negative under a whole number's key",
      { thumb: 600, card: 300, full: 60 },
      { thumb: 600, card: -1, full: 60 },
      false,
    ],
    ["an empty object for an empty object", {}, {}, true],
  ] as const)("%s: %j then %j is %s", ([, declared, next, expected]) => {
    expect(sameShape(declared, next)).toBe(expected);
  });
});

describe("changeConfig against the key's declaration", () => {
  test("a count refuses a fraction, a negative and more than int4 holds, and writes nothing", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    for (const value of [5.5, -1, 3e9]) {
      await expect(
        changeConfig(ctx.client, {
          key: "feedback_per_day",
          value,
          reason: "A typo",
          actor: admin.identityId,
          at: T,
        }),
      ).rejects.toMatchObject({ status: 400, code: "config_shape" });
    }
    expect((await versionsOf(ctx, "feedback_per_day")).map((r) => r.version)).toEqual([1]);
    expect(await configAudit(ctx)).toEqual([]);
  });

  test("a fraction key set to a whole number can go back to a fraction", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const change = (value: number) =>
      changeConfig(ctx.client, {
        key: "contest_ratio_threshold",
        value,
        reason: "Trying it out",
        actor: admin.identityId,
        at: T,
      });
    expect((await change(1)).version).toBe(2);
    expect((await change(0.55)).version).toBe(3);
  });
});

describe("listConfig", () => {
  test("lists every key once, in the database's order of keys, held to the contract", async ({
    ctx,
  }) => {
    const items = await listConfig(ctx.client);
    const { rows } = await ctx.client.query<{ key: string }>(
      "SELECT DISTINCT key FROM matching_config ORDER BY key",
    );
    expect(items.map((i) => i.key)).toEqual(rows.map((r) => r.key));
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items.length).toBeGreaterThan(40);
    expect(ConfigList.parse({ items })).toEqual({ items });
  });

  test("gives each key its latest value and version, and its versions newest first", async ({
    ctx,
  }) => {
    const pond = (await listConfig(ctx.client)).find((i) => i.key === "default_pond");
    expect(pond).toMatchObject({ key: "default_pond", value: "paakaupunkiseutu", version: 2 });
    expect(pond?.versions.map((v) => [v.version, v.value, v.createdBy])).toEqual([
      [2, "paakaupunkiseutu", "migration:0025"],
      [1, "suomi", "migration:0020"],
    ]);

    const from = new Date("2026-10-15T06:30:00Z");
    await ctx.client.query(
      `INSERT INTO matching_config (version, key, value, valid_from, created_by, reason)
       VALUES (3, 'default_pond', '"suomi"'::jsonb, $1, 'someone', 'Back to one pond')`,
      [from],
    );
    const again = (await listConfig(ctx.client)).find((i) => i.key === "default_pond");
    expect(again).toMatchObject({ value: "suomi", version: 3 });
    expect(again?.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(again?.versions[0]).toEqual({
      version: 3,
      value: "suomi",
      validFrom: from.toISOString(),
      createdBy: "someone",
      reason: "Back to one pond",
    });
    const single = (await listConfig(ctx.client)).find((i) => i.key === "liked_you_cap");
    expect(single).toMatchObject({ value: 10, version: 1 });
    expect(single?.versions).toHaveLength(1);
    const budget = (await listConfig(ctx.client)).find((i) => i.key === "photo_fetches_per_day");
    expect(budget?.value).toEqual({ thumb: 600, card: 300, full: 60 });
  });

  test("a version the seed or a migration wrote has no reason", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { config_test_seeded: 7 });
    const items = await listConfig(ctx.client);
    const versions = items.flatMap((i) => i.versions);
    const written = versions.filter((v) => v.createdBy.startsWith("migration:"));
    expect(written.length).toBeGreaterThan(40);
    expect(written.every((v) => v.reason === null)).toBe(true);
    expect(items.find((i) => i.key === "config_test_seeded")?.versions).toEqual([
      expect.objectContaining({ version: 1, value: 7, createdBy: "test", reason: null }),
    ]);
  });
});

/**
 * The test's transaction with another request's work slipped in once, just
 * after the first statement matching the pattern, as if a concurrent request
 * had committed at that moment (identity/races.test.ts). `ran` says whether
 * the moment came, so a test cannot pass by missing it.
 */
function interleaved(
  db: Queryable,
  after: RegExp,
  other: () => Promise<unknown>,
): Queryable & { ran: () => boolean } {
  let ran = false;
  return {
    ran: () => ran,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = await db.query<R>(text, values);
      if (!ran && after.test(text)) {
        ran = true;
        await other();
      }
      return result;
    },
  };
}

/** changeConfig's read of the key's latest version, before its transaction. */
const LATEST_READ = /FROM matching_config WHERE key = \$1 ORDER BY version DESC LIMIT 1/;

describe("changeConfig", () => {
  test("refuses a key no migration made with 404, and writes nothing", async ({ ctx }) => {
    const admin = await staffSession(ctx.client, "admin");
    const attempt = changeConfig(ctx.client, {
      key: "no_such_tunable",
      value: 1,
      reason: "Trying",
      actor: admin.identityId,
      at: T,
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await versionsOf(ctx, "no_such_tunable")).toEqual([]);
    expect(await configAudit(ctx)).toEqual([]);
  });

  test.for([
    ["a string for liked_you_cap's number", "liked_you_cap", "25", "number"],
    ["a number for default_pond's string", "default_pond", 1, "string"],
    ["a boolean for liked_you_cap's number", "liked_you_cap", true, "number"],
    ["a number for the budget's object", "photo_fetches_per_day", 600, "object"],
    ["the budget without full", "photo_fetches_per_day", { thumb: 600, card: 300 }, "object"],
    [
      "the budget with a string under full",
      "photo_fetches_per_day",
      { thumb: 600, card: 300, full: "60" },
      "object",
    ],
    ["a number for a boolean", "config_test_flag", 1, "boolean"],
  ] as const)(
    "refuses %s with config_shape, expecting %s, and writes nothing",
    async ([, key, value, expected], { ctx }) => {
      await withMatchingConfig(ctx.client, { config_test_flag: true });
      const admin = await staffSession(ctx.client, "admin");
      const before = await versionsOf(ctx, key);
      const attempt = changeConfig(ctx.client, {
        key,
        value,
        reason: "A new shape",
        actor: admin.identityId,
        at: T,
      });
      await expect(attempt).rejects.toBeInstanceOf(AppError);
      await expect(attempt).rejects.toMatchObject({
        status: 400,
        code: "config_shape",
        detail: { key, expected },
      });
      expect(await versionsOf(ctx, key)).toEqual(before);
      expect(await configAudit(ctx)).toEqual([]);
    },
  );

  test("writes the next version with the admin as its author, the given time and the reason, after its audit row", async ({
    ctx,
  }) => {
    const admin = await staffSession(ctx.client, "admin");
    const at = new Date("2026-10-16T10:15:30.123Z");
    const answer = await changeConfig(ctx.client, {
      key: "liked_you_cap",
      value: 8,
      reason: "Fewer at a time while we watch",
      actor: admin.identityId,
      at,
    });
    // The answer is the row this change wrote (ConfigChange); the list has the history.
    expect(ConfigChange.parse(answer)).toEqual({
      key: "liked_you_cap",
      version: 2,
      value: 8,
      validFrom: at.toISOString(),
      createdBy: admin.identityId,
      reason: "Fewer at a time while we watch",
    });
    const listed = (await listConfig(ctx.client)).find((k) => k.key === "liked_you_cap");
    expect(listed).toMatchObject({ value: 8, version: 2 });
    expect(listed?.versions).toEqual([
      {
        version: 2,
        value: 8,
        validFrom: at.toISOString(),
        createdBy: admin.identityId,
        reason: "Fewer at a time while we watch",
      },
      {
        version: 1,
        value: 10,
        validFrom: expect.any(String),
        createdBy: "migration:0007",
        reason: null,
      },
    ]);

    const rows = await versionsOf(ctx, "liked_you_cap");
    const written = rows[1];
    expect(written).toMatchObject({
      version: 2,
      value: 8,
      created_by: admin.identityId,
      reason: "Fewer at a time while we watch",
    });
    expect(written?.valid_from.toISOString()).toBe(at.toISOString());
    expect(await configAudit(ctx)).toEqual([
      {
        actor_identity_id: admin.identityId,
        action: "config.change",
        subject_type: "config",
        subject_id: written?.id,
        detail: { key: "liked_you_cap", version: 2 },
      },
    ]);
  });

  test("two changes one after the other are versions 2 and 3, each with its audit row", async ({
    ctx,
  }) => {
    const first = await staffSession(ctx.client, "admin");
    const second = await staffSession(ctx.client, "admin");
    const one = await changeConfig(ctx.client, {
      key: "like_expiry_days",
      value: 10,
      reason: "Shorter",
      actor: first.identityId,
      at: T,
    });
    const two = await changeConfig(ctx.client, {
      key: "like_expiry_days",
      value: 12,
      reason: "Not that short",
      actor: second.identityId,
      at: new Date(T.getTime() + 60_000),
    });
    expect([one.version, two.version]).toEqual([2, 3]);
    const listed = (await listConfig(ctx.client)).find((k) => k.key === "like_expiry_days");
    expect(listed?.versions.map((v) => [v.version, v.value, v.createdBy])).toEqual([
      [3, 12, second.identityId],
      [2, 10, first.identityId],
      [1, 14, "migration:0007"],
    ]);
    const rows = await versionsOf(ctx, "like_expiry_days");
    expect(
      (await configAudit(ctx)).map((a) => [a.actor_identity_id, a.subject_id, a.detail]),
    ).toEqual([
      [first.identityId, rows[1]?.id, { key: "like_expiry_days", version: 2 }],
      [second.identityId, rows[2]?.id, { key: "like_expiry_days", version: 3 }],
    ]);
  });

  test("of two changes at once one writes its version and audit row, and the other is config_conflict with nothing written", async ({
    ctx,
  }) => {
    const first = await staffSession(ctx.client, "admin");
    const second = await staffSession(ctx.client, "admin");
    let theOther: ConfigChange | undefined;
    // The second admin's change commits after the first has read version 1
    // and before it writes: both want version 2.
    const db = interleaved(ctx.client, LATEST_READ, async () => {
      theOther = await changeConfig(ctx.client, {
        key: "shown_cooldown_days",
        value: 21,
        reason: "Three weeks",
        actor: second.identityId,
        at: T,
      });
    });
    const attempt = changeConfig(db, {
      key: "shown_cooldown_days",
      value: 20,
      reason: "Twenty days",
      actor: first.identityId,
      at: T,
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: "config_conflict" });
    expect(db.ran()).toBe(true);
    expect(theOther?.version).toBe(2);

    const rows = await versionsOf(ctx, "shown_cooldown_days");
    expect(rows.map((r) => [r.version, r.value, r.created_by, r.reason])).toEqual([
      [1, 30, "migration:0007", null],
      [2, 21, second.identityId, "Three weeks"],
    ]);
    expect(await configAudit(ctx)).toEqual([
      {
        actor_identity_id: second.identityId,
        action: "config.change",
        subject_type: "config",
        subject_id: rows[1]?.id,
        detail: { key: "shown_cooldown_days", version: 2 },
      },
    ]);
  });
});
