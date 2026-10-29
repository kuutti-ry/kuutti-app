import type { Queryable } from "@kuutti/db";
import { ErrorResponse, RoundDecisionAnswer, RoundResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { conversationBetween, openConversation } from "../chat/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signInAs } from "../test/account.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { earnedUnits, unitsOf } from "../test/invitations.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { decide, type Matches, saveRound } from "./rounds.ts";

// Earned likes and fish in today's round (#107, ADR-044 §8,
// features/matching/earned.feature): a unit used by itself past the day's or
// the window's budget, given back by a changed decision, left out of the
// counts once it paid; free likes spend nothing; a refusal spends nothing;
// and a give-back racing a spend on another device. How a unit is earned is
// jobs/invitation-count.test.ts.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = finnishDay(T);
const MATCHES: Matches = { between: conversationBetween, open: openConversation };

type Person = { accountId: string; headers: { authorization: string } };
type Card = Person | { person: Person; reason: "liked_you" };

const daysBefore = (days: number) => new Date(T.getTime() - days * DAY_MS);

async function appAt(db: Queryable): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => T });
}

async function cast(db: Queryable, count: number): Promise<Person[]> {
  const ids = await people(db, null, count, { complete: true, consented: true });
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** A round for `owner` `days` before today with these cards, matching every filter unless said; the entries' ids in order. */
async function roundOf(db: Queryable, owner: Person, cards: Card[], days = 0): Promise<string[]> {
  const at = daysBefore(days);
  const built = await saveRound(
    { db, logger: (await captureLogger()).logger, now: () => at },
    {
      accountId: owner.accountId,
      day: finnishDay(at),
      ordering: "count",
      entries: cards.map((card) =>
        "person" in card
          ? { candidateId: card.person.accountId, reason: card.reason }
          : { candidateId: card.accountId, reason: "matches_filters" as const },
      ),
    },
  );
  if (!built) throw new Error("round not built");
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM round_entries WHERE round_id = $1 ORDER BY position",
    [built.roundId],
  );
  return rows.map((row) => row.id);
}

/** `sender` sent `to` a fish on a round of `days` before today; the entry's id. */
async function fishBefore(db: Queryable, sender: Person, to: Person, days: number) {
  const [entry] = await roundOf(db, sender, [to], days);
  await db.query(
    "UPDATE round_entries SET decision = 'like', decided_at = $2, fish = true WHERE id = $1",
    [entry, daysBefore(days)],
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

const codeOf = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;

/** What the answer to a decision says of the caller's fish after it (#475). */
async function fishToSendAfter(answer: Response) {
  expect(answer.status).toBe(200);
  return RoundDecisionAnswer.parse(await answer.json()).fishToSend;
}

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

describe("earned likes", () => {
  test("An earned like is used once the day's likes are spent, and the next like without one is refused", async ({
    ctx,
  }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const entries = await roundOf(ctx.client, a, [b, c, d]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "like")).status).toBe(200);
    const refused = await choose(app, a, 3, "like");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("like_budget_exceeded");
    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", "like", null]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: true, entryId: entries[1] },
    ]);
  });

  test("A like changed to a pass gives its earned like back", async ({ ctx }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const entries = await roundOf(ctx.client, a, [b, c, d]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "pass")).status).toBe(200);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: false, entryId: null },
    ]);
    expect((await choose(app, a, 3, "like")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", "pass", "like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: true, entryId: entries[2] },
    ]);
  });

  test("A like an earned like paid for is left out of the day's count", async ({ ctx }) => {
    const [a, b, c, d, e] = await cast(ctx.client, 5);
    if (!a || !b || !c || !d || !e) throw new Error("cast not written");
    await likeBudget(ctx.client, 2);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const entries = await roundOf(ctx.client, a, [b, c, d, e]);
    const app = await appAt(ctx.client);

    for (const position of [1, 2, 3]) {
      expect((await choose(app, a, position, "like")).status).toBe(200);
    }
    expect((await choose(app, a, 1, "pass")).status).toBe(200);
    // Counted are C alone, D being paid for: E is within the day's two.
    expect((await choose(app, a, 4, "like")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["pass", "like", "like", "like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: true, entryId: entries[2] },
    ]);
  });

  test("the oldest earned like goes first, one a like", async ({ ctx }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await likeBudget(ctx.client, 0);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 }, daysBefore(2));
    await earnedUnits(ctx.client, a.accountId, { likes: 1 }, daysBefore(5));
    const entries = await roundOf(ctx.client, a, [b, c, d]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: true, entryId: entries[0] },
      { kind: "like", spent: false, entryId: null },
    ]);
    expect((await choose(app, a, 2, "like")).status).toBe(200);
    expect((await choose(app, a, 3, "like")).status).toBe(429);
  });

  test("A like back on a liked-you card never spends an earned like", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const entries = await roundOf(ctx.client, a, [{ person: b, reason: "liked_you" }, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 2, "like")).status).toBe(200);
    expect((await choose(app, a, 1, "like")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", "like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: false, entryId: null },
    ]);
  });
});

describe("earned fish", () => {
  test("An earned fish is used once the window's fish are sent, and the next without one is refused", async ({
    ctx,
  }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await fishBefore(ctx.client, a, x, 3);
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
    const paid = await fishBefore(ctx.client, a, x, 1);
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
      { kind: "fish", spent: false, entryId: null },
    ]);
  });

  test("A fish changed to a like gives its earned fish back, and a like made a fish keeps its earned like", async ({
    ctx,
  }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await fishBefore(ctx.client, a, x, 3);
    await earnedUnits(ctx.client, a.accountId, { likes: 1, fish: 1 });
    const entries = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "fish")).status).toBe(200);
    const spent = await unitsOf(ctx.client, a.accountId);
    expect(spent.map((u) => [u.kind, u.entryId])).toEqual([
      ["fish", entries[1]],
      ["like", entries[1]],
    ]);
    expect((await choose(app, a, 2, "like")).status).toBe(200);

    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", "like"]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "fish", spent: false, entryId: null },
      { kind: "like", spent: true, entryId: entries[1] },
    ]);
    // A pass then gives back what is left on it.
    expect((await choose(app, a, 2, "pass")).status).toBe(200);
    expect((await unitsOf(ctx.client, a.accountId)).every((u) => !u.spent)).toBe(true);
  });

  test("a fish refused past both budgets spends neither the earned like nor anything else", async ({
    ctx,
  }) => {
    const [a, b, c, x] = await cast(ctx.client, 4);
    if (!a || !b || !c || !x) throw new Error("cast not written");
    await likeBudget(ctx.client, 1);
    await fishBefore(ctx.client, a, x, 3);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const entries = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "like")).status).toBe(200);
    // The like's budget takes the earned like, then the window refuses the fish: all rolled back.
    const refused = await choose(app, a, 2, "fish");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("fish_budget_exceeded");
    expect(await decisionsOf(ctx.client, entries)).toEqual(["like", null]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: false, entryId: null },
    ]);
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
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await likeBudget(ctx.client, 0);
    await earnedUnits(ctx.client, a.accountId, { likes: 1 });
    const [entry] = await roundOf(ctx.client, a, [b]);
    expect((await choose(await appAt(ctx.client), a, 1, "like")).status).toBe(200);
    await ctx.client.query("DELETE FROM round_entries WHERE id = $1", [entry]);
    expect(await unitsOf(ctx.client, a.accountId)).toEqual([
      { kind: "like", spent: true, entryId: null },
    ]);
  });
});

describe("two devices", () => {
  test("A pass that gives an earned like back and a like on another device are taken one after the other", async () => {
    await withTwoConnections("kuutti-107-give-back", async (pool, first, second) => {
      const ids = await people(pool, null, 4, { complete: true, consented: true });
      const [a, b, c, d] = ids;
      if (!a || !b || !c || !d) throw new Error("cast not written");
      await likeBudget(pool, 1);
      await earnedUnits(pool, a, { likes: 1 });
      const owner = { accountId: a, headers: { authorization: "" } };
      const person = (id: string) => ({ accountId: id, headers: { authorization: "" } });
      const entries = await roundOf(pool, owner, [person(b), person(c), person(d)]);
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const choice = (position: number, decision: "like" | "pass") => ({
        accountId: a,
        day: TODAY,
        position,
        decision,
      });
      await decide(deps(pool), MATCHES, choice(1, "like"));
      await decide(deps(pool), MATCHES, choice(2, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's pass holds the round's row and has given the unit back; the other's like waits.
      await decide(deps(first), MATCHES, choice(2, "pass"));
      const racing = watched(decide(deps(second), MATCHES, choice(3, "like")));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toEqual({ match: null, fishToSend: true });
      await second.query("COMMIT");
      expect(await decisionsOf(pool, entries)).toEqual(["like", "pass", "like"]);
      expect(await unitsOf(pool, a)).toEqual([{ kind: "like", spent: true, entryId: entries[2] }]);
    });
  });
});
