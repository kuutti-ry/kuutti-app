import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, migrate, type Queryable, withTemporaryDatabase } from "@kuutti/db";
import { PondCounterResponse } from "@kuutti/schema";
import { it } from "vitest";
import { withMatchingConfig } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { people, pondNamed } from "../test/people.ts";
import {
  countPonds,
  ensureFirstSnapshot,
  POND_COUNTER_LOCK_KEY,
  pondCounterJob,
  takeSnapshot,
} from "./pond-counter.ts";

// features/pond/counter.feature (#54, ADR-013): who is counted, and when the
// figures move.

const DAY_1 = new Date("2026-10-05T01:00:00Z"); // 04:00 in Helsinki
const LATER_ON_DAY_1 = new Date("2026-10-05T20:59:00Z"); // 23:59 in Helsinki
const DAY_2 = new Date("2026-10-06T01:00:00Z");
const DAY_3 = new Date("2026-10-07T01:00:00Z");

async function deps(ctx: TestContext, at: Date) {
  const { logger, lines } = await captureLogger();
  return { deps: { db: ctx.client, logger, now: () => at }, lines };
}

const taken = async (ctx: TestContext, at: Date) => takeSnapshot((await deps(ctx, at)).deps);

const inState = (ctx: TestContext, ids: readonly (string | undefined)[], state: string) =>
  ctx.client.query("UPDATE account SET state = $2::account_state WHERE id = ANY($1)", [ids, state]);

const bandsOf = async (ctx: TestContext, pond: string) => {
  const counts = (await countPonds(ctx.client)).get(pond);
  return [counts?.seeksMen, counts?.seeksEveryone, counts?.seeksWomen];
};

const listed = async (ctx: TestContext, pond: string) =>
  PondCounterResponse.parse(await (await ctx.app.request("/ponds/counter")).json()).ponds.find(
    (p) => p.pond.id === pond,
  );

describe("the figures", () => {
  test("Only live accounts with a pond are counted, a shadow-banned one like any other", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-counted");
    await people(ctx.client, pond, 9, { complete: true });
    await inState(ctx, await people(ctx.client, pond, 1, { complete: true }), "shadow_banned");
    for (const state of ["paused", "suspended", "deleted"] as const) {
      await inState(ctx, await people(ctx.client, pond, 1, { complete: true }), state);
    }
    await people(ctx.client, pond, 1, { complete: true, standing: "banned" });
    await people(ctx.client, null, 1, { complete: true });

    const ponds = await countPonds(ctx.client);
    expect(ponds.get(pond)).toEqual({
      finished: 10,
      seeksMen: 0,
      seeksEveryone: 0,
      seeksWomen: 0,
    });
    expect([...ponds.keys()]).not.toContain(null);
  });

  test("a complete profile on an account that is not active yet, or is banned, is not counted", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-not-active");
    await inState(ctx, await people(ctx.client, pond, 1, { complete: true }), "registered");
    await inState(ctx, await people(ctx.client, pond, 1, { complete: true }), "banned");
    await people(ctx.client, pond, 1, { complete: true });
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 1 });
  });

  test("a ready line in place of a bio completes the profile, and neither leaves it uncounted (#239)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-ready-line");
    await people(ctx.client, pond, 1, { complete: true, bio: "ready_line" });
    await people(ctx.client, pond, 1, { complete: true, bio: "none" });
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 1 });
  });

  test("photos sent in conversations finish no profile: one whose approved photos are all of messages is not counted (#350)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-message-photos");
    const [messagesOnly] = await people(ctx.client, pond, 2, { complete: true });
    // The same three approved photos, sent in conversations instead.
    await ctx.client.query(
      "UPDATE photo SET purpose = 'message', position = NULL WHERE account_id = $1",
      [messagesOnly],
    );
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 1 });
  });

  test("A profile that is not complete is not counted", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-not-complete");
    await people(ctx.client, pond, 10, { complete: true });
    // One thing short of complete on an active account, and those who have only begun.
    await people(ctx.client, pond, 9, { complete: true, bio: "none" });
    await people(ctx.client, pond, 3, { state: "active" });
    await people(ctx.client, pond, 3, { state: "registered" });
    await taken(ctx, DAY_1);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-05", finished: 10 });
  });

  test("The number of a pond moves only once at least k people have come or gone", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-steps");
    await people(ctx.client, pond, 25, { complete: true });
    expect((await taken(ctx, DAY_1)).day).toBe("2026-10-05");
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ day: "2026-10-05", finished: 25 });

    await people(ctx.client, pond, 9, { complete: true });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toEqual(said);

    await people(ctx.client, pond, 1, { complete: true });
    await taken(ctx, DAY_3);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-07", finished: 35 });
  });

  test("The accounts are counted at most once a day", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-once");
    await people(ctx.client, pond, 25, { complete: true });
    expect(await taken(ctx, DAY_1)).toMatchObject({ counted: true });
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ day: "2026-10-05", finished: 25 });

    await people(ctx.client, pond, 10, { complete: true });
    const again = await deps(ctx, LATER_ON_DAY_1);
    expect(await takeSnapshot(again.deps)).toEqual({
      day: "2026-10-05",
      ponds: 0,
      moved: 0,
      counted: false,
    });
    expect(await listed(ctx, pond)).toEqual(said);
    expect(again.lines().map((l) => l.msg)).toContain("pond counter: counted today already");

    expect(await taken(ctx, DAY_2)).toMatchObject({ counted: true });
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", finished: 35 });
  });

  test("a pond that did not move is marked as counted too, its figures and their day as they were", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-mark");
    await people(ctx.client, pond, 25, { complete: true });
    await taken(ctx, DAY_1);
    await people(ctx.client, pond, 3, { complete: true });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ day: string; finished: number; taken_at: Date }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, finished, taken_at
       FROM pond_counter WHERE pond_id = $1`,
      [pond],
    );
    expect(rows).toEqual([{ day: "2026-10-05", finished: 25, taken_at: DAY_2 }]);
  });

  test("The figures do not move between two counts", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-between");
    await people(ctx.client, pond, 11, { complete: true });
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said?.finished).toBe(11);

    await people(ctx.client, pond, 15, { complete: true });
    expect(await listed(ctx, pond)).toEqual(said);

    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", finished: 26 });
  });

  test("one arrival and one departure a day never show, however many days pass", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-quiet");
    const [first, second] = await people(ctx.client, pond, 10, { complete: true });
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said?.finished).toBe(10);

    // Somebody finishes: the number would have gone up by one.
    await people(ctx.client, pond, 1, { complete: true });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toEqual(said);

    // Two leave: it would be nine, under k, and it still stands as it was said.
    await inState(ctx, [first, second], "paused");
    await taken(ctx, DAY_3);
    expect(await listed(ctx, pond)).toEqual(said);
  });

  test("figures said under k = 10 stand while k is raised, and are said again unchanged when it returns", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-raised");
    await people(ctx.client, pond, 45, { complete: true });
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ day: "2026-10-05", finished: 45 });

    await withMatchingConfig(ctx.client, { pond_counter_k: 50 });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: null, finished: null });
    await people(ctx.client, pond, 1, { complete: true });
    await taken(ctx, DAY_3);

    await withMatchingConfig(ctx.client, { pond_counter_k: 10 });
    expect(await listed(ctx, pond)).toEqual(said);
  });

  test("a pond that was never said follows every count until it reaches k", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-growing");
    await people(ctx.client, pond, 4, { complete: true });
    await taken(ctx, DAY_1);
    expect(await listed(ctx, pond)).toMatchObject({ day: null, finished: null });
    await people(ctx.client, pond, 6, { complete: true });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", finished: 10 });
  });

  test("there is one row per pond, zeros included, and no history", async ({ ctx }) => {
    const chosen = await pondNamed(ctx.client, "test-counter-chosen");
    const empty = await pondNamed(ctx.client, "test-counter-empty");
    const begun = await pondNamed(ctx.client, "test-counter-begun");
    await people(ctx.client, chosen, 2, { complete: true });
    await people(ctx.client, begun, 12, { state: "active" });
    await taken(ctx, DAY_1);
    await people(ctx.client, chosen, 30, { complete: true });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ pond_id: string; finished: number; day: string }>(
      `SELECT pond_id, finished, to_char(day, 'YYYY-MM-DD') AS day
       FROM pond_counter WHERE pond_id = ANY($1)`,
      [[chosen, empty, begun]],
    );
    expect(rows).toHaveLength(3);
    expect(Object.fromEntries(rows.map((r) => [r.pond_id, [r.finished, r.day]]))).toEqual({
      [chosen]: [32, "2026-10-06"],
      [empty]: [0, "2026-10-05"],
      [begun]: [0, "2026-10-05"],
    });
  });

  test("the job logs how many ponds moved, and no figure of any pond", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-counter-log");
    await people(ctx.client, pond, 37, { complete: true });
    const { deps: d, lines } = await deps(ctx, DAY_1);
    const job = pondCounterJob(d);
    expect(job.name).toBe("pond-counter");
    const result = await job.run();
    expect(result.ponds).toBeGreaterThanOrEqual(1);
    expect(result.moved).toBeGreaterThanOrEqual(1);
    const logged = lines().filter((l) => l.msg === "pond counter");
    expect(logged).toHaveLength(1);
    const keys = Object.keys(logged[0] ?? {});
    expect(keys).toEqual(expect.arrayContaining(["day", "moved", "ponds"]));
    for (const figure of ["accounts", "finished", "seeksMen", "seeksEveryone", "seeksWomen"]) {
      expect(keys).not.toContain(figure);
    }
    expect(JSON.stringify(logged)).not.toContain(pond);
  });

  test("the first figures are taken only when there are none", async ({ ctx }) => {
    await ctx.client.query("DELETE FROM pond_counter");
    await pondNamed(ctx.client, "test-counter-first");
    const first = await ensureFirstSnapshot((await deps(ctx, DAY_1)).deps);
    expect(first?.day).toBe("2026-10-05");
    expect(await ensureFirstSnapshot((await deps(ctx, DAY_2)).deps)).toBeNull();
  });

  test("a row as the migration leaves it says no number, the boot does not count it, and the next count replaces it at once (#581)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-migrated");
    const finished = { complete: true, consented: true, seeks: ["man" as const] };
    await people(ctx.client, pond, 12, finished);
    await taken(ctx, DAY_1);
    // Migration 0109: the old figures gone, the bands as they stood, and the number at its default.
    await ctx.client.query("UPDATE pond_counter SET finished = 0 WHERE pond_id = $1", [pond]);
    expect(await listed(ctx, pond)).toMatchObject({ day: null, finished: null });

    expect(await ensureFirstSnapshot((await deps(ctx, DAY_2)).deps)).toBeNull();
    expect(await listed(ctx, pond)).toMatchObject({ day: null, finished: null });

    // Zero was never said, so no step holds the row back: one more in a band comes through with it.
    await people(ctx.client, pond, 1, finished);
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", finished: 13 });
    const { rows } = await ctx.client.query<{ seeks_men: number }>(
      "SELECT seeks_men FROM pond_counter WHERE pond_id = $1",
      [pond],
    );
    expect(rows).toEqual([{ seeks_men: 13 }]);
  });

  test("the count asks nobody's gender, and gender changes nothing in what it finds (#581)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-counter-no-gender");
    for (const gender of ["woman", "man", "non_binary", null] as const) {
      await people(ctx.client, pond, 1, { complete: true, consented: true, gender });
    }
    const asked: string[] = [];
    const watching = {
      query: (text: string, values?: unknown[]) => {
        asked.push(text);
        return ctx.client.query(text, values);
      },
    } as Queryable;
    expect((await countPonds(watching)).get(pond)).toEqual({
      finished: 4,
      seeksMen: 4,
      seeksEveryone: 0,
      seeksWomen: 0,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/gender/i);
  });
});

// Two containers overlap during a deploy. A pool and a database of its own:
// the counts must really run in parallel sessions, and nothing here may be
// seen by another test file.
describe("two counts at once", () => {
  it("wait for each other, so the second compares with what the first left", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 4, applicationName: "kuutti-counts" });
      try {
        await migrate(pool, resolve(import.meta.dirname, "../../../../packages/db/drizzle"));
        const { logger } = await captureLogger();
        const pond = await pondNamed(pool, "test-counter-parallel");
        await people(pool, pond, 45, { complete: true });
        await takeSnapshot({ db: pool, logger, now: () => DAY_1 });
        await people(pool, pond, 10, { complete: true });

        // The first count of the day, by hand: it holds the lock, has written
        // 55 and has marked every row as counted.
        const first = await pool.connect();
        let second: Promise<unknown>;
        try {
          await first.query("BEGIN");
          await first.query("SELECT pg_advisory_xact_lock($1)", [POND_COUNTER_LOCK_KEY]);
          await first.query("UPDATE pond_counter SET finished = 55, day = $2 WHERE pond_id = $1", [
            pond,
            "2026-10-06",
          ]);
          await first.query("UPDATE pond_counter SET taken_at = $1", [DAY_2]);
          second = takeSnapshot({ db: pool, logger, now: () => DAY_2 });
          const waited = await Promise.race([second.then(() => "ran"), sleep(300, "waited")]);
          expect(waited).toBe("waited");
          // Somebody finishes before the second count gets to look.
          await people(pool, pond, 1, { complete: true });
          await first.query("COMMIT");
        } finally {
          first.release();
        }
        // The day has had its count: the second process counts nothing.
        expect(await second).toMatchObject({ moved: 0, counted: false });
        const { rows } = await pool.query<{ finished: number }>(
          "SELECT finished FROM pond_counter WHERE pond_id = $1",
          [pond],
        );
        // Without the lock the second count would have seen neither the 55 nor
        // the mark, compared 56 with 45, and written 56.
        expect(rows).toEqual([{ finished: 55 }]);
      } finally {
        await pool.end();
      }
    });
  });
});

describe("the bands of the bar (#507)", () => {
  describe("Whom a finished profile seeks decides its band", () => {
    test.for([
      { seeks: ["man"], band: [1, 0, 0] },
      { seeks: ["woman"], band: [0, 0, 1] },
      { seeks: ["woman", "man"], band: [0, 1, 0] },
      { seeks: ["woman", "man", "non_binary"], band: [0, 1, 0] },
      { seeks: ["man", "non_binary"], band: [1, 0, 0] },
      { seeks: ["woman", "non_binary"], band: [0, 0, 1] },
      { seeks: ["non_binary"], band: [0, 0, 0] },
    ] as const)("$seeks: $band", async ({ seeks, band }, { ctx }) => {
      const pond = await pondNamed(ctx.client, `test-band-${seeks.join("-")}`);
      await people(ctx.client, pond, 1, { complete: true, consented: true, seeks: [...seeks] });
      expect(await bandsOf(ctx, pond)).toEqual(band);
      expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 1 });
    });
  });

  test("Only finished profiles stand in a band", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-finished");
    await people(ctx.client, pond, 10, { complete: true, consented: true, seeks: ["man"] });
    // Everything a finished profile has, but for its bio.
    await people(ctx.client, pond, 10, {
      complete: true,
      consented: true,
      seeks: ["man"],
      bio: "none",
    });
    expect(await bandsOf(ctx, pond)).toEqual([10, 0, 0]);
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 10 });
  });

  test("a shadow-banned finished profile stands in its band like any other", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-shadow");
    const [one] = await people(ctx.client, pond, 1, {
      complete: true,
      consented: true,
      seeks: ["woman"],
    });
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [one]);
    expect(await bandsOf(ctx, pond)).toEqual([0, 0, 1]);
  });

  test("A finished profile on an older consent stands in no band", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-consent");
    const [older] = await people(ctx.client, pond, 2, {
      complete: true,
      consented: true,
      seeks: ["man"],
    });
    await ctx.client.query(
      "UPDATE consent SET version = 'older' WHERE account_id = $1 AND kind = 'special_category'",
      [older],
    );
    await people(ctx.client, pond, 1, { complete: true, seeks: ["man"] });
    expect(await bandsOf(ctx, pond)).toEqual([1, 0, 0]);
    // Finished all the same: the consent says nothing of the profile.
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 3 });
  });

  test("A finished profile on a withdrawn consent stands in no band", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-withdrawn");
    const [withdrawn] = await people(ctx.client, pond, 2, {
      complete: true,
      consented: true,
      seeks: ["man"],
    });
    await ctx.client.query(
      `UPDATE consent SET withdrawn_at = '2026-10-04T10:00:00Z'
        WHERE account_id = $1 AND kind = 'special_category'`,
      [withdrawn],
    );
    expect(await bandsOf(ctx, pond)).toEqual([1, 0, 0]);
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ finished: 2 });
  });

  test("the job's log line says no band, as it says no figure", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-log");
    await people(ctx.client, pond, 11, { complete: true, consented: true, seeks: ["man"] });
    const { deps: job, lines } = await deps(ctx, DAY_1);
    await takeSnapshot(job);
    const logged = lines().filter((l) => l.msg === "pond counter");
    expect(logged).toHaveLength(1);
    // Its fields, every one, and not a search of its text: a number looked for
    // there is also found in the process id, which failed CI once in a while.
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual([
      "counted",
      "day",
      "hostname",
      "level",
      "moved",
      "msg",
      "pid",
      "ponds",
      "time",
    ]);
  });

  test("a row from before the bands takes them at the next count, the number standing", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-band-before");
    await people(ctx.client, pond, 12, { complete: true, consented: true, seeks: ["man"] });
    await taken(ctx, DAY_1);
    // As the migration leaves a row that was written before the bands.
    await ctx.client.query(
      "UPDATE pond_counter SET seeks_men = 0, seeks_everyone = 0, seeks_women = 0",
    );
    await people(ctx.client, pond, 1, { complete: true, consented: true, seeks: ["man"] });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ finished: number; seeks_men: number }>(
      "SELECT finished, seeks_men FROM pond_counter WHERE pond_id = $1",
      [pond],
    );
    expect(rows[0]).toEqual({ finished: 12, seeks_men: 13 });
  });
});
