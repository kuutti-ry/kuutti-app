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

/** People a relaxation lets in who need none of the day's other relaxations. */
const as = (ids: string[]) => ids.map((candidateId) => ({ candidateId, needs: [] }));

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
        candidates: as([]),
      }),
    ).toEqual([]);

    const again = appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: { ...ASIDE, kind: "unanswered" },
      basis: [],
      candidates: as([b.accountId]),
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
      candidates: as([]),
    });

    const stale = appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: KIDS,
      basis: [],
      candidates: as([b.accountId]),
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
      candidates: as([
        blocked.accountId,
        paused.accountId,
        a.accountId,
        already.accountId,
        live.accountId,
      ]),
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
      candidates: as([gone.accountId]),
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
      await appendRelaxed(deps, { ...added, relaxation: ASIDE, candidates: as([c.accountId]) }),
    ).toEqual([2]);
    expect(
      await undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" }),
    ).toEqual([2]);

    const again = await appendRelaxed(deps, {
      ...added,
      relaxation: ASIDE,
      candidates: as([d.accountId]),
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
      candidates: as([c.accountId]),
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
      candidates: as([b.accountId]),
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
        candidates: as([]),
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });

  test("an undo gives no room back: a day's round holds at most round_size ordered people", async ({
    ctx,
  }) => {
    // A version above every one a migration wrote, so it is the one read.
    await ctx.client.query(
      `INSERT INTO matching_config (version, key, value, created_by)
       SELECT max(version) + 1, 'round_size', '2'::jsonb, 'test' FROM matching_config WHERE key = 'round_size'`,
    );
    const a = await signedInAccount(ctx.client);
    const [b, c, d] = await Promise.all([1, 2, 3].map(() => signedInAccount(ctx.client)));
    if (!b || !c || !d) throw new Error("not written");
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, [b.accountId]);
    const day = { accountId: a.accountId, day: DAY };
    expect(
      await appendRelaxed(deps, {
        ...day,
        relaxation: ASIDE,
        basis: [],
        candidates: as([c.accountId]),
      }),
    ).toEqual([2]);
    await undoRelaxation(deps, { ...day, field: "smoking" });

    const after = await appendRelaxed(deps, {
      ...day,
      relaxation: KIDS,
      basis: [],
      candidates: as([d.accountId]),
    });

    expect(after).toEqual([]);
    expect((await placesOf(ctx.client, roundId)).map((e) => e.candidate_id)).toEqual([b.accountId]);
  });

  test("undoing one relaxation takes back only the cards that need it", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const [b, c, d] = await Promise.all([1, 2, 3].map(() => signedInAccount(ctx.client)));
    if (!b || !c || !d) throw new Error("not written");
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, []);
    const day = { accountId: a.accountId, day: DAY };
    await appendRelaxed(deps, {
      ...day,
      relaxation: ASIDE,
      basis: [],
      candidates: as([b.accountId]),
    });
    // On top of smoking: C needs both, D only kids.
    await appendRelaxed(deps, {
      ...day,
      relaxation: KIDS,
      basis: [ASIDE],
      candidates: [
        { candidateId: c.accountId, needs: ["smoking"] },
        { candidateId: d.accountId, needs: [] },
      ],
    });

    const removed = await undoRelaxation(deps, { ...day, field: "smoking" });

    expect(removed).toEqual([1, 2]);
    expect((await placesOf(ctx.client, roundId)).map((e) => e.candidate_id)).toEqual([d.accountId]);
  });

  test("an undo does not complete a round the person decided nothing in", async ({ ctx }) => {
    const a = await signedInAccount(ctx.client);
    const [gone, c] = await Promise.all([1, 2].map(() => signedInAccount(ctx.client)));
    if (!gone || !c) throw new Error("not written");
    const deps = await depsOf(ctx.client);
    const roundId = await roundWith(ctx.client, a.accountId, [gone.accountId]);
    // The one card can no longer be shown, and nothing was decided.
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [gone.accountId]);
    await appendRelaxed(deps, {
      accountId: a.accountId,
      day: DAY,
      relaxation: ASIDE,
      basis: [],
      candidates: as([c.accountId]),
    });

    await undoRelaxation(deps, { accountId: a.accountId, day: DAY, field: "smoking" });

    expect(await completedAt(ctx.client, roundId)).toBeNull();
  });
});
