import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  ConversationList,
  ErrorResponse,
  RoundDecisionAnswer,
  type RoundReason,
  RoundResponse,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { archiveJob, conversationBetween } from "../chat/index.ts";
import {
  CURRENT_CONSENT_VERSIONS,
  eraseAccount,
  lockAccountForSanction,
} from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import {
  conversationsWaiting,
  endedConversation,
  fitsAt,
  type LoggedCard,
  logged,
  MATCHES,
  peopleWhoFit,
  pondOfPerson,
  shownAt,
} from "../test/rounds.ts";
import { decide } from "./rounds.ts";

// The match (#100, ADR-038, features/matching/matches.feature): two likes
// make a conversation in the statement of the second, the answer names it,
// a like that made one is final, the expiry, the same moment, the archive of
// a silent match, the events, what keeps a match from being made, a second
// match (ADR-062 §7) and the your-turn limit (§5). Which conversations are on a
// person's turn is chat/your-turn.test.ts.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = finnishDay(T);
const FITS = fitsAt(() => T);

type Person = { accountId: string; headers: { authorization: string } };

const daysBefore = (days: number) => new Date(T.getTime() - days * DAY_MS);

async function appAt(db: Queryable, at: Date = T): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => at });
}

async function cast(db: Queryable, count: number): Promise<Person[]> {
  const ids = await peopleWhoFit(db, count);
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** A round for `owner` on the day `days` before today, these people its cards, in order. */
const roundOf = (
  db: Queryable,
  owner: Person,
  cards: (Person | { person: Person; reason: RoundReason })[],
  days = 0,
) =>
  logged(
    db,
    owner.accountId,
    finnishDay(daysBefore(days)),
    cards.map(
      (card): LoggedCard =>
        "person" in card
          ? { candidateId: card.person.accountId, reason: card.reason }
          : card.accountId,
    ),
  );

/** `liker` liked `liked` on a round of `days` before today, a fish if said. */
async function likedBefore(
  db: Queryable,
  liker: Person,
  liked: Person,
  days: number,
  fish = false,
) {
  const roundId = await roundOf(db, liker, [liked], days);
  await db.query(
    "UPDATE round_entries SET decision = 'like', decided_at = $2, fish = $3 WHERE round_id = $1",
    [roundId, daysBefore(days), fish],
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

/** The decision on each card of a round, in order. */
async function decisionsIn(db: Queryable, roundId: string) {
  const { rows } = await db.query<{ decision: string | null }>(
    "SELECT decision FROM round_entries WHERE round_id = $1 ORDER BY position",
    [roundId],
  );
  return rows.map((row) => row.decision);
}

const refusal = async (response: Response) => {
  expect(response.status).toBe(409);
  return ErrorResponse.parse(await response.json()).error;
};

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
      for (const decision of ["pass", "skip"]) {
        const refused = await decideBy(app, who, 1, decision);
        expect(refused.status).toBe(409);
        expect(ErrorResponse.parse(await refused.json()).error.code).toBe("match_made");
      }
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

  test("Only a new like makes a match, so a like made a fish opens nothing", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    await roundOf(ctx.client, b, [a]);
    const app = await appAt(ctx.client);
    expect(await answered(await decideBy(app, a, 1, "like"))).toBeNull();
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [
      b.accountId,
    ]);
    expect(await answered(await decideBy(app, b, 1, "like"))).toBeNull();
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [b.accountId]);

    expect(await answered(await decideBy(app, a, 1, "fish"))).toBeNull();
    expect(await between(ctx.client, a, b)).toBe(0);
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
    const cd = await conversationBetween(ctx.client, c.accountId, d.accountId, daysBefore(8));
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

    const opened = await ctx.client.query<{ id: string }>(
      "SELECT conversation_id AS id FROM conversation_participant WHERE account_id = $1",
      [a.accountId],
    );
    const ab = opened.rows[0]?.id;
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

describe("a second match (ADR-062 §7)", () => {
  test("A second match opens a new conversation, and closes the one left archived", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const old = await endedConversation(
      ctx.client,
      a.accountId,
      b.accountId,
      daysBefore(90),
      "archived",
    );
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    const match = await answered(await decideBy(app, a, 1, "like"));

    expect(match?.conversationId).toBeDefined();
    expect(match?.conversationId).not.toBe(old);
    const { rows } = await ctx.client.query<{
      id: string;
      closed_how: string | null;
      closed_at: Date | null;
    }>("SELECT id, closed_how, closed_at FROM conversation WHERE id = ANY($1::uuid[])", [
      [old, match?.conversationId],
    ]);
    expect(
      Object.fromEntries(rows.map((row) => [row.id, [row.closed_how, row.closed_at]])),
    ).toEqual({ [old]: ["unmatch", T], [match?.conversationId ?? ""]: [null, null] });
    // Both find the new one to write in, and the old one among the ended.
    for (const who of [a, b]) {
      const list = await conversationsOf(app, who);
      expect(list.find((c) => c.id === match?.conversationId)?.state).toBe("open");
      expect(list.find((c) => c.id === old)?.state).toBe("closed");
    }
  });

  test("A second match after a closed conversation leaves that one as it ended", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const ended = daysBefore(90);
    const old = await endedConversation(ctx.client, a.accountId, b.accountId, ended, "closed");
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [b]);

    const match = await answered(await decideBy(await appAt(ctx.client), a, 1, "like"));

    expect(match?.conversationId).not.toBe(old);
    const { rows } = await ctx.client.query(
      "SELECT closed_at, closed_how, closed_by FROM conversation WHERE id = $1",
      [old],
    );
    expect(rows).toEqual([{ closed_at: ended, closed_how: "unmatch", closed_by: "a" }]);
  });

  describe("A like falls on no old conversation it did not make", () => {
    test.for(["closed", "archived"] as const)("a %s conversation", async (how, { ctx }) => {
      const [a, b] = await cast(ctx.client, 2);
      if (!a || !b) throw new Error("cast not written");
      await endedConversation(ctx.client, a.accountId, b.accountId, daysBefore(90), how);
      const roundId = await roundOf(ctx.client, a, [b]);
      const app = await appAt(ctx.client);

      expect(await answered(await decideBy(app, a, 1, "like"))).toBeNull();

      expect(await between(ctx.client, a, b)).toBe(1);
      // Part of no match, so it is no final like either.
      expect(await answered(await decideBy(app, a, 1, "pass"))).toBeNull();
      expect(await decisionsIn(ctx.client, roundId)).toEqual(["pass"]);
    });
  });

  test("A like that made a match today stays final after the conversation ended", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    await roundOf(ctx.client, b, [a]);
    const app = await appAt(ctx.client);
    await answered(await decideBy(app, a, 1, "like"));
    const match = await answered(await decideBy(app, b, 1, "like"));
    const unmatched = await app.request(`/conversations/${match?.conversationId}/unmatch`, {
      method: "POST",
      headers: a.headers,
    });
    expect(unmatched.status).toBe(204);

    for (const who of [a, b]) {
      expect((await refusal(await decideBy(app, who, 1, "pass"))).code).toBe("match_made");
      // The like again still names the conversation it made.
      expect(await answered(await decideBy(app, who, 1, "like"))).toEqual(match);
    }
  });

  test("the next day an ended match's likes are no answer to anything", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    // Their match of yesterday, ended the same day: opened before today, so it stands for no like.
    await endedConversation(ctx.client, a.accountId, b.accountId, daysBefore(1), "closed");
    await ctx.client.query(
      `UPDATE conversation SET opened_at = $2
        WHERE id = (SELECT conversation_id FROM conversation_participant WHERE account_id = $1)`,
      [a.accountId, daysBefore(1)],
    );
    await roundOf(ctx.client, a, [b]);

    expect(await answered(await decideBy(await appAt(ctx.client), a, 1, "like"))).toBeNull();
  });

  test("a match opened at today's midnight is today's, and one a moment before is not", async ({
    ctx,
  }) => {
    const midnight = new Date("2026-10-15T21:00:00.000Z");
    expect(finnishDay(midnight)).toBe(TODAY);
    for (const [opened, final] of [
      [midnight, true],
      [new Date(midnight.getTime() - 1), false],
    ] as const) {
      const [a, b] = await cast(ctx.client, 2);
      if (!a || !b) throw new Error("cast not written");
      const id = await endedConversation(ctx.client, a.accountId, b.accountId, T, "closed");
      await ctx.client.query("UPDATE conversation SET opened_at = $2 WHERE id = $1", [id, opened]);
      await likedBefore(ctx.client, a, b, 0);

      const answer = await decideBy(await appAt(ctx.client), a, 1, "pass");

      expect(answer.status).toBe(final ? 409 : 200);
    }
  });
});

describe("the your-turn limit (ADR-062 §5)", () => {
  /** "A" in a round of today, with as many conversations on their turn. */
  async function waitingOn(db: Queryable, a: Person, waiting: number) {
    return conversationsWaiting(db, await pondOfPerson(db, a.accountId), a.accountId, waiting);
  }

  describe("A new like at the your-turn limit is refused, whatever the card", () => {
    test.for([
      { waiting: 8, card: "an ordinary card", choice: "a like", answer: "your_turn_limit" },
      { waiting: 8, card: "an ordinary card", choice: "a fish", answer: "your_turn_limit" },
      { waiting: 8, card: "a liked-you card", choice: "a like", answer: "your_turn_limit" },
      { waiting: 8, card: "a liked-you card", choice: "a fish", answer: "your_turn_limit" },
      { waiting: 8, card: "a fish card", choice: "a like", answer: "your_turn_limit" },
      { waiting: 7, card: "an ordinary card", choice: "a like", answer: "recorded" },
      { waiting: 7, card: "an ordinary card", choice: "a fish", answer: "recorded" },
      { waiting: 7, card: "a liked-you card", choice: "a like", answer: "recorded" },
    ])(
      "$waiting waiting, on $card, $choice: $answer",
      async ({ waiting, card, choice, answer }, { ctx }) => {
        const [a, b] = await cast(ctx.client, 2);
        if (!a || !b) throw new Error("cast not written");
        await waitingOn(ctx.client, a, waiting);
        if (card !== "an ordinary card")
          await likedBefore(ctx.client, b, a, 1, card === "a fish card");
        const reason = { "a liked-you card": "liked_you", "a fish card": "fish" }[card] as
          | RoundReason
          | undefined;
        const roundId = await roundOf(ctx.client, a, [reason ? { person: b, reason } : b]);
        const response = await decideBy(
          await appAt(ctx.client),
          a,
          1,
          choice === "a fish" ? "fish" : "like",
        );

        if (answer === "recorded") {
          expect(response.status).toBe(200);
          expect(await decisionsIn(ctx.client, roundId)).toEqual(["like"]);
          // A like back is a match; the other likes wait.
          expect(await between(ctx.client, a, b)).toBe(card === "an ordinary card" ? 0 : 1);
        } else {
          expect((await refusal(response)).code).toBe(answer);
          expect(await decisionsIn(ctx.client, roundId)).toEqual([null]);
          expect(await between(ctx.client, a, b)).toBe(0);
        }
      },
    );
  });

  test("The refusal at the your-turn limit says nothing of the other person", async ({ ctx }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await waitingOn(ctx.client, a, 8);
    await likedBefore(ctx.client, b, a, 1);
    const roundId = await roundOf(ctx.client, a, [b, c, d]);
    await ctx.client.query(
      `UPDATE preferences SET value = '["man"]'::jsonb WHERE account_id = $1 AND field = 'seeks'`,
      [d.accountId],
    );
    const app = await appAt(ctx.client);

    const answers = [];
    for (const position of [1, 2, 3]) {
      const { code, message } = await refusal(await decideBy(app, a, position, "like"));
      answers.push({ code, message });
    }

    // The one who liked "A", the one who did not, and the one who no longer fits: the same words.
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]?.code).toBe("your_turn_limit");
    expect(await decisionsIn(ctx.client, roundId)).toEqual([null, null, null]);
    expect(await between(ctx.client, a, b)).toBe(0);
    // Refused before the budget too: nothing of the day's likes went.
    const read = await app.request("/rounds/today", { headers: a.headers });
    expect(RoundResponse.parse(await read.json()).likesLeft).toBe(10);
  });

  test("the refusal is said in the request's language", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await waitingOn(ctx.client, a, 8);
    await roundOf(ctx.client, a, [b]);

    const refused = await (await appAt(ctx.client)).request(`/rounds/${TODAY}/entries/1/decision`, {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json", "accept-language": "fi" },
      body: JSON.stringify({ decision: "like" }),
    });

    expect((await refusal(refused)).message).toBe(
      "Keskustelut odottavat sinua. Vastaa tai lopeta yksi ensin.",
    );
  });

  test("Neither a pass nor a skip is refused at the your-turn limit", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await waitingOn(ctx.client, a, 8);
    const roundId = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await decideBy(app, a, 1, "pass")).status).toBe(200);
    expect((await decideBy(app, a, 2, "skip")).status).toBe(200);

    expect(await decisionsIn(ctx.client, roundId)).toEqual(["pass", "skip"]);
  });

  test("The your-turn limit lets a like go that is standing already", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);
    expect((await decideBy(app, a, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, 2, "fish")).status).toBe(200);
    await waitingOn(ctx.client, a, 8);

    expect((await decideBy(app, a, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, 2, "like")).status).toBe(200);

    // Taken back and liked again, it is a new like.
    expect((await decideBy(app, a, 1, "pass")).status).toBe(200);
    expect((await refusal(await decideBy(app, a, 1, "like"))).code).toBe("your_turn_limit");
    expect(await decisionsIn(ctx.client, roundId)).toEqual(["pass", "like"]);
  });

  test("A your_turn_limit of 0 is off", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { your_turn_limit: 0 });
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await waitingOn(ctx.client, a, 8);
    const roundId = await roundOf(ctx.client, a, [b]);

    expect((await decideBy(await appAt(ctx.client), a, 1, "like")).status).toBe(200);

    expect(await decisionsIn(ctx.client, roundId)).toEqual(["like"]);
  });

  test("A liked-you card keeps its two weeks at the your-turn limit", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const [other] = await waitingOn(ctx.client, a, 8);
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [{ person: b, reason: "liked_you" }]);
    const app = await appAt(ctx.client);
    expect((await refusal(await decideBy(app, a, 1, "like"))).code).toBe("your_turn_limit");

    // "A" answers one, which takes it off the count.
    const { rows } = await ctx.client.query<{ id: string }>(
      `SELECT mine.conversation_id AS id FROM conversation_participant mine
         JOIN conversation_participant theirs USING (conversation_id)
        WHERE mine.account_id = $1 AND theirs.account_id = $2`,
      [a.accountId, other],
    );
    const sent = await app.request(`/conversations/${rows[0]?.id}/messages`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId: randomUUID(), body: "Anteeksi, vastaan nyt." }),
    });
    expect(sent.status).toBe(201);

    expect(await answered(await decideBy(app, a, 1, "like"))).not.toBeNull();
  });

  test("The read and every decision say how many conversations are on the person's turn", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await waitingOn(ctx.client, a, 2);
    await likedBefore(ctx.client, b, a, 1);
    await roundOf(ctx.client, a, [{ person: b, reason: "liked_you" }]);
    const app = await appAt(ctx.client);

    const read = await app.request("/rounds/today", { headers: a.headers });
    expect(RoundResponse.parse(await read.json()).yourTurn).toBe(2);

    const liked = await decideBy(app, a, 1, "like");
    expect(liked.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await liked.json()).yourTurn).toBe(3);
  });
});

describe("the same moment", () => {
  /** Two people, each the card of the other's round today, on a database of their own. */
  async function eachOthersCard(pool: Queryable) {
    const ids = await peopleWhoFit(pool, 2);
    const [a, b] = ids;
    if (!a || !b) throw new Error("cast not written");
    const deps = { db: pool, logger: (await captureLogger()).logger, now: () => T };
    await logged(pool, a, TODAY, [b]);
    await logged(pool, b, TODAY, [a]);
    return { a, b, deps };
  }

  const choice = (accountId: string, decision: "like" | "pass") => ({
    accountId,
    day: TODAY,
    position: 1,
    decision,
  });

  test("Two likes at the same moment make exactly one match", async () => {
    await withTwoConnections("kuutti-100-match", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A's like holds the pair; B's, at the same moment, waits for it and then reads it.
      const one = await decide({ ...deps, db: first }, MATCHES, FITS, choice(a, "like"));
      const other = watched(decide({ ...deps, db: second }, MATCHES, FITS, choice(b, "like")));
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

  test("two likes back at once cannot pass the your-turn limit together", async () => {
    await withTwoConnections("kuutti-502-limit", async (pool, first, second) => {
      const [a, b, c] = await peopleWhoFit(pool, 3);
      if (!a || !b || !c) throw new Error("cast not written");
      await conversationsWaiting(pool, await pondOfPerson(pool, a), a, 7);
      await shownAt(pool, daysBefore(1), b, a, "like");
      await shownAt(pool, daysBefore(1), c, a, "like");
      await logged(pool, a, TODAY, [
        { candidateId: b, reason: "liked_you" },
        { candidateId: c, reason: "liked_you" },
      ]);
      const deps = { db: pool, logger: (await captureLogger()).logger, now: () => T };
      const likeAt = (position: number) => ({
        accountId: a,
        day: TODAY,
        position,
        decision: "like" as const,
      });
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // The first like back opens the eighth conversation, not yet committed; the other waits for it.
      expect((await decide({ ...deps, db: first }, MATCHES, FITS, likeAt(1))).yourTurn).toBe(8);
      const racing = watched(decide({ ...deps, db: second }, MATCHES, FITS, likeAt(2)));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("your_turn_limit");
      await second.query("COMMIT");
      const { rows } = await pool.query(
        "SELECT 1 FROM conversation_participant WHERE account_id = $1",
        [a],
      );
      expect(rows).toHaveLength(8);
    });
  });

  test("a like taken back while the other's like makes the match is refused as match_made", async () => {
    await withTwoConnections("kuutti-100-take-back", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, FITS, choice(a, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // B's like back holds the pair and opens the conversation, not yet committed.
      expect(
        (await decide({ ...deps, db: first }, MATCHES, FITS, choice(b, "like"))).match,
      ).not.toBeNull();
      const taking = watched(decide({ ...deps, db: second }, MATCHES, FITS, choice(a, "pass")));
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
      await decide(deps, MATCHES, FITS, choice(a, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A takes the like back and holds the pair; B's like back waits, then finds no like.
      expect(
        (await decide({ ...deps, db: first }, MATCHES, FITS, choice(a, "pass"))).match,
      ).toBeNull();
      const liking = watched(decide({ ...deps, db: second }, MATCHES, FITS, choice(b, "like")));
      expect(await waitsFor(pool, secondPid, firstPid, liking.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await liking.outcome).toEqual({
        match: null,
        fishToSend: true,
        likesLeft: 9,
        yourTurn: 0,
      });
      await second.query("COMMIT");
      expect((await pool.query("SELECT 1 FROM conversation")).rows).toHaveLength(0);
    });
  });

  test("an erasure that starts while a match opens waits for it, and then ends the match", async () => {
    await withTwoConnections("kuutti-100-erasure", async (pool, first, second) => {
      const { a, b, deps } = await eachOthersCard(pool);
      await decide(deps, MATCHES, FITS, choice(b, "like"));
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
      const liking = watched(decide({ ...deps, db: paused }, MATCHES, FITS, choice(a, "like")));
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
      await decide(deps, MATCHES, FITS, choice(b, "like"));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // A sanction under way: B's accounts and identity under its lock
      // (lockAccountForSanction, identity/standing.ts), B's state changed, not yet committed.
      expect(await lockAccountForSanction(first, b)).not.toBeNull();
      await first.query("UPDATE account SET state = 'suspended' WHERE id = $1", [b]);
      const liking = watched(decide({ ...deps, db: second }, MATCHES, FITS, choice(a, "like")));
      expect(await waitsFor(pool, secondPid, firstPid, liking.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await liking.outcome).toBe("not_found");
      await second.query("COMMIT");
      expect((await pool.query("SELECT 1 FROM conversation")).rows).toHaveLength(0);
    });
  });
});
