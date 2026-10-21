import type { Queryable } from "@kuutti/db";
import { ConversationList, ErrorResponse, FoundThemStatus } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signedInAccount } from "../test/account.ts";
import {
  captureLogger,
  describe,
  englishT,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { eraseAccount, exportAccount } from "./erasure.ts";
import { foundThemAnswered, foundThemCounts, tellFoundThem } from "./found-them.ts";

// "Löysin hänet" (#83, ADR-040, features/identity/found-them.feature): the
// answer counted once per account by Finnish day and reason in a count that
// names nobody; nothing else changing; a second answer refused; the count
// outliving the person; the research event; the routes' edges; the export;
// two devices at once.

/** 12:00 in Finland, one Tuesday. */
const T = new Date("2026-10-20T09:00:00.000Z");
const DAY = finnishDay(T);

async function appAt(db: Queryable, at: Date = T): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => at });
}

const tell = (app: App, headers: Record<string, string>, body: unknown) =>
  app.request("/account/found-them", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function answered(app: App, headers: Record<string, string>): Promise<boolean> {
  const response = await app.request("/account/found-them", { headers });
  expect(response.status).toBe(200);
  return FoundThemStatus.parse(await response.json()).answered;
}

async function counts(ctx: TestContext) {
  return (
    await ctx.client.query<{ day: string; reason: string; count: number }>(
      "SELECT day::text AS day, reason, count FROM found_them_count ORDER BY reason",
    )
  ).rows;
}

async function codeOf(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

describe("Löysin hänet", () => {
  test("Telling Kuutti you found someone counts once, by reason, with no name in the count", async ({
    ctx,
  }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-a");
    expect(await answered(app, a.headers)).toBe(false);

    expect((await tell(app, a.headers, { reason: "here" })).status).toBe(204);

    expect(await counts(ctx)).toEqual([{ day: DAY, reason: "here", count: 1 }]);
    expect(await answered(app, a.headers)).toBe(true);
    // The count's columns are the row's own random key, a day, a reason and a
    // number: nothing that names anybody, and no key to anybody's row.
    const { rows } = await ctx.client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'found_them_count' ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(["count", "day", "id", "reason"]);
    const { rows: keys } = await ctx.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints
        WHERE table_name = 'found_them_count' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(keys[0]?.n).toBe(0);
  });

  describe("Each reason is counted on its own", () => {
    test.for([
      { a: "here", b: "here", here: 2, elsewhere: 0, other: 0 },
      { a: "here", b: "elsewhere", here: 1, elsewhere: 1, other: 0 },
      { a: "other", b: "elsewhere", here: 0, elsewhere: 1, other: 1 },
    ])(
      "$a and $b: $here, $elsewhere, $other",
      async ({ a, b, here, elsewhere, other }, { ctx }) => {
        const app = await appAt(ctx.client);
        const first = await signedInAccount(ctx.client, `found-${a}-${b}-1`);
        const second = await signedInAccount(ctx.client, `found-${a}-${b}-2`);
        expect((await tell(app, first.headers, { reason: a })).status).toBe(204);
        expect((await tell(app, second.headers, { reason: b })).status).toBe(204);
        expect(await foundThemCounts(ctx.client)).toEqual({ here, elsewhere, other });
      },
    );
  });

  test("Nothing else changes for the person", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-unchanged-a");
    const b = await signedInAccount(ctx.client, "found-unchanged-b");
    const { rows: opened } = await ctx.client.query<{ id: string }>(
      "INSERT INTO conversation DEFAULT VALUES RETURNING id",
    );
    await ctx.client.query(
      `INSERT INTO conversation_participant (conversation_id, account_id, side)
       VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
      [opened[0]?.id, a.accountId, b.accountId],
    );
    const before = await ctx.client.query(
      "SELECT state, paused_from, state_changed_at FROM account WHERE id = $1",
      [a.accountId],
    );
    // What "B" reads of the conversation, through the route "B"'s phone asks (nothing signed).
    const viewOfB = async () => {
      const response = await app.request("/conversations?thumbs=false", { headers: b.headers });
      expect(response.status).toBe(200);
      return ConversationList.parse(await response.json());
    };
    const seenByB = await viewOfB();
    expect(seenByB.open.map((c) => [c.id, c.counterpart?.deleted])).toEqual([
      [opened[0]?.id, false],
    ]);

    expect((await tell(app, a.headers, { reason: "elsewhere" })).status).toBe(204);

    const after = await ctx.client.query(
      "SELECT state, paused_from, state_changed_at FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.state).toBe("active");
    // Still signed in, and the conversation is open for both, as it was.
    expect((await app.request("/auth/session", { headers: a.headers })).status).toBe(200);
    const { rows: sessions } = await ctx.client.query(
      "SELECT 1 FROM session WHERE account_id = $1 AND revoked_at IS NULL",
      [a.accountId],
    );
    expect(sessions).toHaveLength(1);
    const { rows: conversation } = await ctx.client.query(
      "SELECT closed_at, archived_at FROM conversation WHERE id = $1",
      [opened[0]?.id],
    );
    expect(conversation).toEqual([{ closed_at: null, archived_at: null }]);
    // "A" is still in "B"'s view, exactly as before.
    expect(await viewOfB()).toEqual(seenByB);
  });

  test("A second answer is refused, and counts nothing", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-twice");
    expect((await tell(app, a.headers, { reason: "here" })).status).toBe(204);

    const again = await tell(app, a.headers, { reason: "other" });

    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("found_them_answered");
    expect(await counts(ctx)).toEqual([{ day: DAY, reason: "here", count: 1 }]);
  });

  test("the refusal is said in the request's language", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-twice-fi");
    await tell(app, a.headers, { reason: "here" });
    const again = await app.request("/account/found-them", {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json", "accept-language": "fi" },
      body: JSON.stringify({ reason: "here" }),
    });
    expect(again.status).toBe(409);
    expect(ErrorResponse.parse(await again.json()).error.message).toBe(
      "Kerroit jo meille. Kiitos.",
    );
  });

  test("The count outlives the person, the account's answer does not", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-erased");
    await tell(app, a.headers, { reason: "here" });
    const { logger } = await captureLogger();

    await eraseAccount({ db: ctx.client, logger, now: () => T }, a.accountId);

    expect(await counts(ctx)).toEqual([{ day: DAY, reason: "here", count: 1 }]);
    const { rows } = await ctx.client.query(
      "SELECT state, found_them_answered FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows).toEqual([{ state: "deleted", found_them_answered: false }]);
  });

  test("The research event carries the reason alone", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-study");
    await ctx.client.query(
      "INSERT INTO research_subject (account_id, consent_version) VALUES ($1, 'v1')",
      [a.accountId],
    );

    await tell(app, a.headers, { reason: "elsewhere" });

    const { rows } = await ctx.client.query<{ name: string; props: Record<string, unknown> }>(
      `SELECT e.name, e.props FROM events e
         JOIN research_subject s ON s.research_id = e.research_id
        WHERE s.account_id = $1`,
      [a.accountId],
    );
    expect(rows).toEqual([{ name: "found_them", props: { reason: "elsewhere" } }]);
  });

  test("an answer on the next Finnish day is counted on that day", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client, "found-day-a");
    const b = await signedInAccount(ctx.client, "found-day-b");
    await tell(await appAt(ctx.client), a.headers, { reason: "here" });
    // 00:30 in Helsinki the next day.
    const next = new Date("2026-10-20T21:30:00.000Z");
    await tell(await appAt(ctx.client, next), b.headers, { reason: "here" });
    expect(await counts(ctx)).toEqual([
      { day: "2026-10-20", reason: "here", count: 1 },
      { day: "2026-10-21", reason: "here", count: 1 },
    ]);
    // A window of one day, the 21st, holds the second answer alone.
    expect(await foundThemCounts(ctx.client, { today: "2026-10-21", days: 1 })).toEqual({
      here: 1,
      elsewhere: 0,
      other: 0,
    });
  });

  test("the export says that the person answered, never which reason", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-export");
    const { logger } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => T, version: "0.0.0-test" };
    expect(
      (await exportAccount(deps, a.accountId, englishT)).document.account.foundThemAnswered,
    ).toBe(false);
    await tell(app, a.headers, { reason: "here" });
    const { document } = await exportAccount(deps, a.accountId, englishT);
    expect(document.account.foundThemAnswered).toBe(true);
    expect(JSON.stringify(document)).not.toContain('"here"');
  });
});

describe("the routes' edges", () => {
  test("a reason outside the list, a missing one and a stray key are refused, and nothing is counted", async ({
    ctx,
  }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-invalid");
    for (const body of [{ reason: "somewhere" }, {}, { reason: "here", partner: "B" }, "here"]) {
      const response = await tell(app, a.headers, body);
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe("validation_failed");
    }
    expect(await counts(ctx)).toEqual([]);
    expect(await answered(app, a.headers)).toBe(false);
  });

  test("both routes refuse without a session", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    expect((await app.request("/account/found-them")).status).toBe(401);
    expect((await tell(app, {}, { reason: "here" })).status).toBe(401);
    expect(await counts(ctx)).toEqual([]);
  });

  test("an account erased since the session was checked is not found, and nothing is counted", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client, "found-gone");
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    const { logger } = await captureLogger();
    await expect(
      tellFoundThem({ db: ctx.client, logger, now: () => T }, a.accountId, "here"),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await counts(ctx)).toEqual([]);
    // The read behind GET /account/found-them is not found either.
    await expect(foundThemAnswered(ctx.client, a.accountId)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  test("each person reads and answers only for themselves", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    const a = await signedInAccount(ctx.client, "found-own-a");
    const b = await signedInAccount(ctx.client, "found-own-b");
    await tell(app, a.headers, { reason: "here" });
    expect(await answered(app, a.headers)).toBe(true);
    expect(await answered(app, b.headers)).toBe(false);
    expect((await tell(app, b.headers, { reason: "other" })).status).toBe(204);
  });
});

describe("two devices at once", () => {
  test("two answers at the same moment count one, and the second is refused", async () => {
    await withTwoConnections("kuutti-83-found", async (pool, first, second) => {
      const a = await signedInAccount(pool, "found-race");
      const { logger } = await captureLogger();
      const deps = { logger, now: () => T };
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      await tellFoundThem({ ...deps, db: first }, a.accountId, "here");
      const racing = watched(tellFoundThem({ ...deps, db: second }, a.accountId, "elsewhere"));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("found_them_answered");
      await second.query("COMMIT");
      const { rows } = await pool.query("SELECT reason, count FROM found_them_count");
      expect(rows).toEqual([{ reason: "here", count: 1 }]);
    });
  });
});
