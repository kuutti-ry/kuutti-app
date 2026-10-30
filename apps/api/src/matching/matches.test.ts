import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { ConversationList, ErrorResponse, RoundDecisionAnswer } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { archiveJob, conversationBetween, openConversation } from "../chat/index.ts";
import {
  CURRENT_CONSENT_VERSIONS,
  eraseAccount,
  lockAccountForSanction,
} from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signInAs } from "../test/account.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { decide, type Matches, saveRound } from "./rounds.ts";

// The match (#100, ADR-038, features/matching/matches.feature): two likes
// make a conversation in the statement of the second, the answer names it,
// a like that made one is final, the expiry, the same moment, the archive of
// a silent match, the events, and what keeps a match from being made.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = finnishDay(T);
const MATCHES: Matches = { between: conversationBetween, open: openConversation };

type Person = { accountId: string; headers: { authorization: string } };

const daysBefore = (days: number) => new Date(T.getTime() - days * DAY_MS);

async function appAt(db: Queryable, at: Date = T): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => at });
}

async function cast(db: Queryable, count: number): Promise<Person[]> {
  const ids = await people(db, null, count, { complete: true, consented: true });
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** A round for `owner` on the day `days` before today, these people its cards, in order. */
async function roundOf(db: Queryable, owner: Person, cards: Person[], days = 0) {
  const at = daysBefore(days);
  const built = await saveRound(
    { db, logger: (await captureLogger()).logger, now: () => at },
    {
      accountId: owner.accountId,
      day: finnishDay(at),
      ordering: "count",
      entries: cards.map((card) => ({ candidateId: card.accountId, reason: "matches_filters" })),
    },
  );
  if (!built) throw new Error("round not built");
  return built.roundId;
}

/** `liker` liked `liked` on a round of `days` before today. */
async function likedBefore(db: Queryable, liker: Person, liked: Person, days: number) {
  const roundId = await roundOf(db, liker, [liked], days);
  await db.query(
    "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
    [roundId, daysBefore(days)],
  );
}

const decideBy = (app: App, who: Person, position: number, decision: string, day = TODAY) =>
  app.request(`/rounds/${day}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

async function answered(response: Response) {
  expect(response.status).toBe(200);
  return RoundDecisionAnswer.parse(await response.json()).match;
}

async function conversationsOf(app: App, who: Person) {
  const response = await app.request("/conversations?thumbs=false", { headers: who.headers });
  expect(response.status).toBe(200);
  const list = ConversationList.parse(await response.json());
  return [...list.open, ...list.archived];
}

async function between(db: Queryable, a: Person, b: Person): Promise<number> {
  const { rows } = await db.query(
    `SELECT 1 FROM conversation_participant x
       JOIN conversation_participant y ON y.conversation_id = x.conversation_id AND y.side <> x.side
      WHERE x.account_id = $1 AND y.account_id = $2`,
    [a.accountId, b.accountId],
  );
  return rows.length;
}

async function joinStudy(app: App, who: Person) {
  const answer = await app.request("/consents", {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "research",
      version: CURRENT_CONSENT_VERSIONS.research,
      locale: "fi",
    }),
  });
  expect(answer.status).toBe(200);
}

describe("a match", () => {
  test("Two likes make a match, and the match is a conversation for both", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    const match = await answered(await decideBy(app, a, 1, "like"));

    expect(match).not.toBeNull();
    expect((await conversationsOf(app, a)).map((c) => c.id)).toEqual([match?.conversationId]);
    expect((await conversationsOf(app, b)).map((c) => c.id)).toEqual([match?.conversationId]);
    // The earlier liker on side a, the conversation opened at the second like.
    const { rows } = await ctx.client.query<{ account_id: string; side: string }>(
      "SELECT account_id, side FROM conversation_participant WHERE conversation_id = $1 ORDER BY side",
      [match?.conversationId],
    );
    expect(rows).toEqual([
      { account_id: b.accountId, side: "a" },
      { account_id: a.accountId, side: "b" },
    ]);
  });

  test("A like that meets no like makes no match, and says nothing of the other", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect(await answered(await decideBy(app, a, 1, "like"))).toBeNull();
    expect(await conversationsOf(app, b)).toEqual([]);
    expect(await between(ctx.client, a, b)).toBe(0);
  });

  test("a pass answers no match, and a pass after another's like makes none", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    expect(await answered(await decideBy(await appAt(ctx.client), a, 1, "pass"))).toBeNull();
    expect(await between(ctx.client, a, b)).toBe(0);
  });

  test("Two likes of the same day make one match, whichever comes second", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    await roundOf(ctx.client, b, [a]);
    const app = await appAt(ctx.client);

    expect(await answered(await decideBy(app, a, 1, "like"))).toBeNull();
    const match = await answered(await decideBy(app, b, 1, "like"));

    expect(match).not.toBeNull();
    expect(await answered(await decideBy(app, a, 1, "like"))).toEqual(match);
    expect(await between(ctx.client, a, b)).toBe(1);
  });

  test("A like that made a match is final", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    await roundOf(ctx.client, b, [a]);
    const app = await appAt(ctx.client);
    await decideBy(app, a, 1, "like");
    await answered(await decideBy(app, b, 1, "like"));

    for (const who of [a, b]) {
      const refused = await decideBy(app, who, 1, "pass");
      expect(refused.status).toBe(409);
      expect(ErrorResponse.parse(await refused.json()).error.code).toBe("match_made");
    }
    const { rows } = await ctx.client.query<{ decision: string }>(
      `SELECT e.decision FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = ANY($1::uuid[])`,
      [[a.accountId, b.accountId]],
    );
    expect(rows.map((row) => row.decision)).toEqual(["like", "like"]);
    expect(await between(ctx.client, a, b)).toBe(1);
  });

  test("the refusal of a final like is said in the request's language", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    await answered(await decideBy(app, a, 1, "like"));
    const refused = await app.request(`/rounds/${TODAY}/entries/1/decision`, {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json", "accept-language": "fi" },
      body: JSON.stringify({ decision: "pass" }),
    });
    expect(refused.status).toBe(409);
    expect(ErrorResponse.parse(await refused.json()).error.message).toBe(
      "Tästä tykkäyksestä tuli mätsi, joten se pysyy. Voit silti lopettaa keskustelun Keskusteluissa.",
    );
  });

  test("A like taken back before the other's makes no match", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    await roundOf(ctx.client, b, [a]);
    const app = await appAt(ctx.client);
    await answered(await decideBy(app, a, 1, "like"));
    await answered(await decideBy(app, a, 1, "pass"));

    expect(await answered(await decideBy(app, b, 1, "like"))).toBeNull();
    expect(await between(ctx.client, a, b)).toBe(0);
  });

  describe("A like makes a match with a like that has not expired", () => {
    test.for([
      { days: 13, outcome: "the answer names a match" },
      { days: 14, outcome: "the answer has no match" },
    ])("$days days ago: $outcome", async ({ days, outcome }, { ctx }) => {
      const [a, b] = await cast(ctx.client, 2);
      if (!a || !b) throw new Error("cast not written");
      await likedBefore(ctx.client, b, a, days);
      await roundOf(ctx.client, a, [b]);

      const match = await answered(await decideBy(await appAt(ctx.client), a, 1, "like"));

      if (outcome.includes("names")) expect(match).not.toBeNull();
      else expect(match).toBeNull();
    });
  });

  test("no match is made while the person is shadow-banned, and none through a block", async ({
    ctx,
  }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      a.accountId,
    ]);
    const app = await appAt(ctx.client);
    // The shadow-banned person's like is recorded as any like, and opens nothing.
    expect(await answered(await decideBy(app, a, 1, "like"))).toBeNull();
    expect(await between(ctx.client, a, b)).toBe(0);

    await likedBefore(ctx.client, d, c, 1);
    await roundOf(ctx.client, c, [d]);
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
      [d.accountId, c.accountId],
    );
    expect((await decideBy(app, c, 1, "like")).status).toBe(404);
    expect(await between(ctx.client, c, d)).toBe(0);
  });

  test("a match is a match event for each of the two, saying whose like made it", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const earlier = await appAt(ctx.client, new Date(T.getTime() - 60_000));
    await joinStudy(earlier, a);
    await joinStudy(earlier, b);
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);

    await answered(await decideBy(await appAt(ctx.client), a, 1, "like"));

    // Each event by whose it is: the one whose like made the match says so.
    const { rows } = await ctx.client.query<{ account_id: string; props: { completed: boolean } }>(
      `SELECT s.account_id, e.props FROM events e
         JOIN research_subject s ON s.research_id = e.research_id
        WHERE e.name = 'match'`,
    );
    expect(rows).toHaveLength(2);
    expect(Object.fromEntries(rows.map((row) => [row.account_id, row.props]))).toEqual({
      [a.accountId]: { completed: true },
      [b.accountId]: { completed: false },
    });
  });

  test("A match nobody writes in is put away after silent_match_archive_days, and a message keeps it", async ({
    ctx,
  }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    // Both matches eight days ago, as the second like of each made them.
    const eightDaysAgo = await appAt(ctx.client, daysBefore(8));
    for (const [first, second] of [
      [a, b],
      [c, d],
    ] as const) {
      await likedBefore(ctx.client, first, second, 9);
      await roundOf(ctx.client, second, [first], 8);
      await answered(await decideBy(eightDaysAgo, second, 1, "like", finnishDay(daysBefore(8))));
    }
    const cd = await conversationBetween(ctx.client, c.accountId, d.accountId);
    const sent = await (await appAt(ctx.client, daysBefore(1))).request(
      `/conversations/${cd}/messages`,
      {
        method: "POST",
        headers: { ...c.headers, "content-type": "application/json" },
        body: JSON.stringify({ clientId: randomUUID(), body: "Hei! Mitä kuuluu?" }),
      },
    );
    expect(sent.status).toBe(201);

    const { logger } = await captureLogger();
    expect(await archiveJob({ db: ctx.client, logger, now: () => T }).run()).toEqual({
      archived: 1,
    });

    const ab = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const { rows } = await ctx.client.query<{ id: string; archived: boolean }>(
      "SELECT id, archived_at IS NOT NULL AS archived FROM conversation WHERE id = ANY($1::uuid[])",
      [[ab, cd]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.archived]))).toEqual({
      [ab ?? ""]: true,
      [cd ?? ""]: false,
    });
  });

  test("an erasure takes the person's likes, and ends the match for the other", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    const match = await answered(await decideBy(app, a, 1, "like"));
    const { logger } = await captureLogger();

    await eraseAccount({ db: ctx.client, logger, now: () => T }, b.accountId);

    const { rows } = await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [
      b.accountId,
    ]);
    expect(rows).toHaveLength(0);
    expect((await conversationsOf(app, a)).map((c) => [c.id, c.state])).toEqual([
      [match?.conversationId, "closed"],
    ]);
  });
});

describe("the same moment", () => {
  test("Two likes at the same moment make exactly one match", async () => {
    await withTwoConnections("kuutti-100-match", async (pool, first, second) => {
      const ids = await people(pool, null, 2, { complete: true, consented: true });
      const [a, b] = ids;
      if (!a || !b) throw new Error("cast not written");
      const deps = { db: pool, logger: (await captureLogger()).logger, now: () => T };
      for (const [owner, card] of [
        [a, b],
        [b, a],
      ] as const) {
        await saveRound(deps, {
          accountId: owner,
          day: TODAY,
          ordering: "count",
          entries: [{ candidateId: card, reason: "matches_filters" }],
        });
      }
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A's like holds the pair; B's, at the same moment, waits for it and then reads it.
      const one = await decide({ ...deps, db: first }, MATCHES, {
        accountId: a,
        day: TODAY,
        position: 1,
        decision: "like",
      });
      const other = watched(
        decide({ ...deps, db: second }, MATCHES, {
          accountId: b,
          day: TODAY,
          position: 1,
          decision: "like",
        }),
      );
      expect(await waitsFor(pool, secondPid, firstPid, other.settled)).toBe(true);
      await first.query("COMMIT");
      const answer = await other.outcome;
      await second.query("COMMIT");

      expect(one.match).toBeNull();
      expect(typeof answer === "object" && answer.match).toBeTruthy();
      const { rows } = await pool.query("SELECT 1 FROM conversation_participant WHERE side = 'a'");
      expect(rows).toHaveLength(1);
    });
  });

  /** Two people, each the card of the other's round today, on a database of their own. */
  async function eachOthersCard(pool: Queryable) {
    const ids = await people(pool, null, 2, { complete: true, consented: true });
    const [a, b] = ids;
    if (!a || !b) throw new Error("cast not written");
    const deps = { db: pool, logger: (await captureLogger()).logger, now: () => T };
    for (const [owner, card] of [
      [a, b],
      [b, a],
    ] as const) {
      await saveRound(deps, {
        accountId: owner,
        day: TODAY,
        ordering: "count",
        entries: [{ candidateId: card, reason: "matches_filters" }],
      });
    }
    return { a, b, deps };
  }

  const choice = (accountId: string, decision: "like" | "pass") => ({
    accountId,
    day: TODAY,
    position: 1,
    decision,
  });

  test("a like taken back while the other's like makes the match is refused as match_made", async () => {
    await withTwoConnections("kuutti-100-take-back", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, choice(a, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // B's like back holds the pair and opens the conversation, not yet committed.
      expect(
        (await decide({ ...deps, db: first }, MATCHES, choice(b, "like"))).match,
      ).not.toBeNull();
      const taking = watched(decide({ ...deps, db: second }, MATCHES, choice(a, "pass")));
      expect(await waitsFor(pool, secondPid, firstPid, taking.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await taking.outcome).toBe("match_made");
      // Committed, so the checks below would see anything the refusal wrote.
      await second.query("COMMIT");
      const { rows } = await pool.query<{ decision: string }>(
        `SELECT e.decision FROM round_entries e JOIN rounds r ON r.id = e.round_id
          WHERE r.account_id = $1`,
        [a],
      );
      expect(rows).toEqual([{ decision: "like" }]);
      expect(
        (await pool.query("SELECT 1 FROM conversation_participant WHERE side = 'a'")).rows,
      ).toHaveLength(1);
    });
  });

  test("a like taken back first leaves the other's like, which waited for it, no match", async () => {
    await withTwoConnections("kuutti-100-taken-first", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, choice(a, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A takes the like back and holds the pair; B's like back waits, then finds no like.
      expect((await decide({ ...deps, db: first }, MATCHES, choice(a, "pass"))).match).toBeNull();
      const liking = watched(decide({ ...deps, db: second }, MATCHES, choice(b, "like")));
      expect(await waitsFor(pool, secondPid, firstPid, liking.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await liking.outcome).toEqual({ match: null, fishToSend: true, likesLeft: 9 });
      await second.query("COMMIT");
      expect((await pool.query("SELECT 1 FROM conversation")).rows).toHaveLength(0);
    });
  });

  test("an erasure that starts while a match opens waits for it, and then ends the match", async () => {
    await withTwoConnections("kuutti-100-erasure", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, choice(b, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      // A's like back pauses before it writes the conversation's people, its
      // entry written: the moment an erasure taking B's account would cross it.
      let reached: () => void = () => {};
      const atOpening = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let go: () => void = () => {};
      const resume = new Promise<void>((resolve) => {
        go = resolve;
      });
      const paused: Queryable = {
        query: (async (text: string, values?: unknown[]) => {
          if (String(text).includes("INSERT INTO conversation_participant")) {
            reached();
            await resume;
          }
          return first.query(text, values);
        }) as Queryable["query"],
      };
      await first.query("BEGIN");
      await second.query("BEGIN");
      const liking = watched(decide({ ...deps, db: paused }, MATCHES, choice(a, "like")));
      await atOpening;
      const erasing = watched(eraseAccount({ ...deps, db: second }, b));
      // The erasure waits for the like before it touches anything of a round.
      expect(await waitsFor(pool, secondPid, firstPid, erasing.settled)).toBe(true);
      go();
      const liked = await liking.outcome;
      expect(typeof liked === "object" && liked.match).toBeTruthy();
      await first.query("COMMIT");
      const erased = await erasing.outcome;
      expect(typeof erased).toBe("object");
      await second.query("COMMIT");
      // The match opened, and the erasure closed it for A, who keeps it.
      const { rows } = await pool.query<{ closed: boolean }>(
        "SELECT closed_at IS NOT NULL AS closed FROM conversation",
      );
      expect(rows).toEqual([{ closed: true }]);
    });
  });

  test("a sanction under way is waited for, and opens no match with its person", async () => {
    await withTwoConnections("kuutti-100-sanction", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, choice(b, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A sanction under way: B's accounts and identity under its lock
      // (lockAccountForSanction, identity/standing.ts), B's state changed, not yet committed.
      expect(await lockAccountForSanction(first, b)).not.toBeNull();
      await first.query("UPDATE account SET state = 'suspended' WHERE id = $1", [b]);
      const liking = watched(decide({ ...deps, db: second }, MATCHES, choice(a, "like")));
      expect(await waitsFor(pool, secondPid, firstPid, liking.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await liking.outcome).toBe("not_found");
      await second.query("COMMIT");
      expect((await pool.query("SELECT 1 FROM conversation")).rows).toHaveLength(0);
    });
  });
});
