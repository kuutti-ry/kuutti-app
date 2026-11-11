import type { Queryable } from "@kuutti/db";
import { RoundDecisionAnswer, RoundResponse } from "@kuutti/schema";
import fc from "fast-check";
import { type App, createApp } from "../app.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { errorCode as codeOf } from "../test/answers.ts";
import { interleaved } from "../test/chat.ts";
import { STOPPED_CLOCK as T } from "../test/global-setup.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { earnedUnits, unitsOf } from "../test/invitations.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import {
  block,
  cast,
  fishToSendAfter,
  fitsAt,
  type LoggedCard,
  likesLeftAfter,
  logged,
  MATCHES,
  peopleWhoFit,
} from "../test/rounds.ts";
import { decide } from "./rounds.ts";

// Earned fish in today's round (#107, ADR-044 §8, #503,
// features/matching/earned.feature): a unit used by itself past the window's
// budget, given back when its fish changes, left out of the count once it
// paid; a fish that is a like spends none; a fish needs one of the day's likes
// whoever paid for it; a refusal spends nothing; and a give-back racing a
// spend on another device. How a unit is earned is
// jobs/invitation-count.test.ts.

/** 12:00 in Finland, one Friday. */
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = finnishDay(T);

type Person = { accountId: string; headers: { authorization: string } };
type Card = Person | { person: Person; reason: "liked_you" | "fish" };

const daysBefore = (days: number) => new Date(T.getTime() - days * DAY_MS);

async function appAt(db: Queryable): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => T });
}

/** A round for `owner` `days` before today with these cards, matching every filter unless said; the entries' ids in order. */
async function roundOf(db: Queryable, owner: Person, cards: Card[], days = 0): Promise<string[]> {
  const written = cards.map(
    (card): LoggedCard =>
      "person" in card
        ? { candidateId: card.person.accountId, reason: card.reason }
        : card.accountId,
  );
  const roundId = await logged(db, owner.accountId, finnishDay(daysBefore(days)), written);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM round_entries WHERE round_id = $1 ORDER BY position",
    [roundId],
  );
  return rows.map((row) => row.id);
}

/** `sender` sent `to` a fish, or a like, on a round of `days` before today; the entry's id. */
async function sentBefore(db: Queryable, sender: Person, to: Person, days: number, fish: boolean) {
  const [entry] = await roundOf(db, sender, [to], days);
  await db.query(
    "UPDATE round_entries SET decision = 'like', decided_at = $2, fish = $3 WHERE id = $1",
    [entry, daysBefore(days), fish],
  );
  return entry as string;
}

const choose = (app: App, who: Person, position: number, decision: string) =>
  app.request(`/rounds/${TODAY}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

/** The day's likes as a new version of like_budget_balanced, which has versions of its own already. */
async function likeBudget(db: Queryable, n: number) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT max(version) + 1, 'like_budget_balanced', $1::jsonb, 'test'
       FROM matching_config WHERE key = 'like_budget_balanced'`,
    [JSON.stringify(n)],
  );
}

/** What the answer to a decision says of the caller's fish after it (#475). */

/** What the answer to a decision says of the caller's likes after it (#524). */

async function decisionsOf(db: Queryable, entries: readonly string[]) {
  const { rows } = await db.query<{ id: string; decision: string | null; fish: boolean }>(
    "SELECT id, decision, fish FROM round_entries WHERE id = ANY($1::uuid[])",
    [entries],
  );
  return entries.map((id) => {
    const row = rows.find((r) => r.id === id);
    return row?.decision === "like" && row.fish ? "fish" : (row?.decision ?? null);
  });
}

const UNIT_WAITING = { kind: "fish", spent: false, entryId: null };

describe("earned fish", () => {
  test("An earned fish is used once the window's fish are sent, and the next without one is refused", async ({
    ctx,
  }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    const refused = await choose(app, a, 2, "fish");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("fish_budget_exceeded");
    expect(await decisionsOf(ctx.client, entries)).toEqual(["fish", null]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: entries[0] },
    ]);
  });

  test("A fish an earned fish paid for is left out of the window", async ({ ctx }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    const paid = await sentBefore(ctx.client, a, x, 1, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(3));
    await ctx.client.query(
      "UPDATE reward SET spent_at = $2, spent_entry_id = $3 WHERE account_id = $1",
      [a.accountId, daysBefore(1), paid],
    );
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(2));
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["fish"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: paid },
      UNIT_WAITING,
    ]);
  });

  test("the oldest earned fish goes first, one a fish", async ({ ctx }) => {
    const [a, b, c, d, x] = await cast(ctx.client, 5);
    if (!a || !b || !c || !d || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(2));
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(5));
    const entries = await roundOf(ctx.client, a, [b, c, d]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: entries[0] },
      UNIT_WAITING,
    ]);
    expect((await choose(app, a, 2, "fish")).status).toBe(200);
    expect((await choose(app, a, 3, "fish")).status).toBe(429);
  });

  test("A fish changed to a like gives its earned fish back", async ({ ctx }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: entries[0] },
    ]);
    expect((await choose(app, a, 1, "like")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("A fish changed to a pass gives its earned fish back", async ({ ctx }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect((await choose(app, a, 1, "pass")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["pass"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("a change gives back the one unit that paid for that fish", async ({ ctx }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(2));
    await earnedUnits(ctx.client, a.accountId, { fish: 1 }, daysBefore(1));
    const entries = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect((await choose(app, a, 2, "fish")).status).toBe(200);

    expect((await choose(app, a, 1, "pass")).status).toBe(200);

    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      UNIT_WAITING,
      { kind: "fish", spent: true, entryId: entries[1] },
    ]);
  });

  test("An earned fish needs one of the day's likes", async ({ ctx }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    const refused = await choose(app, a, 2, "fish");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("like_budget_exceeded");
    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", null]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("a fish an earned fish paid for takes one of the day's likes, and a pass gives both back", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 2);
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect(await likesLeftAfter(await choose(app, a, 1, "fish"))).toBe(1);
    expect(await likesLeftAfter(await choose(app, a, 1, "pass"))).toBe(2);

    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("A like made a fish with no likes left spends the earned fish and no like", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect(await likesLeftAfter(await choose(app, a, 1, "like"))).toBe(0);
    expect(await likesLeftAfter(await choose(app, a, 1, "fish"))).toBe(0);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["fish"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: entries[0] },
    ]);
  });

  test("a fish made a like again with no likes left stays liked, and gives its earned fish back", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);

    expect(await likesLeftAfter(await choose(app, a, 1, "like"))).toBe(0);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("A fish on a card that answers a like never spends an earned fish", async ({ ctx }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    await sentBefore(ctx.client, b, a, 1, false);
    await sentBefore(ctx.client, c, a, 1, true);
    const entries = await roundOf(ctx.client, a, [
      { person: b, reason: "liked_you" },
      { person: c, reason: "fish" },
    ]);
    const app = await appAt(ctx.client);

    for (const position of [1, 2]) {
      const answer = await choose(app, a, position, "fish");
      expect(answer.status).toBe(200);
      expect(RoundDecisionAnswer.parse(await answer.json()).match).not.toBeNull();
    }

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", "like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("a fish that made a match is final, and the earned fish on it stays spent", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    await sentBefore(ctx.client, b, a, 1, false);
    const entries = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    const sent = await choose(app, a, 1, "fish");
    expect(RoundDecisionAnswer.parse(await sent.json()).match).not.toBeNull();

    for (const change of ["like", "pass"]) {
      const refused = await choose(app, a, 1, change);
      expect(refused.status).toBe(409);
      expect(await codeOf(refused)).toBe("match_made");
    }

    expect(await decisionsOf(ctx.client, entries)).toEqual(["fish"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: entries[0] },
    ]);
  });

  test("a block that lands after the fish took its earned fish rolls the unit back with the rest", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    // B blocks A once the unit is spent, just before the fish is written, as if it committed then.
    const db = interleaved(ctx.client, /UPDATE round_entries e SET decision/, () =>
      block(ctx.client, b, a),
    );

    const answer = await choose(await appAt(db), a, 1, "fish");

    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await codeOf(answer)).toBe("not_found");
    expect(await decisionsOf(ctx.client, entries)).toEqual([null]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([UNIT_WAITING]);
  });

  test("an earned fish waiting keeps a fish to send once the day's own is sent, and none once it is spent too (#475)", async ({
    ctx,
  }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect(await fishToSendAfter(await choose(app, a, 1, "fish"))).toBe(true);
    const read = await app.request("/rounds/today", { headers: a.headers });
    expect(RoundResponse.parse(await read.json()).fishToSend).toBe(true);
    expect(await fishToSendAfter(await choose(app, a, 2, "fish"))).toBe(false);
    // The earned one given back by a like is waiting again.
    expect(await fishToSendAfter(await choose(app, a, 2, "like"))).toBe(true);
  });

  test("a unit stays spent when the entry it paid for goes, an erased candidate's", async ({
    ctx,
  }) => {
    const [a, b, x] = await cast(ctx.client, 3);
    if (!a || !b || !x) throw new Error("cast not written");
    await sentBefore(ctx.client, a, x, 3, true);
    await earnedUnits(ctx.client, a.accountId, { fish: 1 });
    const entries = await roundOf(ctx.client, a, [b]);
    expect((await choose(await appAt(ctx.client), a, 1, "fish")).status).toBe(200);
    await ctx.client.query("DELETE FROM round_entries WHERE id = $1", [entries[0]]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: true, entryId: null },
    ]);
  });
});

describe("any order of decisions", () => {
  /** The week's fish, the default of fish_budget. */
  const WEEK = 1;

  /** Today's cards, each with whether a unit paid for it, and how many units wait. */
  async function holdings(db: Queryable, entries: readonly string[], accountId: string) {
    const units = await unitsOf(db, accountId);
    const decisions = await decisionsOf(db, entries);
    return {
      cards: entries.map((id, i) => ({
        decision: decisions[i],
        paid: units.some((unit) => unit.entryId === id),
      })),
      waiting: units.filter((unit) => !unit.spent).length,
    };
  }
  type Holdings = Awaited<ReturnType<typeof holdings>>;

  const likesOf = ({ cards }: Holdings) =>
    cards.filter((card) => card.decision === "like" || card.decision === "fish").length;
  const ownFishOf = ({ cards }: Holdings) =>
    cards.filter((card) => card.decision === "fish" && !card.paid).length;
  const paidOf = ({ cards }: Holdings) => cards.filter((card) => card.paid).length;

  // Thirty runs of a round and up to ten decisions each, on real Postgres:
  // 2.6 s alone on a laptop, 3 to 7 s on CI's shared arm runner beside the rest
  // of the suite, and twice past the default 15 s on 05/11/2026 (main's 4862a3c8
  // and #612) with nothing it runs changed. So a ceiling of its own.
  test("no budget is passed, a unit sits on a standing fish or waits, and a refusal changes nothing", {
    timeout: 60_000,
  }, async ({ ctx }) => {
    const [a, b, c, d, e, x] = await cast(ctx.client, 6);
    if (!a || !b || !c || !d || !e || !x) throw new Error("cast not written");
    const { logger } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => T };
    // The fish twice over, so that the runs reach the week's end and the units.
    const steps = fc.array(
      fc.record({
        position: fc.integer({ min: 1, max: 4 }),
        decision: fc.constantFrom("fish", "like", "fish", "pass"),
      }),
      { minLength: 3, maxLength: 10 },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 2 }),
        steps,
        async (likes, weekSpent, earned, choices) => {
          await ctx.client.query("SAVEPOINT run");
          try {
            await likeBudget(ctx.client, likes);
            if (weekSpent) await sentBefore(ctx.client, a, x, 3, true);
            await earnedUnits(ctx.client, a.accountId, { fish: earned }, daysBefore(1));
            const entries = await roundOf(ctx.client, a, [
              b,
              c,
              d,
              { person: e, reason: "liked_you" },
            ]);
            const weekOf = (held: Holdings) => (weekSpent ? WEEK : 0) + ownFishOf(held);
            for (const choice of choices) {
              const i = choice.position - 1;
              const before = await holdings(ctx.client, entries, a.accountId);
              const outcome = await watched(
                decide(
                  deps,
                  MATCHES,
                  fitsAt(() => T),
                  {
                    accountId: a.accountId,
                    day: TODAY,
                    ...choice,
                  },
                ),
              ).outcome;
              const after = await holdings(ctx.client, entries, a.accountId);
              if (typeof outcome === "string") {
                expect(after).toEqual(before);
                if (outcome === "like_budget_exceeded") {
                  expect(["like", "fish"]).not.toContain(before.cards[i]?.decision);
                  expect(likesOf(before)).toBe(likes);
                } else {
                  expect(outcome).toBe("fish_budget_exceeded");
                  expect(before.waiting).toBe(0);
                  expect(weekOf(before)).toBe(WEEK);
                }
                continue;
              }
              expect(likesOf(after)).toBeLessThanOrEqual(likes);
              expect(outcome.likesLeft).toBe(likes - likesOf(after));
              expect(weekOf(after)).toBeLessThanOrEqual(WEEK);
              expect(outcome.fishToSend).toBe(weekOf(after) < WEEK || after.waiting > 0);
              expect(after.waiting + paidOf(after)).toBe(earned);
              expect(after.cards.filter((card) => card.paid && card.decision !== "fish")).toEqual(
                [],
              );
              // A unit goes only once the week's own has gone.
              if (after.cards[i]?.paid && !before.cards[i]?.paid) {
                expect(weekOf(before)).toBe(WEEK);
              }
              // The last card answers a like: a fish on it is a like, and takes no unit.
              expect(after.cards[3]).toMatchObject({ paid: false });
              expect(after.cards[3]?.decision).not.toBe("fish");
            }
          } finally {
            await ctx.client.query("ROLLBACK TO SAVEPOINT run");
          }
        },
      ),
      { numRuns: 30, seed: 503 },
    );
  });
});

describe("two devices", () => {
  test("A pass that gives an earned fish back and a fish on another device are taken one after the other", async () => {
    await withTwoConnections("kuutti-107-give-back", async (pool, first, second) => {
      const ids = await peopleWhoFit(pool, 4);
      const [a, x, c, d] = ids;
      if (!a || !x || !c || !d) throw new Error("cast not written");
      const person = (id: string) => ({ accountId: id, headers: { authorization: "" } });
      const owner = person(a);
      await sentBefore(pool, owner, person(x), 3, true);
      await earnedUnits(pool, a, { fish: 1 });
      const entries = await roundOf(pool, owner, [person(c), person(d)]);
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const choice = (position: number, decision: "fish" | "pass") => ({
        accountId: a,
        day: TODAY,
        position,
        decision,
      });
      const fits = fitsAt(() => T);
      await decide(deps(pool), MATCHES, fits, choice(1, "fish"));
      expect(await unitsOf(pool, a)).toEqual([{ kind: "fish", spent: true, entryId: entries[0] }]);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's pass holds the round's row and has given the unit back; the other's fish waits.
      await decide(deps(first), MATCHES, fits, choice(1, "pass"));
      const racing = watched(decide(deps(second), MATCHES, fits, choice(2, "fish")));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toEqual({
        match: null,
        fishToSend: false,
        likesLeft: 9,
        yourTurn: 0,
      });
      await second.query("COMMIT");
      expect(await decisionsOf(pool, entries)).toEqual(["pass", "fish"]);
      expect(await unitsOf(pool, a)).toEqual([{ kind: "fish", spent: true, entryId: entries[1] }]);
    });
  });
});
