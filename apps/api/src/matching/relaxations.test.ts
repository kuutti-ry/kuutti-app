import type { Queryable } from "@kuutti/db";
import { finnishDay } from "../lib/finnish-day.ts";
import { signedInAccount } from "../test/account.ts";
import { captureLogger, describe, expect, test } from "../test/harness.ts";
import { appendRelaxed, decide, saveRound, undoRelaxation } from "./rounds.ts";

// The short pool's writers (#99, ADR-042 §5, §6) where the routes cannot reach
// them: a relaxation recorded or undone between the route's look and the
// write, as a second device's tap would be; a candidate who stopped being
// one meanwhile; the round's places and its completion. The routes are
// jobs/short-pool.test.ts.

const NOON = new Date("2026-10-20T09:00:00.000Z");
const DAY = finnishDay(NOON);
const ASIDE = { field: "smoking", kind: "aside" } as const;
const KIDS = { field: "hasKids", kind: "aside" } as const;

const depsOf = async (db: Queryable) => ({
  db,
  logger: (await captureLogger()).logger,
  now: () => NOON,
});

/** A's round of today with these people in it at places 1, 2…, and nobody else. */
async function roundWith(db: Queryable, accountId: string, cards: string[]) {
  const built = await saveRound(await depsOf(db), {
    accountId,
    day: DAY,
    ordering: "count",
    entries: cards.map((candidateId) => ({ candidateId, reason: "matches_filters" as const })),
  });
  if (!built) throw new Error("round not written");
  return built.roundId;
}

async function placesOf(db: Queryable, roundId: string) {
  const { rows } = await db.query<{ position: number; candidate_id: string; reason: string }>(
    "SELECT position, candidate_id, reason FROM round_entries WHERE round_id = $1 ORDER BY position",
    [roundId],
  );
  return rows;
}

const completedAt = async (db: Queryable, roundId: string) =>
  (
    await db.query<{ at: Date | null }>("SELECT completed_at AS at FROM rounds WHERE id = $1", [
      roundId,
    ])
  ).rows[0]?.at ?? null;

const NO_MATCHES = { between: async () => null, open: async () => "" };

describe("the relaxation's writer", () => {
  test("refuses a deal-breaker relaxed since the route looked, and adds nothing", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, []);
    expect(
      await appendRelaxed(deps, {
        accountId: a.accountId,
        day: DAY,
        relaxation: ASIDE,
        basis: [],
        candidateIds: [],
      }),
    ).toEqual([]);

    const again = appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: { ...ASIDE, kind: "unanswered" },
      basis: [],
      candidateIds: [b.accountId],
    });

    await expect(again).rejects.toMatchObject({ status: 409, code: "already_relaxed" });
    expect(await placesOf(ctx.client, roundId)).toEqual([]);
  });

  test("refuses a relaxation counted under other relaxations than stand now, and adds nothing", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, []);
    // Another device relaxed smoking after this tap's candidates were counted without it.
    await appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidateIds: [],
    });

    const stale = appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: KIDS,
      basis: [],
      candidateIds: [b.accountId],
    });

    await expect(stale).rejects.toMatchObject({ status: 409, code: "relaxations_changed" });
    expect(await placesOf(ctx.client, roundId)).toEqual([]);
    const { rows } = await ctx.client.query(
      "SELECT field FROM round_relaxation WHERE round_id = $1",
      [roundId],
    );
    expect(rows).toEqual([{ field: "smoking" }]);
  });

  test("writes only who is still a candidate where it writes, at the places after the last", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const [first, blocked, paused, already, live] = await Promise.all(
      Array.from({ length: 5 }, () => signedInAccount(ctx.client)),
    );
    if (!first || !blocked || !paused || !already || !live) throw new Error("not written");
    const roundId = await roundWith(ctx.client, a.accountId, [first.accountId, already.accountId]);
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT b.identity_id, a.identity_id FROM account a, account b WHERE a.id = $1 AND b.id = $2`,
      [a.accountId, blocked.accountId],
    );
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [paused.accountId]);

    const placed = await appendRelaxed(await depsOf(ctx.client), {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidateIds: [
        blocked.accountId,
        paused.accountId,
        a.accountId,
        already.accountId,
        live.accountId,
      ],
    });

    expect(placed).toEqual([3]);
    expect((await placesOf(ctx.client, roundId)).map((e) => [e.position, e.candidate_id])).toEqual([
      [1, first.accountId],
      [2, already.accountId],
      [3, live.accountId],
    ]);
  });

  test("adds nothing, and leaves the round's completion, when every candidate is gone", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const gone = await signedInAccount(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, []);
    const at = new Date("2026-10-20T08:00:00.000Z");
    await ctx.client.query("UPDATE rounds SET completed_at = $2 WHERE id = $1", [roundId, at]);
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [gone.accountId]);

    const placed = await appendRelaxed(await depsOf(ctx.client), {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidateIds: [gone.accountId],
    });

    expect(placed).toEqual([]);
    expect(await completedAt(ctx.client, roundId)).toEqual(at);
  });

  test("never gives a place again that an undo freed", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const [b, c, d] = await Promise.all([1, 2, 3].map(() => signedInAccount(ctx.client)));
    if (!b || !c || !d) throw new Error("not written");
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, [b.accountId]);
    const added = { accountId: a.accountId, day: DAY, basis: [] };
    expect(
      await appendRelaxed(deps, { ...added, relaxation: ASIDE, candidateIds: [c.accountId] }),
    ).toEqual([2]);
    expect(
      await undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" }),
    ).toEqual([2]);

    const again = await appendRelaxed(deps, {
      ...added,
      relaxation: ASIDE,
      candidateIds: [d.accountId],
    });

    expect(again).toEqual([3]);
    expect((await placesOf(ctx.client, roundId)).map((e) => e.position)).toEqual([1, 3]);
  });

  test("a relaxation's cards reopen a completed round, and the undo that leaves nothing undecided completes it again", async ({
    ctx,
  }) => {
    const a = await signedInAccount(ctx.client);
    const [b, c] = await Promise.all([1, 2].map(() => signedInAccount(ctx.client)));
    if (!b || !c) throw new Error("not written");
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, [b.accountId]);
    await decide(deps, NO_MATCHES, {
      accountId: a.accountId,
      day: DAY,
      position: 1,
      decision: "pass",
    });
    expect(await completedAt(ctx.client, roundId)).not.toBeNull();

    await appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidateIds: [c.accountId],
    });
    expect(await completedAt(ctx.client, roundId)).toBeNull();

    await undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" });
    expect(await completedAt(ctx.client, roundId)).toEqual(NOON);
  });

  test("an undo that leaves the round with no cards does not call it complete", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, []);
    await appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidateIds: [b.accountId],
    });

    expect(
      await undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" }),
    ).toEqual([1]);
    expect(await completedAt(ctx.client, roundId)).toBeNull();
  });

  test("with no round today, neither writer writes", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const deps = await depsOf(ctx.client);
    await expect(
      appendRelaxed(deps, {
        accountId: a.accountId,
        day: DAY,
        relaxation: ASIDE,
        basis: [],
        candidateIds: [],
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });
});
