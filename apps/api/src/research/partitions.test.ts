import { describe, expect, it } from "vitest";
import { test } from "../test/harness.ts";
import {
  EVENTS_RETENTION_DAYS,
  ensureEventPartitions,
  monthPartition,
  partitionStart,
  partitionsAhead,
  pruneEventPartitions,
  researchEventsJob,
} from "./partitions.ts";

// The monthly partitions of events (#50, ADR-011; rules/db.md). The DDL runs
// inside the test's transaction and is rolled back with it; the months used
// are far from today so the partitions the test setup created stay untouched.

describe("month partitions", () => {
  it("names a month and bounds it in UTC, half open", () => {
    const p = monthPartition(2031, 12);
    expect(p).toEqual({
      name: "events_2031_12",
      from: new Date("2031-12-01T00:00:00.000Z"),
      to: new Date("2032-01-01T00:00:00.000Z"),
    });
    expect(partitionStart("events_2031_12")).toEqual(new Date("2031-12-01T00:00:00.000Z"));
    expect(partitionStart("events_default")).toBeNull();
    expect(partitionStart("photo")).toBeNull();
  });

  it("looks one month ahead, across a year end", () => {
    expect(partitionsAhead(new Date("2031-12-15T10:00:00Z")).map((p) => p.name)).toEqual([
      "events_2031_12",
      "events_2032_01",
    ]);
  });

  it("keeps ninety days", () => {
    expect(EVENTS_RETENTION_DAYS).toBe(90);
  });
});

describe("ensure and prune", () => {
  test("creates the current and the next month once, and an event lands in its month", async ({
    ctx,
  }) => {
    const now = new Date("2031-05-15T12:00:00Z");
    const first = await ensureEventPartitions(ctx.client, now);
    expect(first.created).toBe(2);
    expect(first.partitions).toEqual(expect.arrayContaining(["events_2031_05", "events_2031_06"]));
    const again = await ensureEventPartitions(ctx.client, now);
    expect(again.created).toBe(0);

    await ctx.client.query(
      `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
       VALUES ($1, 'profile_saved', gen_random_uuid(), 'v', 'otaniemi', '25-29', '{}', '{}')`,
      [now],
    );
    const { rows } = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM events_2031_05",
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test("drops a month once its oldest row reaches the retention and keeps the rest", async ({
    ctx,
  }) => {
    // Months in the past, so the partitions the test setup created for today stay in range.
    await ensureEventPartitions(ctx.client, new Date("2020-01-10T00:00:00Z")); // 2020_01, 2020_02
    await ensureEventPartitions(ctx.client, new Date("2020-03-10T00:00:00Z")); // 2020_03, 2020_04
    // 2020-05-15 minus 90 days is 2020-02-15: January and February began before it, March did not.
    // Nothing in a dropped month is older than 90 days; nothing kept is older either.
    const pruned = await pruneEventPartitions(ctx.client, new Date("2020-05-15T00:00:00Z"));
    expect(pruned.dropped).toBe(2);
    expect(pruned.partitions).not.toContain("events_2020_01");
    expect(pruned.partitions).not.toContain("events_2020_02");
    expect(pruned.partitions).toEqual(expect.arrayContaining(["events_2020_03", "events_2020_04"]));
  });

  test("the nightly job does both and reports counts", async ({ ctx }) => {
    await ensureEventPartitions(ctx.client, new Date("2021-01-10T00:00:00Z")); // 2021_01, 2021_02
    const job = researchEventsJob({ db: ctx.client, now: () => new Date("2021-07-01T00:00:00Z") });
    expect(job.name).toBe("research-events-partitions");
    const result = await job.run();
    expect(result.created).toBe(2); // 2021_07 and 2021_08
    expect(result.dropped).toBe(2); // 2021_01 and 2021_02
    expect(result.partitions).toBeGreaterThanOrEqual(2);
    // Where no research copy is written, nothing is said about one.
    expect(result).not.toHaveProperty("uncopied");
  });

  test("asks the copy about exactly the months it drops, and drops them whatever it answers", async ({
    ctx,
  }) => {
    await ensureEventPartitions(ctx.client, new Date("2021-01-10T00:00:00Z")); // 2021_01, 2021_02
    const asked: string[][] = [];
    const job = researchEventsJob({
      db: ctx.client,
      now: () => new Date("2021-07-01T00:00:00Z"),
      beforeDrop: async (months) => {
        asked.push(months.map((m) => m.name));
        return 3;
      },
    });
    const result = await job.run();
    expect(asked).toEqual([["events_2021_01", "events_2021_02"]]);
    // ADR-029 §6, P1: the ninety days of the binding text win over the copy.
    expect(result).toMatchObject({ dropped: 2, uncopied: 3 });
  });

  test("rows are never updated, deleted or truncated", async ({ ctx }) => {
    const now = new Date("2033-02-02T00:00:00Z");
    await ensureEventPartitions(ctx.client, now);
    await ctx.client.query(
      `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
       VALUES ($1, 'profile_saved', gen_random_uuid(), 'v', null, '25-29', '{}', '{}')`,
      [now],
    );
    for (const statement of [
      "UPDATE events SET name = 'x' WHERE at = $1",
      "DELETE FROM events WHERE at = $1",
    ]) {
      await ctx.client.query("SAVEPOINT immutable");
      await expect(ctx.client.query(statement, [now])).rejects.toThrow(/append-only/);
      await ctx.client.query("ROLLBACK TO SAVEPOINT immutable");
    }
    // The parent and, since a statement trigger is not cloned, the partition by name.
    for (const statement of ["TRUNCATE events", "TRUNCATE events_2033_02"]) {
      await ctx.client.query("SAVEPOINT immutable");
      await expect(ctx.client.query(statement)).rejects.toThrow(/append-only/);
      await ctx.client.query("ROLLBACK TO SAVEPOINT immutable");
    }
  });
});
