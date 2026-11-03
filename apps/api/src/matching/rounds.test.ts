import type { Queryable } from "@kuutti/db";
import {
  ErrorResponse,
  type ProfileCard,
  QUEUE_PAGE,
  RoundDecisionAnswer,
  type RoundReason,
  RoundResponse,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount, exportAccount } from "../identity/index.ts";
import { addDays, finnishDay } from "../lib/finnish-day.ts";
import { ensureEventPartitions } from "../research/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
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
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { fitsAt, logged, MATCHES, peopleWhoFit, shownAt } from "../test/rounds.ts";
import {
  addPlaces,
  type CardOf,
  decide,
  exportRounds,
  pruneRounds,
  type Queue,
  type RoundDeps,
  readQueue,
} from "./rounds.ts";

// The queue's cards and the day's log of them (#96, #502,
// features/matching/decisions.feature): the read, seen and decided, a decision
// changed and the day's end, a skip and a second pass, a card that can no longer
// be shown, completion, two devices at once, the caller's own round only,
// erasure of both sides, the export, the research events, the year they are
// kept, and the log's one writer. Who comes next is jobs/round-builder.test.ts;
// the people here are in a pond nobody has opened, so a read serves what a test
// wrote and adds nobody.

/** 12:00 in Finland, one Friday: the round's day is 2026-10-16. */
const T = new Date("2026-10-16T09:00:00.000Z");
const TODAY = finnishDay(T);
const YESTERDAY = "2026-10-15";
const SECOND = 1000;
const DAY_MS = 24 * 3600 * SECOND;
const FITS = fitsAt(() => T);

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

/** Complete, active people who fit each other, signed in. */
async function cast(ctx: TestContext, count: number): Promise<Person[]> {
  const ids = await peopleWhoFit(ctx.client, count);
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

/** `owner`'s log of `day` with these cards, all matching every filter unless said; its id. */
const roundFor = (
  db: Queryable,
  owner: Person,
  cards: (Person | { person: Person; reason: RoundReason })[],
  day = TODAY,
) =>
  logged(
    db,
    owner.accountId,
    day,
    cards.map((card) =>
      "person" in card
        ? { candidateId: card.person.accountId, reason: card.reason }
        : card.accountId,
    ),
  );

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

describe("reading the queue", () => {
  test("A read shows the undecided cards in order, each with its reason, at most ten", async ({
    ctx,
    app,
  }) => {
    const [a, b, c, d, ...more] = await cast(ctx, 4 + QUEUE_PAGE);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [
      b,
      { person: c, reason: "liked_you" },
      { person: d, reason: "seen_before" },
      ...more,
    ]);
    const round = await readToday(app, a);
    expect(round.day).toBe(TODAY);
    expect(round.entries).toHaveLength(QUEUE_PAGE);
    expect(round.entries?.map((e) => e.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(round.entries?.slice(0, 4).map((e) => [e.reason, e.decision, e.card.accountId])).toEqual(
      [
        ["matches_filters", null, b.accountId],
        ["liked_you", null, c.accountId],
        ["seen_before", null, d.accountId],
        ["matches_filters", null, more[0]?.accountId],
      ],
    );
    // The first read opened the round; serving the cards wrote the shown record (ADR-008).
    const opened = await ctx.client.query<{ opened_at: Date | null }>(
      "SELECT opened_at FROM rounds WHERE id = $1",
      [roundId],
    );
    expect(opened.rows[0]?.opened_at).not.toBeNull();
    // Ten people's three photos, and nothing of the three who did not come.
    const shown = await ctx.client.query<{ n: number }>(
      "SELECT count(DISTINCT photo_id)::int AS n FROM card_shown WHERE account_id = $1",
      [a.accountId],
    );
    expect(shown.rows[0]?.n).toBe(30);
  });

  test("A decided card is not read again", async ({ ctx, app }) => {
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b, c, d]);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 2, "skip")).status).toBe(200);

    const round = await readToday(app, a);

    expect(round.entries?.map((e) => [e.position, e.card.accountId])).toEqual([[3, d.accountId]]);
  });

  test("yesterday's round is not today's", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b], YESTERDAY);
    expect(await readToday(app, a)).toEqual({
      day: TODAY,
      entries: null,
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
  });

  test("a round with no cards answers an empty list", async ({ ctx, app }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    await roundFor(ctx.client, a, []);
    expect(await readToday(app, a)).toEqual({
      day: TODAY,
      entries: [],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
  });

  test("with no ceiling on cards a person reads on, however many they have had", async ({
    ctx,
    app,
  }) => {
    const [a, ...others] = await cast(ctx, 1 + 3 * QUEUE_PAGE);
    if (!a) throw new Error("cast not written");
    await roundFor(ctx.client, a, others);
    for (let page = 0; page < 3; page += 1) {
      const { entries } = await readToday(app, a);
      expect(entries).toHaveLength(QUEUE_PAGE);
      for (const entry of entries ?? []) {
        expect((await decideBy(app, a, TODAY, entry.position, "pass")).status).toBe(200);
      }
    }
    expect((await readToday(app, a)).entries).toEqual([]);
  });

  test("a ceiling set again in the panel answers 429 with its wait in Retry-After", async ({
    ctx,
    app,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b, c]);
    await withMatchingConfig(ctx.client, { exposure_cards_per_day: 1 });
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

  /** A read with the queue's two sides stubbed: what a read does with what they answer. */
  async function reading(ctx: TestContext, queue: Queue, cardOf: CardOf, accountId: string) {
    const deps = await depsOn(ctx.client);
    return readQueue(deps, MATCHES, queue, accountId, cardOf);
  }

  const everybodyFits: Queue["fits"] = async (_db, _accountId, ids) => new Set(ids);
  /** All a read takes of a card: the builder's own tests are the profile slice's. */
  const aCard = { fields: {} } as ProfileCard;

  test("a read that adds people it then cannot show gives up after three tries", async ({
    ctx,
  }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    await roundFor(ctx.client, a, []);
    let fills = 0;
    const queue: Queue = {
      fill: async () => {
        fills += 1;
        return true;
      },
      fits: everybodyFits,
    };

    const round = await reading(ctx, queue, async () => null, a.accountId);

    expect(round.entries).toEqual([]);
    expect(fills).toBe(3);
  });

  test("a read that adds nobody asks once, and undecided cards ask nobody", async ({ ctx }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, []);
    let fills = 0;
    const fill = async () => {
      fills += 1;
      return false;
    };

    const queue = { fill, fits: everybodyFits };

    expect((await reading(ctx, queue, async () => null, a.accountId)).entries).toEqual([]);
    expect(fills).toBe(1);

    await roundFor(ctx.client, a, [b]);
    const read = await reading(ctx, queue, async () => aCard, a.accountId);
    expect(read.entries?.map((entry) => entry.position)).toEqual([1]);
    expect(fills).toBe(1);
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
    const times: (Date | null | undefined)[] = [];
    for (const decision of ["like", "pass", "like"]) {
      expect((await decideBy(app, a, TODAY, 1, decision)).status).toBe(200);
      times.push((await entriesOf(ctx.client, roundId))[0]?.decided_at);
    }
    const [entry] = await entriesOf(ctx.client, roundId);
    expect(entry?.decision).toBe("like");
    expect(new Set(times.map(Number)).size).toBe(3);
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
    ["a place past the column's", `/rounds/${TODAY}/entries/32768/decision`, { decision: "like" }],
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
    ["a place past the column's", `/rounds/${TODAY}/entries/32768/seen`],
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
    // The round went with the erasure; the read in flight serves nothing, and finds none.
    expect(RoundResponse.parse(await answer.json()).entries).toBeNull();
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
    const ofE = await roundFor(ctx.client, e, [f, a]);
    expect((await seen(app, e, TODAY, 1)).status).toBe(204);
    expect((await decideBy(app, e, TODAY, 1, "pass")).status).toBe(200);
    expect((await entriesOf(ctx.client, ofE))[0]).toMatchObject({ decision: "pass" });
    expect((await entriesOf(ctx.client, ofA))[0]).toMatchObject({ seen_at: null, decision: null });
    expect((await readToday(app, e)).entries?.map((x) => x.card.accountId)).toEqual([a.accountId]);
    expect((await readToday(app, a)).entries?.map((x) => x.card.accountId)).toEqual([b.accountId]);
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
      const ids = await peopleWhoFit(pool, 2);
      const [a, b] = ids;
      if (!a || !b) throw new Error("cast not written");
      // A in the study, so each decision is an event that says whether it revised another;
      // a database of its own has no month of events until the night makes one.
      await ensureEventPartitions(pool, T);
      await joinStudy(await appOn(pool), await signInAs(pool, a));
      // Both decisions after the consent, which the ticking clock stamped a second after T.
      const later = (seconds: number) => new Date(T.getTime() + seconds * SECOND);
      const deps = await depsOn(pool, () => later(10));
      await logged(pool, a, TODAY, [b]);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's like holds the round's row; the other's pass waits for it.
      await decide({ ...deps, db: first }, MATCHES, FITS, {
        accountId: a,
        day: TODAY,
        position: 1,
        decision: "like",
      });
      const racing = watched(
        decide({ ...deps, db: second, now: () => later(11) }, MATCHES, FITS, {
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
      const ids = await peopleWhoFit(pool, 3);
      const [a, b, c] = ids;
      if (!a || !b || !c) throw new Error("cast not written");
      await likeBudget(pool, 1);
      const deps = await depsOn(pool);
      await logged(pool, a, TODAY, [b, c]);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One device's like holds the round's row; the other's waits, then counts it.
      await decide({ ...deps, db: first }, MATCHES, FITS, {
        accountId: a,
        day: TODAY,
        position: 1,
        decision: "like",
      });
      const racing = watched(
        decide({ ...deps, db: second }, MATCHES, FITS, {
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

/** What a decision's answer says of the caller's likes after it (#524). */
async function likesLeftAfter(answer: Response) {
  expect(answer.status).toBe(200);
  return RoundDecisionAnswer.parse(await answer.json()).likesLeft;
}

describe("the likes left (#524, ADR-036 §6)", () => {
  test("The round says how many of the day's likes are left, and each decision's answer says it again", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 2);
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b, c, d]);

    expect((await readToday(app, a)).likesLeft).toBe(2);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(1);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "like"))).toBe(0);
    expect((await decideBy(app, a, TODAY, 3, "like")).status).toBe(429);

    expect((await readToday(app, a)).likesLeft).toBe(0);
  });

  test("Before the day's first read, all of the day's likes are left", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 3);
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    expect(await readToday(app, a)).toMatchObject({ entries: null, likesLeft: 3 });
  });

  test("A pass leaves the likes left as they were, and a like taken back gives one back", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 2);
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b, c]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "pass"))).toBe(2);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "like"))).toBe(1);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "pass"))).toBe(2);
  });

  test("A like back leaves the likes left as they were", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 1);
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [{ person: b, reason: "liked_you" }]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(1);
  });

  test("The likes left are the person's own, of today", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 4);
    const [a, b, c, e] = await cast(ctx, 4);
    if (!a || !b || !c || !e) throw new Error("cast not written");
    const yesterday = await roundFor(ctx.client, a, [b], YESTERDAY);
    await ctx.client.query(
      "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
      [yesterday, T],
    );
    await roundFor(ctx.client, a, [c]);
    await roundFor(ctx.client, e, [b]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(3);

    expect((await readToday(app, a)).likesLeft).toBe(3);
    expect((await readToday(app, e)).likesLeft).toBe(4);
  });

  test("the same like again says the same number, and a like made a fish spends no second", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 3);
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(2);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(2);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "fish"))).toBe(2);
  });

  test("a budget lowered below the day's likes reads as none left, never fewer", async ({
    ctx,
    app,
  }) => {
    await likeBudget(ctx.client, 2);
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b, c]);
    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 2, "like")).status).toBe(200);

    await likeBudget(ctx.client, 1);

    expect((await readToday(app, a)).likesLeft).toBe(0);
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
        relaxations: [],
        entries: [
          {
            position: 1,
            reason: "liked_you",
            reasonInWords: "Had liked you",
            relaxedField: null,
            relaxedFieldInWords: null,
            seenAt: null,
            decision: "like",
            decisionInWords: "Liked",
            decidedAt: expect.any(String),
            secondPass: false,
            distance: "nearby",
            distanceInWords: "Nearby",
          },
        ],
      },
    ]);
    expect(JSON.stringify(document.rounds)).not.toContain(b.accountId);
  });

  test("the export says which pass is a second one, and a skip in words", async ({ ctx, app }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await shownAt(
      ctx.client,
      new Date(T.getTime() - 40 * DAY_MS),
      a.accountId,
      b.accountId,
      "pass",
    );
    await roundFor(ctx.client, a, [b, c]);
    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    expect((await decideBy(app, a, TODAY, 2, "skip")).status).toBe(200);
    const { logger } = await captureLogger();

    const { document } = await exportAccount(
      { db: ctx.client, logger, now: () => T, version: "test" },
      a.accountId,
      englishT,
    );

    const [today] = document.rounds.items;
    expect(today?.day).toBe(TODAY);
    expect(
      today?.entries.map((e) => [e.position, e.decision, e.decisionInWords, e.secondPass]),
    ).toEqual([
      [1, "pass", "Passed", true],
      [2, "skip", "Left for later", false],
    ]);
  });
});

describe("the log's one writer (ADR-062 §1)", () => {
  const places = (...ids: string[]) =>
    ids.map((candidateId) => ({
      candidateId,
      reason: "matches_filters" as const,
      distance: "nearby" as const,
    }));

  test("a round is never written for an erased person, nor with a card erased, blocked or sanctioned", async ({
    ctx,
  }) => {
    const [a, b, c, d, e, gone] = await cast(ctx, 6);
    if (!a || !b || !c || !d || !e || !gone) throw new Error("cast not written");
    const { logger } = await captureLogger();
    const erase = (who: Person) =>
      eraseAccount({ db: ctx.client, logger, now: () => T }, who.accountId);
    await erase(gone);
    expect(
      await addPlaces(await depsOn(ctx.client), {
        accountId: gone.accountId,
        day: TODAY,
        places: places(b.accountId),
      }),
    ).toBeNull();
    await erase(c);
    await block(ctx.client, d, a);
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [e.accountId]);

    const written = await addPlaces(await depsOn(ctx.client), {
      accountId: a.accountId,
      day: TODAY,
      places: places(b.accountId, c.accountId, d.accountId, e.accountId),
    });

    expect(written).toBe(1);
    const { rows } = await ctx.client.query<{ id: string; last_position: number }>(
      "SELECT id, last_position FROM rounds WHERE account_id = $1",
      [a.accountId],
    );
    const roundId = rows[0]?.id ?? "";
    // Only B is written, at the place the list gave, and the places it dropped stay given.
    expect((await entriesOf(ctx.client, roundId)).map((x) => [x.position, x.candidate_id])).toEqual(
      [[1, b.accountId]],
    );
    expect(rows[0]?.last_position).toBe(4);
  });

  test("a round is never written for an owner paused or sanctioned since the pool was read", async ({
    ctx,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    for (const [who, state] of [
      [a, "paused"],
      [b, "suspended"],
    ] as const) {
      await ctx.client.query("UPDATE account SET state = $2 WHERE id = $1", [who.accountId, state]);
      expect(
        await addPlaces(await depsOn(ctx.client), {
          accountId: who.accountId,
          day: TODAY,
          places: places(c.accountId),
        }),
      ).toBeNull();
    }
    const { rows } = await ctx.client.query(
      "SELECT 1 FROM rounds WHERE account_id = ANY($1::uuid[])",
      [[a.accountId, b.accountId]],
    );
    expect(rows).toHaveLength(0);
  });

  test("a person is never a card in their own round", async ({ ctx }) => {
    const [a] = await cast(ctx, 1);
    if (!a) throw new Error("cast not written");
    await expect(roundFor(ctx.client, a, [a])).rejects.toThrow(/never a card in their own round/);
  });

  test("somebody in the day's log is not added again, and the next places follow the highest given", async ({
    ctx,
  }) => {
    const [a, b, c, d] = await cast(ctx, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    const deps = await depsOn(ctx.client);
    const write = (...ids: string[]) =>
      addPlaces(deps, { accountId: a.accountId, day: TODAY, places: places(...ids) });
    expect(await write(b.accountId, c.accountId)).toBe(2);

    // Two of the three lost to a read beside this one: their places stay empty.
    expect(await write(b.accountId, c.accountId, d.accountId)).toBe(1);

    const roundId = await roundFor(ctx.client, a, []);
    expect((await entriesOf(ctx.client, roundId)).map((x) => [x.position, x.candidate_id])).toEqual(
      [
        [1, b.accountId],
        [2, c.accountId],
        [5, d.accountId],
      ],
    );
  });

  test("adding people reopens a day that was complete, and adding nobody leaves it so", async ({
    ctx,
    app,
  }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b]);
    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    const completed = async () =>
      (
        await ctx.client.query<{ completed_at: Date | null }>(
          "SELECT completed_at FROM rounds WHERE id = $1",
          [roundId],
        )
      ).rows[0]?.completed_at;
    expect(await completed()).not.toBeNull();

    await roundFor(ctx.client, a, []);
    await roundFor(ctx.client, a, [b]);
    expect(await completed()).not.toBeNull();

    await roundFor(ctx.client, a, [c]);
    expect(await completed()).toBeNull();
  });

  test("a place's relaxations are written with it, the one that names its label first", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await addPlaces(await depsOn(ctx.client), {
      accountId: a.accountId,
      day: TODAY,
      places: [
        {
          candidateId: b.accountId,
          reason: "relaxed",
          distance: "close",
          relaxedWith: ["smoking", "hasKids"],
        },
      ],
    });
    const { rows } = await ctx.client.query(
      `SELECT e.relaxed_field, e.relaxed_with, e.distance
         FROM round_entries e JOIN rounds r ON r.id = e.round_id WHERE r.account_id = $1`,
      [a.accountId],
    );
    expect(rows).toEqual([
      { relaxed_field: "smoking", relaxed_with: ["smoking", "hasKids"], distance: "close" },
    ]);
  });
});

describe("a skip (ADR-062 §3)", () => {
  test("A skip moves on, spends nothing, and is no event", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 1);
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await joinStudy(app, a);
    const roundId = await roundFor(ctx.client, a, [b, c]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "skip"))).toBe(1);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "like"))).toBe(0);

    expect((await entriesOf(ctx.client, roundId)).map((e) => e.decision)).toEqual(["skip", "like"]);
    expect((await readToday(app, a)).entries).toEqual([]);
    expect(await eventsOf(ctx.client, "pass")).toEqual([]);
    expect(await eventsOf(ctx.client, "like")).toHaveLength(1);
  });

  test("the same skip again writes nothing", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b]);
    expect((await decideBy(app, a, TODAY, 1, "skip")).status).toBe(200);
    const first = (await entriesOf(ctx.client, roundId))[0];

    expect((await decideBy(app, a, TODAY, 1, "skip")).status).toBe(200);

    expect((await entriesOf(ctx.client, roundId))[0]).toEqual(first);
  });

  test("A skip may be changed until midnight like any decision", async ({ ctx, app }) => {
    await likeBudget(ctx.client, 1);
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b, c]);

    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "like"))).toBe(0);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 1, "skip"))).toBe(1);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "like"))).toBe(0);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "skip"))).toBe(1);
    expect(await likesLeftAfter(await decideBy(app, a, TODAY, 2, "pass"))).toBe(1);

    expect((await entriesOf(ctx.client, roundId)).map((e) => e.decision)).toEqual(["skip", "pass"]);
  });

  test("a skip of an ended day is refused as any decision, and a phone past midnight writes nothing", async ({
    ctx,
    app,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b], YESTERDAY);

    const answer = await decideBy(app, a, YESTERDAY, 1, "skip");

    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("round_expired");
    expect((await entriesOf(ctx.client, roundId))[0]?.decision).toBeNull();
  });
});

describe("a second pass (ADR-062 §6, §15)", () => {
  const before = (days: number) => new Date(T.getTime() - days * DAY_MS);

  /** Whether the entry at the place holds the mark. */
  async function marked(db: Queryable, roundId: string, position = 1) {
    const { rows } = await db.query<{ second_pass: boolean }>(
      "SELECT second_pass FROM round_entries WHERE round_id = $1 AND position = $2",
      [roundId, position],
    );
    return rows[0]?.second_pass;
  }

  describe("A pass is a second pass only with a pass of an earlier day behind it", () => {
    test.for([
      { past: [], before: 'never met "B"', marked: "a first" },
      { past: [[40, "pass"]], before: 'passed "B" forty days ago', marked: "a second" },
      {
        past: [
          [400, "pass"],
          [40, "pass"],
        ],
        before: 'passed "B" twice before',
        marked: "a second",
      },
      { past: [[40, "skip"]], before: 'skipped "B" forty days ago', marked: "a first" },
      { past: [[100, "like"]], before: 'liked "B" a hundred days ago', marked: "a first" },
    ] as const)("$before: the pass is $marked", async ({ past, marked: outcome }, { ctx, app }) => {
      const [a, b] = await cast(ctx, 2);
      if (!a || !b) throw new Error("cast not written");
      for (const [days, decision] of past) {
        await shownAt(ctx.client, before(days), a.accountId, b.accountId, decision);
      }
      const roundId = await roundFor(ctx.client, a, [b]);

      expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);

      expect(await marked(ctx.client, roundId)).toBe(outcome === "a second");
    });
  });

  test("A pass changed back and forth the same day is one pass", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b]);

    for (const decision of ["pass", "like", "pass"]) {
      expect((await decideBy(app, a, TODAY, 1, decision)).status).toBe(200);
    }

    expect(await marked(ctx.client, roundId)).toBe(false);
  });

  test("Changing a second pass clears its mark", async ({ ctx, app }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await shownAt(ctx.client, before(40), a.accountId, b.accountId, "pass");
    const roundId = await roundFor(ctx.client, a, [b]);
    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    expect(await marked(ctx.client, roundId)).toBe(true);

    expect((await decideBy(app, a, TODAY, 1, "skip")).status).toBe(200);
    expect(await marked(ctx.client, roundId)).toBe(false);

    // Passed once more, the earlier day's pass still stands behind it.
    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);
    expect(await marked(ctx.client, roundId)).toBe(true);

    expect((await decideBy(app, a, TODAY, 1, "like")).status).toBe(200);
    expect(await marked(ctx.client, roundId)).toBe(false);
  });

  test("the mark reads another person's passes nowhere", async ({ ctx, app }) => {
    const [a, b, c] = await cast(ctx, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    // C passed B, and A passed somebody else: neither is A's pass of B.
    await shownAt(ctx.client, before(40), c.accountId, b.accountId, "pass");
    await shownAt(ctx.client, before(40), a.accountId, c.accountId, "pass");
    const roundId = await roundFor(ctx.client, a, [b]);

    expect((await decideBy(app, a, TODAY, 1, "pass")).status).toBe(200);

    expect(await marked(ctx.client, roundId)).toBe(false);
    expect((await exportRounds(ctx.client, a.accountId, 1))[0]?.entries[0]?.secondPass).toBe(false);
  });
});

describe("the filters on a decision (ADR-062 §8)", () => {
  /** A queue that says who was asked, and that the card fits or does not. */
  function asking(fit: boolean) {
    const asked: { db: Queryable; ids: readonly string[] }[] = [];
    const queue: Pick<Queue, "fits"> = {
      fits: async (db, _accountId, ids) => {
        asked.push({ db, ids });
        return new Set(fit ? ids : []);
      },
    };
    return { asked, queue };
  }

  const choice = (accountId: string, decision: "like" | "pass" | "skip" | "fish") => ({
    accountId,
    day: TODAY,
    position: 1,
    decision,
  });

  test("a new like or fish asks the fit in the decision's own transaction, once, of its one card", async () => {
    await withTwoConnections("kuutti-502-fit", async (pool) => {
      const [a, b] = await peopleWhoFit(pool, 2);
      if (!a || !b) throw new Error("cast not written");
      await logged(pool, a, TODAY, [b]);
      const { asked, queue } = asking(true);
      const deps = await depsOn(pool);

      await decide(deps, MATCHES, queue, choice(a, "like"));

      expect(asked.map(({ ids }) => ids)).toEqual([[b]]);
      expect(asked[0]?.db).not.toBe(pool);
      // The like stands now: changing it to a fish asks nothing, and nor does the same again.
      await decide(deps, MATCHES, queue, choice(a, "fish"));
      await decide(deps, MATCHES, queue, choice(a, "fish"));
      expect(asked).toHaveLength(1);
    });
  });

  test.for(["pass", "skip"] as const)("a %s asks nobody's filters", async (decision, { ctx }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundFor(ctx.client, a, [b]);
    const { asked, queue } = asking(false);

    await decide(await depsOn(ctx.client), MATCHES, queue, choice(a.accountId, decision));

    expect(asked).toEqual([]);
  });

  test("a like the fit refuses writes nothing and spends nothing", async ({ ctx }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b]);
    const { queue } = asking(false);

    await expect(
      decide(await depsOn(ctx.client), MATCHES, queue, choice(a.accountId, "fish")),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect((await entriesOf(ctx.client, roundId))[0]).toMatchObject({ decision: null });
    expect(
      await decide(await depsOn(ctx.client), MATCHES, FITS, choice(a.accountId, "fish")),
    ).toMatchObject({ fishToSend: false, likesLeft: 9 });
  });
});

describe("Rounds are kept a year, their entries and relaxations with them", () => {
  test.for([
    { days: 365, outcome: "stays" },
    { days: 366, outcome: "is gone, with its entry and relaxation" },
  ])("$days days old: it $outcome", async ({ days, outcome }, { ctx }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundFor(ctx.client, a, [b], addDays(TODAY, -days));
    await ctx.client.query(
      "INSERT INTO round_relaxation (round_id, field, kind) VALUES ($1, 'smoking', 'aside')",
      [roundId],
    );

    const pruned = await pruneRounds(ctx.client, T);

    const kept = outcome === "stays";
    expect(pruned).toBe(kept ? 0 : 1);
    expect((await entriesOf(ctx.client, roundId)).length).toBe(kept ? 1 : 0);
    const left = await ctx.client.query(
      `SELECT (SELECT count(*)::int FROM rounds WHERE id = $1) AS rounds,
              (SELECT count(*)::int FROM round_relaxation WHERE round_id = $1) AS relaxations`,
      [roundId],
    );
    expect(left.rows).toEqual([{ rounds: kept ? 1 : 0, relaxations: kept ? 1 : 0 }]);
  });
});

describe("the year's end", () => {
  test("the year is counted in Finnish days, and a round of today is never touched", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx, 2);
    if (!a || !b) throw new Error("cast not written");
    // 00:30 in Helsinki, still yesterday by the clock of Greenwich.
    const justAfterMidnight = new Date("2026-10-15T21:30:00.000Z");
    expect(finnishDay(justAfterMidnight)).toBe(TODAY);
    const today = await roundFor(ctx.client, a, [b]);
    const kept = await roundFor(ctx.client, a, [b], addDays(TODAY, -365));
    const gone = await roundFor(ctx.client, a, [b], addDays(TODAY, -366));

    expect(await pruneRounds(ctx.client, justAfterMidnight)).toBe(1);

    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM rounds WHERE id = ANY($1::uuid[])",
      [[today, kept, gone]],
    );
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([today, kept]));
  });
});
