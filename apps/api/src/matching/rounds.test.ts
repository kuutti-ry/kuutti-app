import type { Queryable } from "@kuutti/db";
import { ErrorResponse, RoundResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { conversationBetween, openConversation } from "../chat/index.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount, exportAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { ensureEventPartitions } from "../research/index.ts";
import { signInAs } from "../test/account.ts";
import { interleaved } from "../test/chat.ts";
import {
  test as base,
  captureLogger,
  describe,
  englishT,
  expect,
  type TestContext,
  testConfig,
} from "../test/harness.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { decide, type Matches, type RoundDeps, saveRound } from "./rounds.ts";

// Today's round (#96, features/matching/decisions.feature): the read, seen
// and decided, a decision changed and the day's end, a card that can no
// longer be shown, completion, two devices at once, the caller's own round
// only, erasure of both sides, the export, and the research events. Rounds
// are written through saveRound, the round builder's (#95) one writer.

/** 12:00 in Finland, one Friday: the round's day is 2026-10-16. */
const T = new Date("2026-10-16T09:00:00.000Z");
const TODAY = finnishDay(T);
const YESTERDAY = "2026-10-15";
const SECOND = 1000;
/** A match's conversation, as app.ts hands it in (#100). */
const MATCHES: Matches = { between: conversationBetween, open: openConversation };

type Person = { accountId: string; headers: { authorization: string } };

/** A clock a second later at each reading, from T. */
function ticking(): () => Date {
  let t = T.getTime();
  return () => {
    t += SECOND;
    return new Date(t);
  };
}

async function appOn(db: Queryable, now: () => Date = ticking()): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now });
}

const test = base.extend<{ app: App }>({
  app: async ({ ctx }, use) => {
    await use(await appOn(ctx.client));
  },
});

async function depsOn(db: Queryable, now: () => Date = () => T): Promise<RoundDeps> {
  return { db, logger: (await captureLogger()).logger, now };
}

/** Complete, active people the round can show; the first `viewers` of them signed in. */
async function cast(ctx: TestContext, count: number): Promise<Person[]> {
  const ids = await people(ctx.client, null, count, { complete: true, consented: true });
  return Promise.all(ids.map((id) => signInAs(ctx.client, id)));
}

const today = (app: App, who: Person) => app.request("/rounds/today", { headers: who.headers });
const seen = (app: App, who: Person, day: string, position: number) =>
  app.request(`/rounds/${day}/entries/${position}/seen`, { method: "POST", headers: who.headers });
const decideBy = (app: App, who: Person, day: string, position: number, decision: string) =>
  app.request(`/rounds/${day}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

async function readToday(app: App, who: Person): Promise<RoundResponse> {
  const answer = await today(app, who);
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

async function errorCode(answer: Response): Promise<string> {
  return ErrorResponse.parse(await answer.json()).error.code;
}

/** A round for `owner` on `day` with these cards, all matching every filter unless said. */
async function roundFor(
  db: Queryable,
  owner: Person,
  cards: (Person | { person: Person; reason: "liked_you" | "seen_before" | "relaxed" })[],
  day = TODAY,
) {
  const built = await saveRound(await depsOn(db), {
    accountId: owner.accountId,
    day,
    ordering: "count",
    entries: cards.map((card) =>
      "person" in card
        ? { candidateId: card.person.accountId, reason: card.reason }
        : { candidateId: card.accountId, reason: "matches_filters" as const },
    ),
  });
  if (!built) throw new Error("round not built");
  return built.roundId;
}

async function entriesOf(db: Queryable, roundId: string) {
  return (
    await db.query<{
      position: number;
      candidate_id: string;
      seen_at: Date | null;
      decision: string | null;
      decided_at: Date | null;
    }>(
      `SELECT position, candidate_id, seen_at, decision, decided_at FROM round_entries
        WHERE round_id = $1 ORDER BY position`,
      [roundId],
    )
  ).rows;
}

async function eventsOf(db: Queryable, name: string) {
  return (
    await db.query<{ props: Record<string, unknown> }>(
      "SELECT props FROM events WHERE name = $1 ORDER BY at, id",
      [name],
    )
  ).rows.map((row) => row.props);
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

async function block(db: Queryable, blocker: Person, blocked: Person) {
  await db.query(
    `INSERT INTO block (blocker_identity_id, blocked_identity_id)
     SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
    [blocker.accountId, blocked.accountId],
  );
}

describe("reading today's round", () => {
  test("Today's round shows its cards in order, each with its reason and the person's own decision", async ({
    ctx,
    app,
  }) => {
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [
      b,
      { person: c, reason: "liked_you" },
      { person: d, reason: "seen_before" },
    ]);
    const round = await readToday(app, a);
    expect(round.day).toBe(TODAY);
    expect(round.entries?.map((e) => [e.position, e.reason, e.decision, e.card.accountId])).toEqual(
      [
        [1, "matches_filters", null, b.accountId],
        [2, "liked_you", null, c.accountId],
        [3, "seen_before", null, d.accountId],
      ],
    );
    // The first read opened the round; serving the cards wrote the shown record (ADR-008).
    const opened = await ctx.client.query<{ opened_at: Date | null }>(
      "SELECT opened_at FROM rounds WHERE id = $1",
      [roundId],
    );
    expect(opened.rows[0]?.opened_at).not.toBeNull();
    const shown = await ctx.client.query<{ n: number }>(
      "SELECT count(DISTINCT photo_id)::int AS n FROM card_shown WHERE account_id = $1",
      [a.accountId],
    );
    expect(shown.rows[0]?.n).toBe(9);
  });

  test("Before the day's round is built, today's round has no cards", async ({ ctx, app }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    // Yesterday's round is not today's.
    const [b] = await cast(ctx, 1);
    if (!b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b], YESTERDAY);
    expect(await readToday(app, a)).toEqual({ day: TODAY, entries: null });
  });

  test("a round with no cards answers an empty list", async ({ ctx, app }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    await roundFor(ctx.client, a, []);
    expect(await readToday(app, a)).toEqual({ day: TODAY, entries: [] });
  });

  test("a card budget used up answers 429 with its wait in Retry-After", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);
    await ctx.client.query(
      `INSERT INTO matching_config (version, key, value, created_by)
       SELECT max(version) + 1, 'exposure_cards_per_day', '0'::jsonb, 'test'
         FROM matching_config WHERE key = 'exposure_cards_per_day'`,
    );
    const answer = await today(app, a);
    expect(answer.status).toBe(429);
    expect(await errorCode(answer)).toBe("card_budget_exceeded");
    expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("A card that can no longer be shown is left out, and cannot be seen or decided", async ({
    ctx,
    app,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b, c]);
    await block(ctx.client, a, b);
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [c.accountId]);
    expect((await readToday(app, a)).entries).toEqual([]);
    for (const position of [1, 2]) {
      const answers = [
        await seen(app, a, TODAY, position),
        await decideBy(app, a, TODAY, position, "like"),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(await errorCode(answer)).toBe("not_found");
      }
    }
    expect((await entriesOf(ctx.client, roundId)).map((e) => [e.seen_at, e.decision])).toEqual([
      [null, null],
      [null, null],
    ]);
  });
});

describe("seen and decided", () => {
  test("A card seen is recorded once, as profile_viewed", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await joinStudy(app, a);
    const roundId = await roundFor(ctx.client, a, [{ person: b, reason: "liked_you" }]);
    expect((await seen(app, a, TODAY, 1)).status).toBe(204);
    const first = (await entriesOf(ctx.client, roundId))[0]?.seen_at;
    expect(first).not.toBeNull();
    expect((await seen(app, a, TODAY, 1)).status).toBe(204);
    expect((await entriesOf(ctx.client, roundId))[0]?.seen_at).toEqual(first);
    expect(await eventsOf(ctx.client, "profile_viewed")).toEqual([
      { position: 1, reason: "liked_you" },
    ]);
  });

  test("A like is recorded, and the same decision again writes nothing", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await joinStudy(app, a);
    const roundId = await roundFor(ctx.client, a, [b]);
    expect((await seen(app, a, TODAY, 1)).status).toBe(204);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    const first = (await entriesOf(ctx.client, roundId))[0];
    expect(first?.decision).toBe("like");
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await entriesOf(ctx.client, roundId))[0]?.decided_at).toEqual(first?.decided_at);
    expect(await eventsOf(ctx.client, "like")).toEqual([
      {
        position: 1,
        reason: "matches_filters",
        sinceSeen: "under_3s",
        revised: false,
        fish: false,
      },
    ]);
  });

  test("A decision may change until the day ends, and the change says it was revised", async ({
    ctx,
    app,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await joinStudy(app, a);
    const roundId = await roundFor(ctx.client, a, [b]);
    for (const decision of ["like", "pass", "like"]) {
      expect((await decideBy(app, a, TODAY, 1, decision)).status).toBe(200);
    }
    const [entry] = await entriesOf(ctx.client, roundId);
    expect(entry?.decision).toBe("like");
    const events = await ctx.client.query<{
      name: string;
      props: { revised: boolean; sinceSeen: unknown };
    }>("SELECT name, props FROM events WHERE name IN ('like', 'pass') ORDER BY at, id");
    // An event's time is cut to the hour, so the three are compared as a set.
    expect(events.rows.map((e) => `${e.name}:${e.props.revised}`).sort()).toEqual([
      "like:false",
      "like:true",
      "pass:true",
    ]);
    // Never seen: the band since seen is null.
    expect(events.rows.every((e) => e.props.sinceSeen === null)).toBe(true);
    // Read back: the caller's own decision on the card.
    expect((await readToday(app, a)).entries?.[0]?.decision).toBe("like");
  });

  test("A card of a day that has ended cannot be seen or decided", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b], YESTERDAY);
    for (const answer of [
      await seen(app, a, YESTERDAY, 1),
      await decideBy(app, a, YESTERDAY, 1, "like"),
    ]) {
      expect(answer.status).toBe(409);
      expect(await errorCode(answer)).toBe("round_expired");
    }
    expect((await entriesOf(ctx.client, roundId))[0]).toMatchObject({
      seen_at: null,
      decision: null,
    });
  });

  test("a day not begun, a place with no card and no round today are not found", async ({
    ctx,
    app,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    for (const answer of [await decideBy(app, a, TODAY, 1, "like"), await seen(app, a, TODAY, 1)]) {
      expect(answer.status).toBe(404);
    }
    await roundFor(ctx.client, a, [b]);
    for (const answer of [
      await decideBy(app, a, "2026-10-17", 1, "like"),
      await seen(app, a, "2026-10-17", 1),
      await decideBy(app, a, TODAY, 2, "pass"),
      await seen(app, a, TODAY, 2),
    ]) {
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
    }
  });

  test.for([
    ["a day that is no date", "/rounds/2026-02-30/entries/1/decision", { decision: "like" }],
    ["a word for the day", "/rounds/today/entries/1/decision", { decision: "like" }],
    ["a place of zero", `/rounds/${TODAY}/entries/0/decision`, { decision: "like" }],
    ["a place past the most", `/rounds/${TODAY}/entries/51/decision`, { decision: "like" }],
    ["another decision", `/rounds/${TODAY}/entries/1/decision`, { decision: "superlike" }],
    ["an extra key", `/rounds/${TODAY}/entries/1/decision`, { decision: "like", note: "x" }],
    ["no decision", `/rounds/${TODAY}/entries/1/decision`, {}],
  ] as const)("%s is refused with 400", async ([, path, body], { ctx, app }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    const answer = await app.request(path, {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(answer.status).toBe(400);
    expect(await errorCode(answer)).toBe("validation_failed");
  });

  test("a block that lands between the decision's read and its write leaves nothing written", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b]);
    // B blocks A just before the decision is written, as if it committed then.
    const db = interleaved(ctx.client, /UPDATE round_entries e SET decision/, () =>
      block(ctx.client, b, a),
    );
    const app = await appOn(db);
    const answer = await decideBy(app, a, TODAY, 1, "like");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("not_found");
    expect((await entriesOf(ctx.client, roundId))[0]).toMatchObject({ decision: null });
  });

  test.for([
    ["a day that is no date", "/rounds/2026-02-30/entries/1/seen"],
    ["a word for the day", "/rounds/today/entries/1/seen"],
    ["a place of zero", `/rounds/${TODAY}/entries/0/seen`],
    ["a place past the most", `/rounds/${TODAY}/entries/51/seen`],
    ["a place that is no number", `/rounds/${TODAY}/entries/first/seen`],
  ] as const)("a seen report with %s is refused with 400", async ([, path], { ctx, app }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    const answer = await app.request(path, { method: "POST", headers: a.headers });
    expect(answer.status).toBe(400);
    expect(await errorCode(answer)).toBe("validation_failed");
  });

  test("a viewer erased while their round is read is served no card, and no shown record is written", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);
    // A's erasure commits just before the card's shown record is written.
    const db = interleaved(ctx.client, /WITH live AS \(SELECT 1 FROM account/, async () =>
      eraseAccount(
        { db: ctx.client, logger: (await captureLogger()).logger, now: () => T },
        a.accountId,
      ),
    );
    const answer = await today(await appOn(db), a);
    expect(db.ran()).toBe(true);
    // The round went with the erasure; the read in flight serves nothing.
    expect(RoundResponse.parse(await answer.json()).entries).toEqual([]);
    const shown = await ctx.client.query("SELECT 1 FROM card_shown WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(shown.rowCount).toBe(0);
  });

  test("The round is complete once every card that can be shown is decided", async ({
    ctx,
    app,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b, c]);
    const completed = async () =>
      (
        await ctx.client.query<{ completed_at: Date | null }>(
          "SELECT completed_at FROM rounds WHERE id = $1",
          [roundId],
        )
      ).rows[0]?.completed_at;
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect(await completed()).toBeNull();
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [c.accountId]);
    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    expect(await completed()).not.toBeNull();
  });

  test("Only the person's own round is read or decided", async ({ ctx, app }) => {
    const [a, e, b, f] = await cast(ctx, 4);
    if (!a || !e || !b || !f) throw new Error("cast not written");
    const ofA = await roundFor(ctx.client, a, [b]);
    const ofE = await roundFor(ctx.client, e, [f]);
    expect((await seen(app, e, TODAY, 1)).status).toBe(204);
    expect((await decideBy(app, e, TODAY, 1, "pass")).status).toBe(200);
    expect((await entriesOf(ctx.client, ofE))[0]).toMatchObject({ decision: "pass" });
    expect((await entriesOf(ctx.client, ofA))[0]).toMatchObject({ seen_at: null, decision: null });
    expect((await readToday(app, e)).entries?.map((x) => x.card.accountId)).toEqual([f.accountId]);
  });

  test("the routes refuse without a session", async ({ ctx, app }) => {
    const nobody = { accountId: "", headers: { authorization: "Bearer nobody" } };
    for (const answer of [
      await today(app, nobody),
      await seen(app, nobody, TODAY, 1),
      await decideBy(app, nobody, TODAY, 1, "like"),
      await app.request("/rounds/today"),
    ]) {
      expect(answer.status).toBe(401);
      expect(await errorCode(answer)).toBe("unauthenticated");
    }
    expect(ctx).toBeDefined();
  });

  test("Two devices deciding the same card at once are taken one after the other", async () => {
    await withTwoConnections("kuutti-96-decide", async (pool, first, second) => {
      const ids = await people(pool, null, 2, { complete: true, consented: true });
      const [a, b] = ids;
      if (!a || !b) throw new Error("cast not written");
      // A in the study, so each decision is an event that says whether it revised another;
      // a database of its own has no month of events until the night makes one.
      await ensureEventPartitions(pool, T);
      await joinStudy(await appOn(pool), await signInAs(pool, a));
      // Both decisions after the consent, which the ticking clock stamped a second after T.
      const later = (seconds: number) => new Date(T.getTime() + seconds * SECOND);
      const deps = await depsOn(pool, () => later(10));
      await saveRound(deps, {
        accountId: a,
        day: TODAY,
        ordering: "count",
        entries: [{ candidateId: b, reason: "matches_filters" }],
      });
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's like holds the round's row; the other's pass waits for it.
      await decide({ ...deps, db: first }, MATCHES, {
        accountId: a,
        day: TODAY,
        position: 1,
        decision: "like",
      });
      const racing = watched(
        decide({ ...deps, db: second, now: () => later(11) }, MATCHES, {
          accountId: a,
          day: TODAY,
          position: 1,
          decision: "pass",
        }),
      );
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      await racing.outcome;
      await second.query("COMMIT");
      const { rows } = await pool.query<{ decision: string; decided_at: Date }>(
        "SELECT e.decision, e.decided_at FROM round_entries e JOIN rounds r ON r.id = e.round_id WHERE r.account_id = $1",
        [a],
      );
      expect(rows).toEqual([{ decision: "pass", decided_at: later(11) }]);
      // The second read the first's like only because it waited on the round:
      // without the lock it would have read no decision and said it revised none.
      const events = await pool.query<{ name: string; props: { revised: boolean } }>(
        "SELECT name, props FROM events WHERE name IN ('like', 'pass')",
      );
      expect(events.rows.map((e) => `${e.name}:${e.props.revised}`).sort()).toEqual([
        "like:false",
        "pass:true",
      ]);
    });
  });
});

/** The day's likes, above every version a migration wrote, so it is the one read (#98). */
async function likeBudget(db: Queryable, likes: number) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT max(version) + 1, 'like_budget_balanced', $1::jsonb, 'test'
       FROM matching_config WHERE key = 'like_budget_balanced'`,
    [JSON.stringify(likes)],
  );
}

describe("the day's likes (#98, ADR-036)", () => {
  test("The day's likes stop at the budget, and the next is refused with the time they come back", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 2);
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await joinStudy(app, a);
    const roundId = await roundFor(ctx.client, a, [b, c, d]);

    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 2, "like")).status).toBe(200);
    const refused = await decideBy(app, a, TODAY, 3, "like");

    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("like_budget_exceeded");
    // 12:00 in Finland, a few ticking seconds on: about twelve hours until midnight.
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(12 * 3600 - 60);
    expect(wait).toBeLessThanOrEqual(12 * 3600);
    expect((await entriesOf(ctx.client, roundId)).map((e) => e.decision)).toEqual([
      "like",
      "like",
      null,
    ]);
    expect(await eventsOf(ctx.client, "like")).toHaveLength(2);
  });

  test("the refusal is said in the request's language", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 0);
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);
    const refused = await app.request(`/rounds/${TODAY}/entries/1/decision`, {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json", "accept-language": "fi" },
      body: JSON.stringify({ decision: "like" }),
    });
    expect(refused.status).toBe(429);
    expect(ErrorResponse.parse(await refused.json()).error.message).toBe(
      "Olet käyttänyt tämän päivän tykkäykset. Uusia tulee keskiyön jälkeen, mutta voit yhä ohittaa.",
    );
  });

  test("A like back on a card of somebody who liked the person is free", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 1);
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [{ person: b, reason: "liked_you" }, c]);

    expect((await decideBy(app, a, TODAY, 2, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);

    expect((await entriesOf(ctx.client, roundId)).map((e) => e.decision)).toEqual(["like", "like"]);
  });

  test("A pass is never counted, and a like taken back gives its place back", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 1);
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b, c, d]);

    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 2, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 3, "like")).status).toBe(429);
    expect((await decideBy(app, a, TODAY, 2, "pass")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 3, "like")).status).toBe(200);

    expect((await entriesOf(ctx.client, roundId)).map((e) => e.decision)).toEqual([
      "pass",
      "pass",
      "like",
    ]);
  });

  test("a card liked already is liked again without a refusal, the budget spent or not", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 1);
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
  });

  test("the day's likes are ten by the row the first cut wrote", async ({ ctx, app }) => {
    const [a, ...others] = await cast(ctx, 12);
    if (!a) throw new Error("cast not written");
    await roundFor(ctx.client, a, others);
    for (let position = 1; position <= 10; position += 1) {
      expect((await decideBy(app, a, TODAY, position, "like")).status).toBe(200);
    }
    expect((await decideBy(app, a, TODAY, 11, "like")).status).toBe(429);
    expect((await decideBy(app, a, TODAY, 11, "pass")).status).toBe(200);
  });

  test("Two devices liking at once cannot pass the budget together", async () => {
    await withTwoConnections("kuutti-98-likes", async (pool, first, second) => {
      const ids = await people(pool, null, 3, { complete: true, consented: true });
      const [a, b, c] = ids;
      if (!a || !b || !c) throw new Error("cast not written");
      await likeBudget(pool, 1);
      const deps = await depsOn(pool);
      await saveRound(deps, {
        accountId: a,
        day: TODAY,
        ordering: "count",
        entries: [
          { candidateId: b, reason: "matches_filters" },
          { candidateId: c, reason: "matches_filters" },
        ],
      });
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's like holds the round's row; the other's waits, then counts it.
      await decide({ ...deps, db: first }, MATCHES, {
        accountId: a,
        day: TODAY,
        position: 1,
        decision: "like",
      });
      const racing = watched(
        decide({ ...deps, db: second }, MATCHES, {
          accountId: a,
          day: TODAY,
          position: 2,
          decision: "like",
        }),
      );
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await racing.outcome).toBe("like_budget_exceeded");
      await second.query("COMMIT");
      const { rows } = await pool.query<{ position: number; decision: string | null }>(
        `SELECT e.position, e.decision FROM round_entries e JOIN rounds r ON r.id = e.round_id
          WHERE r.account_id = $1 ORDER BY e.position`,
        [a],
      );
      expect(rows).toEqual([
        { position: 1, decision: "like" },
        { position: 2, decision: null },
      ]);
    });
  });
});

describe("erasure, the export and the events", () => {
  test("Erasure removes the person's rounds and every entry in which they are somebody's card", async ({
    ctx,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const ofA = await roundFor(ctx.client, a, [b, c]);
    const ofB = await roundFor(ctx.client, b, [a]);
    const { logger } = await captureLogger();
    const summary = await eraseAccount({ db: ctx.client, logger, now: () => T }, b.accountId);
    expect(summary).toMatchObject({ rounds: 1, roundEntriesAsCandidate: 1 });
    expect((await ctx.client.query("SELECT 1 FROM rounds WHERE id = $1", [ofB])).rowCount).toBe(0);
    expect((await entriesOf(ctx.client, ofA)).map((e) => [e.position, e.candidate_id])).toEqual([
      [2, c.accountId],
    ]);
  });

  test("The person's export lists their own rounds, never whom", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [{ person: b, reason: "liked_you" }]);
    // B's own round, in which A is the card: not A's to see.
    await roundFor(ctx.client, b, [a]);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    const { logger } = await captureLogger();
    const { document } = await exportAccount(
      { db: ctx.client, logger, now: () => T, version: "test" },
      a.accountId,
      englishT,
    );
    expect(document.rounds.about).toMatch(/is not written here/);
    expect(document.rounds.items).toEqual([
      {
        day: TODAY,
        builtAt: T.toISOString(),
        openedAt: null,
        completedAt: expect.any(String),
        entries: [
          {
            position: 1,
            reason: "liked_you",
            reasonInWords: "Had liked you",
            seenAt: null,
            decision: "like",
            decisionInWords: "Liked",
            decidedAt: expect.any(String),
          },
        ],
      },
    ]);
    expect(JSON.stringify(document.rounds)).not.toContain(b.accountId);
  });

  test("A round built is a round_built event with its size and its count for each reason", async ({
    ctx,
    app,
  }) => {
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await joinStudy(app, a);
    await roundFor(ctx.client, a, [b, c, { person: d, reason: "liked_you" }]);
    expect(await eventsOf(ctx.client, "round_built")).toEqual([
      {
        ordering: "count",
        size: 3,
        matchesFilters: 2,
        likedYou: 1,
        seenBefore: 0,
        relaxed: 0,
        fish: 0,
      },
    ]);
    // A second build for the day leaves the first as it was, and says nothing.
    expect(
      await saveRound(await depsOn(ctx.client), {
        accountId: a.accountId,
        day: TODAY,
        ordering: "count",
        entries: [{ candidateId: b.accountId, reason: "matches_filters" }],
      }),
    ).toBeNull();
    expect(await eventsOf(ctx.client, "round_built")).toHaveLength(1);
  });

  test("a round is never written for an erased person, nor with a card erased, blocked or sanctioned", async ({
    ctx,
    app,
  }) => {
    const [a, b, c, d, e, gone] = await cast(ctx, 6);
    if (!a || !b || !c || !d || !e || !gone) throw new Error("cast not written");
    const { logger } = await captureLogger();
    const erase = (who: Person) =>
      eraseAccount({ db: ctx.client, logger, now: () => T }, who.accountId);
    await joinStudy(app, a);
    await erase(gone);
    expect(
      await saveRound(await depsOn(ctx.client), {
        accountId: gone.accountId,
        day: TODAY,
        ordering: "count",
        entries: [{ candidateId: b.accountId, reason: "matches_filters" }],
      }),
    ).toBeNull();
    await erase(c);
    await block(ctx.client, d, a);
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [e.accountId]);
    const roundId = await roundFor(ctx.client, a, [b, c, d, e]);
    // Only B is written, at the place the builder gave; the event counts what was written.
    expect((await entriesOf(ctx.client, roundId)).map((x) => [x.position, x.candidate_id])).toEqual(
      [[1, b.accountId]],
    );
    expect(await eventsOf(ctx.client, "round_built")).toEqual([
      {
        ordering: "count",
        size: 1,
        matchesFilters: 1,
        likedYou: 0,
        seenBefore: 0,
        relaxed: 0,
        fish: 0,
      },
    ]);
  });

  test("a person is never a card in their own round", async ({ ctx }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    await expect(roundFor(ctx.client, a, [a])).rejects.toThrow(/never a card in their own round/);
  });
});
