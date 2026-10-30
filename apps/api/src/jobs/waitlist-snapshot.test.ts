import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { WaitlistResponse } from "@kuutti/schema";
import { it } from "vitest";
import { withMatchingConfig } from "../test/account.ts";
import { captureLogger, describe, expect, type TestContext, test } from "../test/harness.ts";
import { people, pondNamed } from "../test/people.ts";
import {
  countPonds,
  ensureFirstSnapshot,
  takeSnapshot,
  WAITLIST_LOCK_KEY,
  waitlistJob,
} from "./waitlist-snapshot.ts";

// features/pond/waitlist.feature (#54, ADR-013): who is counted, and when the
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

const bandsOf = async (ctx: TestContext, pond: string) => {
  const counts = (await countPonds(ctx.client)).get(pond);
  return [counts?.seeksMen, counts?.seeksEveryone, counts?.seeksWomen];
};

const listed = async (ctx: TestContext, pond: string) =>
  WaitlistResponse.parse(await (await ctx.app.request("/waitlist")).json()).ponds.find(
    (p) => p.pond.id === pond,
  );

describe("the figures", () => {
  test("Only live accounts with a pond are counted, a shadow-banned one like any other", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-counted");
    await people(ctx.client, pond, 5, { gender: "woman", state: "registered" });
    await people(ctx.client, pond, 4, { gender: "man", state: "active" });
    await people(ctx.client, pond, 1, { gender: "woman", state: "shadow_banned" });
    for (const state of ["paused", "suspended", "deleted"] as const) {
      await people(ctx.client, pond, 1, { gender: "woman", state });
    }
    await people(ctx.client, pond, 1, { gender: "man", state: "active", standing: "banned" });
    await people(ctx.client, null, 1, { gender: "woman", state: "active" });

    const counts = (await countPonds(ctx.client)).get(pond);
    expect(counts).toEqual({
      verified: 10,
      woman: 6,
      man: 4,
      nonBinary: 0,
      finishing: 10,
      seeksMen: 0,
      seeksEveryone: 0,
      seeksWomen: 0,
    });
  });

  test("a shadow-banned account with a complete profile is not finishing, like an active one", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-shadow");
    const [id] = await people(ctx.client, pond, 1, { gender: "woman", complete: true });
    expect((await countPonds(ctx.client)).get(pond)?.finishing).toBe(0);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [id]);
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ verified: 1, finishing: 0 });
  });

  test("a ready line in place of a bio completes the profile, and neither leaves it finishing (#239)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-ready-line");
    await people(ctx.client, pond, 1, { gender: "woman", complete: true, bio: "ready_line" });
    await people(ctx.client, pond, 1, { gender: "woman", complete: true, bio: "none" });
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ verified: 2, finishing: 1 });
  });

  test("photos sent in conversations finish no profile: one whose approved photos are all of messages is finishing (#350)", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-message-photos");
    const [messagesOnly] = await people(ctx.client, pond, 2, { gender: "woman", complete: true });
    // The same three approved photos, sent in conversations instead.
    await ctx.client.query(
      "UPDATE photo SET purpose = 'message', position = NULL WHERE account_id = $1",
      [messagesOnly],
    );
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ verified: 2, finishing: 1 });
  });

  test("A profile that is not complete counts as finishing", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-finishing");
    await people(ctx.client, pond, 10, { gender: "woman", complete: true });
    await people(ctx.client, pond, 9, { gender: "man", state: "active" });
    await people(ctx.client, pond, 6, { state: "registered" });
    await taken(ctx, DAY_1);
    expect(await listed(ctx, pond)).toMatchObject({ verified: 25, finishing: 15, split: null });
  });

  test("The people finishing are counted in public only when they and the rest are none or at least k", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-finishing-small");
    await people(ctx.client, pond, 3, { gender: "woman", complete: true });
    await people(ctx.client, pond, 9, { gender: "man", state: "active" });
    await taken(ctx, DAY_1);
    expect(await listed(ctx, pond)).toMatchObject({ verified: 12, finishing: null });
  });

  test("a complete profile on an account that is not active yet is still finishing", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-not-active");
    const [id] = await people(ctx.client, pond, 1, { gender: "woman", complete: true });
    await ctx.client.query("UPDATE account SET state = 'registered' WHERE id = $1", [id]);
    expect((await countPonds(ctx.client)).get(pond)?.finishing).toBe(1);
  });

  test("The figures of a pond move only once at least k people have come or gone", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-steps");
    await people(ctx.client, pond, 25, { gender: "woman" });
    expect((await taken(ctx, DAY_1)).day).toBe("2026-10-05");
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ day: "2026-10-05", verified: 25 });

    await people(ctx.client, pond, 9, { gender: "man" });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toEqual(said);

    await people(ctx.client, pond, 1, { gender: "man" });
    await taken(ctx, DAY_3);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-07", verified: 35 });
  });

  test("The accounts are counted at most once a day", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-once");
    await people(ctx.client, pond, 25, { gender: "woman" });
    expect(await taken(ctx, DAY_1)).toMatchObject({ counted: true });
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ day: "2026-10-05", verified: 25 });

    await people(ctx.client, pond, 10, { gender: "man" });
    const again = await deps(ctx, LATER_ON_DAY_1);
    expect(await takeSnapshot(again.deps)).toEqual({
      day: "2026-10-05",
      ponds: 0,
      moved: 0,
      counted: false,
    });
    expect(await listed(ctx, pond)).toEqual(said);
    expect(again.lines().map((l) => l.msg)).toContain("waitlist snapshot: counted today already");

    expect(await taken(ctx, DAY_2)).toMatchObject({ counted: true });
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", verified: 35 });
  });

  test("a pond that did not move is marked as counted too, its figures and their day as they were", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-mark");
    await people(ctx.client, pond, 25, { gender: "woman" });
    await taken(ctx, DAY_1);
    await people(ctx.client, pond, 3, { gender: "woman" });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ day: string; verified: number; taken_at: Date }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, verified, taken_at
       FROM waitlist_snapshot WHERE pond_id = $1`,
      [pond],
    );
    expect(rows).toEqual([{ day: "2026-10-05", verified: 25, taken_at: DAY_2 }]);
  });

  test("The figures do not move between two counts", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-between");
    await people(ctx.client, pond, 11, { gender: "woman" });
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said?.verified).toBe(11);

    await people(ctx.client, pond, 15, { gender: "woman" });
    expect(await listed(ctx, pond)).toEqual(said);

    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", verified: 26 });
  });

  test("one arrival and one departure a day never show, however many days pass", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-quiet");
    await people(ctx.client, pond, 13, { gender: "woman" });
    await people(ctx.client, pond, 12, { gender: "man" });
    await people(ctx.client, pond, 10, { gender: "non_binary" });
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said?.split).toEqual({ woman: 13, man: 12, nonBinary: 10 });

    // A woman comes: the total and her cell would each have gone up by one.
    await people(ctx.client, pond, 1, { gender: "woman" });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toEqual(said);

    // A non-binary person leaves: the cell is nine now, and the split still stands as it was said.
    await ctx.client.query(
      `UPDATE account SET state = 'paused' WHERE id =
         (SELECT id FROM account WHERE pond_id = $1 AND gender = 'non_binary' LIMIT 1)`,
      [pond],
    );
    await taken(ctx, DAY_3);
    expect(await listed(ctx, pond)).toEqual(said);
  });

  test("figures said under k = 10 stand while k is raised, and are said again unchanged when it returns", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-raised");
    for (const gender of ["woman", "man", "non_binary"] as const) {
      await people(ctx.client, pond, 15, { gender });
    }
    await taken(ctx, DAY_1);
    const said = await listed(ctx, pond);
    expect(said).toMatchObject({ verified: 45, split: { woman: 15, man: 15, nonBinary: 15 } });

    await withMatchingConfig(ctx.client, { waitlist_k: 50 });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: null, verified: null, split: null });
    await people(ctx.client, pond, 1, { gender: "woman" });
    await taken(ctx, DAY_3);

    await withMatchingConfig(ctx.client, { waitlist_k: 10 });
    expect(await listed(ctx, pond)).toEqual(said);
  });

  test("a pond that was never said follows every count until it reaches k", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-growing");
    await people(ctx.client, pond, 4, { gender: "man" });
    await taken(ctx, DAY_1);
    expect(await listed(ctx, pond)).toMatchObject({ day: null, verified: null });
    await people(ctx.client, pond, 6, { gender: "man" });
    await taken(ctx, DAY_2);
    expect(await listed(ctx, pond)).toMatchObject({ day: "2026-10-06", verified: 10 });
  });

  test("there is one row per pond, zeros included, and no history", async ({ ctx }) => {
    const chosen = await pondNamed(ctx.client, "test-waitlist-chosen");
    const empty = await pondNamed(ctx.client, "test-waitlist-empty");
    await people(ctx.client, chosen, 2, { gender: "man" });
    await taken(ctx, DAY_1);
    await people(ctx.client, chosen, 30, { gender: "man" });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ pond_id: string; verified: number; day: string }>(
      `SELECT pond_id, verified, to_char(day, 'YYYY-MM-DD') AS day
       FROM waitlist_snapshot WHERE pond_id = ANY($1)`,
      [[chosen, empty]],
    );
    expect(rows).toHaveLength(2);
    expect(Object.fromEntries(rows.map((r) => [r.pond_id, [r.verified, r.day]]))).toEqual({
      [chosen]: [32, "2026-10-06"],
      [empty]: [0, "2026-10-05"],
    });
  });

  test("the job logs how many ponds moved, and no figure of any pond", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-waitlist-log");
    await people(ctx.client, pond, 37, { gender: "man" });
    const { deps: d, lines } = await deps(ctx, DAY_1);
    const job = waitlistJob(d);
    expect(job.name).toBe("waitlist-snapshot");
    const result = await job.run();
    expect(result.ponds).toBeGreaterThanOrEqual(1);
    expect(result.moved).toBeGreaterThanOrEqual(1);
    const logged = lines().filter((l) => l.msg === "waitlist snapshot");
    expect(logged).toHaveLength(1);
    const keys = Object.keys(logged[0] ?? {});
    expect(keys).toEqual(expect.arrayContaining(["day", "moved", "ponds"]));
    for (const figure of ["accounts", "verified", "woman", "man", "nonBinary", "finishing"]) {
      expect(keys).not.toContain(figure);
    }
    expect(JSON.stringify(logged)).not.toContain(pond);
  });

  test("the first figures are taken only when there are none", async ({ ctx }) => {
    await ctx.client.query("DELETE FROM waitlist_snapshot");
    await pondNamed(ctx.client, "test-waitlist-first");
    const first = await ensureFirstSnapshot((await deps(ctx, DAY_1)).deps);
    expect(first?.day).toBe("2026-10-05");
    expect(await ensureFirstSnapshot((await deps(ctx, DAY_2)).deps)).toBeNull();
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
        const pond = await pondNamed(pool, "test-waitlist-parallel");
        await people(pool, pond, 45, { gender: "woman" });
        await takeSnapshot({ db: pool, logger, now: () => DAY_1 });
        await people(pool, pond, 10, { gender: "woman" });

        // The first count of the day, by hand: it holds the lock, has written
        // 55 and has marked every row as counted.
        const first = await pool.connect();
        let second: Promise<unknown>;
        try {
          await first.query("BEGIN");
          await first.query("SELECT pg_advisory_xact_lock($1)", [WAITLIST_LOCK_KEY]);
          await first.query(
            "UPDATE waitlist_snapshot SET verified = 55, woman = 55, finishing = 55, day = $2 WHERE pond_id = $1",
            [pond, "2026-10-06"],
          );
          await first.query("UPDATE waitlist_snapshot SET taken_at = $1", [DAY_2]);
          second = takeSnapshot({ db: pool, logger, now: () => DAY_2 });
          const waited = await Promise.race([second.then(() => "ran"), sleep(300, "waited")]);
          expect(waited).toBe("waited");
          // Somebody joins before the second count gets to look.
          await people(pool, pond, 1, { gender: "woman" });
          await first.query("COMMIT");
        } finally {
          first.release();
        }
        // The day has had its count: the second process counts nothing.
        expect(await second).toMatchObject({ moved: 0, counted: false });
        const { rows } = await pool.query<{ verified: number }>(
          "SELECT verified FROM waitlist_snapshot WHERE pond_id = $1",
          [pond],
        );
        // Without the lock the second count would have seen neither the 55 nor
        // the mark, compared 56 with 45, and written 56.
        expect(rows).toEqual([{ verified: 55 }]);
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
      await people(ctx.client, pond, 1, { complete: true, seeks: [...seeks] });
      expect(await bandsOf(ctx, pond)).toEqual(band);
      expect((await countPonds(ctx.client)).get(pond)).toMatchObject({ verified: 1, finishing: 0 });
    });
  });

  test("Only finished profiles stand in a band", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-finished");
    await people(ctx.client, pond, 10, { complete: true, seeks: ["man"] });
    const finishing = await people(ctx.client, pond, 10, { complete: true, seeks: ["man"] });
    await ctx.client.query("UPDATE account SET state = 'registered' WHERE id = ANY($1)", [
      finishing,
    ]);
    expect(await bandsOf(ctx, pond)).toEqual([10, 0, 0]);
    expect((await countPonds(ctx.client)).get(pond)).toMatchObject({
      verified: 20,
      finishing: 10,
    });
  });

  test("a shadow-banned finished profile stands in its band like any other", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-shadow");
    const [one] = await people(ctx.client, pond, 1, { complete: true, seeks: ["woman"] });
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [one]);
    expect(await bandsOf(ctx, pond)).toEqual([0, 0, 1]);
  });

  test("the job's log line says no band, as it says no figure", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-band-log");
    await people(ctx.client, pond, 11, { complete: true, seeks: ["man"] });
    const { deps: job, lines } = await deps(ctx, DAY_1);
    await takeSnapshot(job);
    const said = JSON.stringify(lines());
    expect(said).toContain("waitlist snapshot");
    expect(said).not.toContain("seeks");
    expect(said).not.toContain('":11');
  });

  test("a row from before the bands takes them at the next count, the total standing", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-band-before");
    await people(ctx.client, pond, 12, { complete: true, seeks: ["man"] });
    await taken(ctx, DAY_1);
    // As the migration leaves a row that was written before the bands.
    await ctx.client.query(
      "UPDATE waitlist_snapshot SET seeks_men = 0, seeks_everyone = 0, seeks_women = 0",
    );
    await people(ctx.client, pond, 1, { complete: true, seeks: ["man"] });
    await taken(ctx, DAY_2);
    const { rows } = await ctx.client.query<{ verified: number; seeks_men: number }>(
      "SELECT verified, seeks_men FROM waitlist_snapshot WHERE pond_id = $1",
      [pond],
    );
    expect(rows[0]).toEqual({ verified: 12, seeks_men: 13 });
  });
});
