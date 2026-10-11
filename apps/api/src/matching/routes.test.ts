import type { Queryable } from "@kuutti/db";
import { DealBreakersResponse, PreferencesResponse } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { pondNamed } from "../test/people.ts";
import {
  deletePreferencesOfAccount,
  deleteSeeksOfAccount,
  nextChangeFrom,
  readPreferences,
} from "./preferences.ts";

// The preference routes' remaining branches (#46, #147, #149): every way the
// guard refuses, a save that meets an erasure, rows that no longer parse,
// the cadence once it has passed, and what a change of seeks does at the pond
// gate. The hard rows are rule 7's: what is stored here is what the round
// builder never crosses, in either direction.

type Headers = Record<string, string>;
const json = (headers: Headers) => ({ ...headers, "content-type": "application/json" });
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

/** An app on the test's transaction, optionally through a database that does something first. */
async function appWith(ctx: TestContext, db?: Queryable) {
  const { logger, lines } = await captureLogger();
  return { app: createApp({ config: testConfig(), logger, db: db ?? ctx.client }), logs: lines };
}

/**
 * The test's transaction, except that the account is erased the moment the
 * statement matching `when` is about to run: the erasure that commits after
 * the guard let the request in.
 */
function erasedBefore(ctx: TestContext, accountId: string, when: RegExp): Queryable {
  let erased = false;
  return {
    async query(text: string, values?: unknown[]) {
      if (!erased && when.test(text)) {
        erased = true;
        await ctx.client.query(
          "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
          [accountId],
        );
      }
      return ctx.client.query(text, values);
    },
  } as Queryable;
}

async function refusedCallers(ctx: TestContext) {
  const ended = await signedInAccount(ctx.client);
  await ctx.client.query("UPDATE session SET revoked_at = now() WHERE id = $1", [ended.sessionId]);
  const expired = await signedInAccount(ctx.client);
  await ctx.client.query(
    "UPDATE session SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
    [expired.sessionId],
  );
  const erased = await signedInAccount(ctx.client);
  await ctx.client.query("UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1", [
    erased.accountId,
  ]);
  return [
    ["no token", {}, "unauthenticated"],
    ["a token nobody issued", { authorization: `Bearer ${"C".repeat(43)}` }, "unauthenticated"],
    ["an ended session", ended.headers, "session_revoked"],
    ["the session of an erased account", erased.headers, "session_revoked"],
    ["an expired access token", expired.headers, "session_expired"],
  ] as const;
}

async function rowsOf(ctx: TestContext, accountId: string) {
  const { rows } = await ctx.client.query<{ field: string; value: unknown }>(
    "SELECT field, value FROM preferences WHERE account_id = $1 ORDER BY field",
    [accountId],
  );
  return rows;
}

describe("the preference routes' guard", () => {
  test("every refused caller gets its own code on all four routes, and nothing is written", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    for (const [what, headers, code] of await refusedCallers(ctx)) {
      for (const res of [
        await app.request("/preferences", { headers }),
        await app.request("/preferences", {
          method: "PUT",
          headers: json(headers),
          body: JSON.stringify({ seeks: ["woman"] }),
        }),
        await app.request("/preferences/deal-breakers", { headers }),
        await app.request("/preferences/deal-breakers", {
          method: "PUT",
          headers: json(headers),
          body: JSON.stringify({ dealBreakers: [] }),
        }),
      ]) {
        expect(res.status, what).toBe(401);
        expect(await errorCode(res), what).toBe(code);
      }
    }
    const { rows } = await ctx.client.query("SELECT count(*) AS n FROM preferences");
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe("a save that meets an erasure", () => {
  test("PUT /preferences for an account erased after the guard is a 404 and writes no row", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    const { app, logs } = await appWith(
      ctx,
      erasedBefore(ctx, me.accountId, /^SELECT gender, seeks_changed_at FROM account/),
    );
    const res = await app.request("/preferences", {
      method: "PUT",
      headers: json(me.headers),
      body: JSON.stringify({ seeks: ["woman"], ageWindow: { min: 25, max: 35 } }),
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(await rowsOf(ctx, me.accountId)).toEqual([]);
    expect(logs().some((l) => l.msg === "preferences saved")).toBe(false);
  });

  test("PUT /preferences/deal-breakers for an account erased after the guard is a 404 and writes no row", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
       VALUES ($1, 'Aino', null, '{"smoking": "never"}'::jsonb, '[]'::jsonb)`,
      [me.accountId],
    );
    const { app, logs } = await appWith(
      ctx,
      erasedBefore(
        ctx,
        me.accountId,
        /^SELECT 1 FROM account WHERE id = \$1 AND state <> 'deleted' FOR UPDATE/,
      ),
    );
    const res = await app.request("/preferences/deal-breakers", {
      method: "PUT",
      headers: json(me.headers),
      body: JSON.stringify({
        dealBreakers: [{ field: "smoking", accept: ["never"], includeUnknown: false }],
      }),
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(await rowsOf(ctx, me.accountId)).toEqual([]);
    expect(logs().some((l) => l.msg === "deal-breakers saved")).toBe(false);
  });
});

describe("validation of the deal-breakers body", () => {
  test.for([
    ["no list", {}],
    ["a list that is no list", { dealBreakers: "smoking" }],
    [
      "an entry without includeUnknown",
      { dealBreakers: [{ field: "smoking", accept: ["never"] }] },
    ],
    [
      "an entry accepting nothing",
      { dealBreakers: [{ field: "smoking", accept: [], includeUnknown: false }] },
    ],
  ] as const)("%s is refused as validation_failed", async ([, body], { ctx }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const res = await app.request("/preferences/deal-breakers", {
      method: "PUT",
      headers: json(me.headers),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_failed");
    expect(await rowsOf(ctx, me.accountId)).toEqual([]);
  });

  test("an empty set removes every deal-breaker and leaves onboarding's rows", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'seeks', '["woman"]', 'hard', false), ($1, 'smoking', '["never"]', 'hard', false)`,
      [me.accountId],
    );
    const res = await app.request("/preferences/deal-breakers", {
      method: "PUT",
      headers: json(me.headers),
      body: JSON.stringify({ dealBreakers: [] }),
    });
    expect(res.status).toBe(200);
    expect(DealBreakersResponse.parse(await res.json())).toEqual({ dealBreakers: [], max: 2 });
    expect((await rowsOf(ctx, me.accountId)).map((r) => r.field)).toEqual(["seeks"]);
  });
});

describe("rows that no longer parse", () => {
  test("a stored seek or window the contract no longer accepts reads as unset", async ({ ctx }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'seeks', '["robot"]', 'hard', false),
              ($1, 'age_window', '{"min": 40, "max": 30}', 'hard', false)`,
      [me.accountId],
    );
    const res = await app.request("/preferences", { headers: me.headers });
    expect(PreferencesResponse.parse(await res.json())).toEqual({ seeks: null, ageWindow: null });
  });

  test("a deal-breaker row whose value is not a list of answers reads as none", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'smoking', '"never"', 'hard', false), ($1, 'hasKids', '["no"]', 'hard', true)`,
      [me.accountId],
    );
    const res = await app.request("/preferences/deal-breakers", { headers: me.headers });
    expect(DealBreakersResponse.parse(await res.json())).toEqual({
      dealBreakers: [{ field: "hasKids", accept: ["no"], includeUnknown: true, paused: true }],
      max: 2,
    });
  });
});

describe("the cadence of a change, once it has passed", () => {
  test("a change of whom one seeks after the cadence is allowed and starts the cadence again", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    const put = (seeks: string[]) =>
      app.request("/preferences", {
        method: "PUT",
        headers: json(me.headers),
        body: JSON.stringify({ seeks }),
      });
    expect((await put(["woman"])).status).toBe(200);
    // The last change was 31 days ago; the cadence is 30 (matching_config).
    await ctx.client.query(
      "UPDATE account SET seeks_changed_at = now() - interval '31 days' WHERE id = $1",
      [me.accountId],
    );
    const before = Date.now();
    expect((await put(["man"])).status).toBe(200);
    const { rows } = await ctx.client.query<{ seeks_changed_at: Date }>(
      "SELECT seeks_changed_at FROM account WHERE id = $1",
      [me.accountId],
    );
    expect(rows[0]?.seeks_changed_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await put(["non_binary"])).status).toBe(429);
  });

  test("nextChangeFrom: nothing on record, a change inside the cadence, and one past it", () => {
    const at = new Date("2026-10-11T12:00:00Z");
    expect(nextChangeFrom(null, 30, at)).toBeNull();
    expect(nextChangeFrom(new Date("2026-10-01T12:00:00Z"), 30, at)).toEqual(
      new Date("2026-10-31T12:00:00Z"),
    );
    expect(nextChangeFrom(new Date("2026-09-11T12:00:00Z"), 30, at)).toBeNull();
    expect(nextChangeFrom(new Date("2026-09-11T11:59:59Z"), 30, at)).toBeNull();
  });
});

describe("a change of seeks at the pond gate (ADR-015 §9)", () => {
  async function admitted(ctx: TestContext, accountId: string) {
    const pond = await pondNamed(ctx.client, `test-pref-${accountId.slice(0, 8)}`);
    await ctx.client.query("UPDATE account SET gender = 'man', pond_id = $2 WHERE id = $1", [
      accountId,
      pond,
    ]);
    await ctx.client.query(
      `INSERT INTO gate (account_id, pond_id, admitted_at, pool_said, counted_at)
       VALUES ($1, $2, now(), 20, now())`,
      [accountId, pond],
    );
  }
  const gateOf = async (ctx: TestContext, accountId: string) =>
    (
      await ctx.client.query<{ admitted: boolean; counted: boolean }>(
        "SELECT admitted_at IS NOT NULL AS admitted, counted_at IS NOT NULL AS counted FROM gate WHERE account_id = $1",
        [accountId],
      )
    ).rows[0];

  test("seeking another gender too is decided anew; seeking fewer keeps the place", async ({
    ctx,
  }) => {
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'seeks', '["woman", "non_binary"]', 'hard', false)`,
      [me.accountId],
    );
    await admitted(ctx, me.accountId);
    const put = (seeks: string[]) =>
      app.request("/preferences", {
        method: "PUT",
        headers: json(me.headers),
        body: JSON.stringify({ seeks }),
      });
    // Leaving a contest takes nothing back.
    expect((await put(["woman"])).status).toBe(200);
    expect(await gateOf(ctx, me.accountId)).toEqual({ admitted: true, counted: true });
    // Joining one (after the cadence) empties the row for the next count.
    await ctx.client.query(
      "UPDATE account SET seeks_changed_at = now() - interval '31 days' WHERE id = $1",
      [me.accountId],
    );
    expect((await put(["woman", "non_binary"])).status).toBe(200);
    expect(await gateOf(ctx, me.accountId)).toEqual({ admitted: false, counted: false });
  });

  test("withdrawing the seek answer takes the row and keeps the age window and the place at the gate", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    for (const id of [me.accountId, other.accountId]) {
      await ctx.client.query(
        `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
         VALUES ($1, 'seeks', '["woman"]', 'hard', false),
                ($1, 'age_window', '{"min": 25, "max": 35}', 'hard', false)`,
        [id],
      );
    }
    await admitted(ctx, me.accountId);
    expect(await deleteSeeksOfAccount(ctx.client, me.accountId)).toBe(true);
    expect(await readPreferences(ctx.client, me.accountId)).toEqual({
      seeks: null,
      ageWindow: { min: 25, max: 35 },
    });
    expect(await gateOf(ctx, me.accountId)).toEqual({ admitted: true, counted: true });
    expect((await readPreferences(ctx.client, other.accountId)).seeks).toEqual(["woman"]);
  });

  test("withdrawing the seek answer of an erased account changes nothing", async ({ ctx }) => {
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'seeks', '["woman"]', 'hard', false)`,
      [me.accountId],
    );
    await ctx.client.query(
      "UPDATE account SET state = 'deleted', deleted_at = now() WHERE id = $1",
      [me.accountId],
    );
    expect(await deleteSeeksOfAccount(ctx.client, me.accountId)).toBe(false);
    expect(await rowsOf(ctx, me.accountId)).toEqual([{ field: "seeks", value: ["woman"] }]);
  });
});

describe("erasure of the preferences", () => {
  test("every row of the account goes, deal-breakers included; another account's stay", async ({
    ctx,
  }) => {
    const me = await signedInAccount(ctx.client);
    const other = await signedInAccount(ctx.client);
    for (const id of [me.accountId, other.accountId]) {
      await ctx.client.query(
        `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
         VALUES ($1, 'seeks', '["woman"]', 'hard', false), ($1, 'smoking', '["never"]', 'hard', false)`,
        [id],
      );
    }
    expect(await deletePreferencesOfAccount(ctx.client, me.accountId)).toBe(2);
    expect(await rowsOf(ctx, me.accountId)).toEqual([]);
    expect(await rowsOf(ctx, other.accountId)).toHaveLength(2);
    expect(await deletePreferencesOfAccount(ctx.client, me.accountId)).toBe(0);
  });
});

describe("a deal-breaker on a field of many answers", () => {
  test("languages accepts the registry's options and refuses one it has not", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { deal_breakers_max: 2 });
    const { app } = await appWith(ctx);
    const me = await signedInAccount(ctx.client);
    await ctx.client.query(
      `INSERT INTO profile (account_id, display_name, bio, fields, prompts)
       VALUES ($1, 'Aino', null, '{"languages": ["fi", "sv"]}'::jsonb, '[]'::jsonb)`,
      [me.accountId],
    );
    const put = (accept: string[]) =>
      app.request("/preferences/deal-breakers", {
        method: "PUT",
        headers: json(me.headers),
        body: JSON.stringify({
          dealBreakers: [{ field: "languages", accept, includeUnknown: false }],
        }),
      });
    const refused = await put(["fi", "klingon"]);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("validation_failed");
    expect(await rowsOf(ctx, me.accountId)).toEqual([]);

    const saved = await put(["fi", "en"]);
    expect(saved.status).toBe(200);
    expect(DealBreakersResponse.parse(await saved.json()).dealBreakers).toEqual([
      { field: "languages", accept: ["fi", "en"], includeUnknown: false, paused: false },
    ]);
  });
});
