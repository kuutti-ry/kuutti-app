import type { Queryable } from "@kuutti/db";
import {
  DealBreakersResponse,
  ErrorResponse,
  type ProfileFields,
  QUEUE_PAGE,
  RelaxationAnswer,
  RelaxationsResponse,
  RelaxationUndone,
  RoundResponse,
} from "@kuutti/schema";
import { vi } from "vitest";
import { type App, createApp } from "../app.ts";
import { exportAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signInAs } from "../test/account.ts";
import {
  captureLogger,
  describe,
  englishT,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { HOME, HOMES, openPond, type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { endedConversation, shownAt } from "../test/rounds.ts";
import { fillQueue } from "./round-builder.ts";

// The short pool (#99, ADR-042, ADR-062 §10,
// features/matching/short-pool.feature): the order of coming back, when a round
// is short, the offers and their steps, a relaxation and its undo at the routes,
// a page at a time, the next day's queue, rule 7, a relaxed like, a move, and
// "did not answer"; then the routes' edges. The pure rules are
// matching/pool.test.ts (relaxedBy) and matching/round-order.test.ts
// (comingBackOrder).

/** Noon in Helsinki, 2026-10-20. */
const NOON = new Date("2026-10-20T09:00:00.000Z");
const DAY = finnishDay(NOON);
const DAY_MS = 24 * 3600 * 1000;
const NEXT_NOON = new Date("2026-10-21T09:00:00.000Z");
const NEXT_DAY = finnishDay(NEXT_NOON);

/** A woman who seeks men and does not smoke; with a deal-breaker on smoking unless told otherwise. */
const HER: PeopleOptions = {
  gender: "woman",
  seeks: ["man"],
  complete: true,
  consented: true,
  fields: { smoking: "never", hasKids: "yes_with_me" },
};
const MEN: PeopleOptions = { gender: "man", seeks: ["woman"], complete: true, consented: true };
const men = (fields: ProfileFields): PeopleOptions => ({ ...MEN, fields });

const deps = async (db: Queryable, now = NOON) => ({
  db,
  logger: (await captureLogger()).logger,
  now: () => now,
});

/** The person's next people, as a read that finds nothing left adds them: the day opened and its first page. */
const opens = async (db: Queryable, accountId: string, now = NOON) =>
  fillQueue(await deps(db, now), accountId);

async function setConfig(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT coalesce(max(version), 0) + 1, $1, $2::jsonb, 'test' FROM matching_config WHERE key = $1`,
    [key, JSON.stringify(value)],
  );
}

/** A deal-breaker of the person's, stored as the deal-breakers route stores it. */
async function dealBreaker(
  db: Queryable,
  accountId: string,
  field: string,
  accept: string[],
  includeUnknown: boolean,
) {
  await db.query(
    `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
     VALUES ($1, $2, $3::jsonb, 'hard', $4)`,
    [accountId, field, JSON.stringify(accept), includeUnknown],
  );
}

/** The answer stays off these people's cards (#515), as a save of the profile leaves it. */
async function hidden(db: Queryable, ids: readonly (string | undefined)[], field: string) {
  await db.query("UPDATE profile SET hidden_fields = $2 WHERE account_id = ANY($1::uuid[])", [
    ids,
    [field],
  ]);
}

/** "A", one woman with a deal-breaker on smoking, and the men of the pond; everybody's matching open. */
async function pondWith(
  ctx: TestContext,
  slug: string,
  groups: { fields: ProfileFields; count: number }[],
  includeUnknown = false,
) {
  const pond = await pondNamed(ctx.client, slug);
  const [a] = await people(ctx.client, pond, 1, HER);
  if (!a) throw new Error("A not written");
  await dealBreaker(ctx.client, a, "smoking", ["never"], includeUnknown);
  const of: string[][] = [];
  for (const group of groups)
    of.push(await people(ctx.client, pond, group.count, men(group.fields)));
  await openPond(ctx.client, pond);
  return { pond, a, of };
}

type Card = { candidate_id: string; reason: string; relaxed_field: string | null };

async function roundOf(db: Queryable, accountId: string, day = DAY): Promise<Card[]> {
  const { rows } = await db.query<Card>(
    `SELECT e.candidate_id, e.reason, e.relaxed_field FROM rounds r
       JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day = $2 ORDER BY e.position`,
    [accountId, day],
  );
  return rows;
}

const daysAgo = (days: number) => new Date(NOON.getTime() - days * DAY_MS);

/** `owner` was shown `candidate` `days` ago and decided as said; with no decision a card displayed and left. */
const shownBefore = (
  db: Queryable,
  owner: string,
  candidate: string,
  days: number,
  decision: "like" | "pass" | "skip" | null,
) => shownAt(db, daysAgo(days), owner, candidate, decision);

async function appAt(db: Queryable, now = NOON): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => now });
}

type Headers = Record<string, string>;
const jsonHeaders = (headers: Headers) => ({ ...headers, "content-type": "application/json" });

async function readToday(app: App, headers: Headers): Promise<RoundResponse> {
  const answer = await app.request("/rounds/today", { headers });
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

const decide = (app: App, headers: Headers, position: number, decision: string) =>
  app.request(`/rounds/${DAY}/entries/${position}/decision`, {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ decision }),
  });

/** Every card of a read or an answer, passed. */
async function passAll(app: App, headers: Headers, entries: RoundResponse["entries"]) {
  for (const entry of entries ?? []) {
    expect((await decide(app, headers, entry.position, "pass")).status).toBe(200);
  }
}

async function offers(app: App, headers: Headers, day = DAY): Promise<RelaxationsResponse> {
  const answer = await app.request(`/rounds/${day}/relaxations`, { headers });
  expect(answer.status).toBe(200);
  return RelaxationsResponse.parse(await answer.json());
}

const relax = (app: App, headers: Headers, body: unknown, day = DAY) =>
  app.request(`/rounds/${day}/relaxations`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });

const putHome = (app: App, headers: Headers, body: unknown) =>
  app.request("/account/home", {
    method: "PUT",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });

const undo = (app: App, headers: Headers, field: string, day = DAY) =>
  app.request(`/rounds/${day}/relaxations/${field}`, { method: "DELETE", headers });

async function added(response: Response) {
  expect(response.status).toBe(200);
  return RelaxationAnswer.parse(await response.json()).entries;
}

const codeOf = async (response: Response) => ErrorResponse.parse(await response.json()).error.code;

const UNANSWERED = { field: "smoking", kind: "unanswered" } as const;
const ASIDE = { field: "smoking", kind: "aside" } as const;

describe("coming back", () => {
  test("Everybody new comes before anybody shown before", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-new-first", [
      { fields: { smoking: "never" }, count: 3 },
    ]);
    const [b, c, d] = of[0] ?? [];
    if (!b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, a, c, 45, null);
    await shownBefore(ctx.client, a, d, 40, null);

    await opens(ctx.client, a);

    expect((await roundOf(ctx.client, a)).map((e) => [e.candidate_id, e.reason])).toEqual([
      [b, "matches_filters"],
      [c, "seen_before"],
      [d, "seen_before"],
    ]);
  });

  test("Earlier people come back skipped first, then passed, then liked with no answer, then former conversations, each shown longest ago first", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-order", [
      { fields: { smoking: "never" }, count: 8 },
    ]);
    const [skippedFirst, skippedLater, passedFirst, passedLater, likedFirst, likedLater] =
      of[0] ?? [];
    const [endedFirst, endedLater] = of[0]?.slice(6) ?? [];
    if (
      !skippedFirst ||
      !skippedLater ||
      !passedFirst ||
      !passedLater ||
      !likedFirst ||
      !likedLater ||
      !endedFirst ||
      !endedLater
    ) {
      throw new Error("people not written");
    }
    // Written against the order, and each group's days overlapping the others'.
    await endedConversation(ctx.client, a, endedLater, daysAgo(95), "archived");
    await shownBefore(ctx.client, a, endedLater, 96, "like");
    await endedConversation(ctx.client, a, endedFirst, daysAgo(91), "closed");
    await shownBefore(ctx.client, a, endedFirst, 150, "like");
    await shownBefore(ctx.client, a, likedLater, 91, "like");
    await shownBefore(ctx.client, a, likedFirst, 100, "like");
    await shownBefore(ctx.client, a, passedLater, 31, "pass");
    await shownBefore(ctx.client, a, passedFirst, 120, "pass");
    await shownBefore(ctx.client, a, skippedLater, 1, null);
    await shownBefore(ctx.client, a, skippedFirst, 200, "skip");

    await opens(ctx.client, a);

    expect((await roundOf(ctx.client, a)).map((x) => [x.candidate_id, x.reason])).toEqual(
      [
        skippedFirst,
        skippedLater,
        passedFirst,
        passedLater,
        likedFirst,
        likedLater,
        endedFirst,
        endedLater,
      ].map((id) => [id, "seen_before"]),
    );
  });

  test("a former conversation whose rounds have gone comes back by the day it ended, and stays one", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-former", [
      { fields: { smoking: "never" }, count: 3 },
    ]);
    const [first, later, liked] = of[0] ?? [];
    if (!first || !later || !liked) throw new Error("people not written");
    await endedConversation(ctx.client, a, later, daysAgo(100), "closed");
    await endedConversation(ctx.client, a, first, daysAgo(200), "archived");
    await shownBefore(ctx.client, a, liked, 300, "like");

    await opens(ctx.client, a);

    // Nothing of them is left in the rounds, and they are no new people.
    expect((await roundOf(ctx.client, a)).map((x) => [x.candidate_id, x.reason])).toEqual([
      [liked, "seen_before"],
      [first, "seen_before"],
      [later, "seen_before"],
    ]);
  });

  test("somebody shown twice comes back by the later showing and its decision", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-twice-shown", [
      { fields: { smoking: "never" }, count: 2 },
    ]);
    const [c, d] = of[0] ?? [];
    if (!c || !d) throw new Error("people not written");
    // C was passed long ago and left undecided since: the latest showing puts C among the skipped.
    await shownBefore(ctx.client, a, c, 120, "pass");
    await shownBefore(ctx.client, a, c, 45, null);
    await shownBefore(ctx.client, a, d, 100, "pass");

    await opens(ctx.client, a);

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c, d]);
  });
});

describe("relaxing a deal-breaker for the day", () => {
  test("A round is short once no new person is left in the queue", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-when", [
      { fields: { smoking: "never" }, count: QUEUE_PAGE + 1 },
      { fields: {}, count: 1 },
    ]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const first = await readToday(app, headers);
    expect(first.entries).toHaveLength(QUEUE_PAGE);

    // One new person is left out of the log: no offers yet.
    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });

    await passAll(app, headers, first.entries);
    expect((await readToday(app, headers)).entries).toHaveLength(1);

    expect(await offers(app, headers)).toEqual({
      short: true,
      offers: [
        { ...UNANSWERED, more: 0 },
        { ...ASIDE, more: 0 },
      ],
      relaxed: [],
    });
  });

  test("somebody seen before keeps no round from being short", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-seen", [
      { fields: { smoking: "never" }, count: 11 },
      { fields: {}, count: 1 },
    ]);
    for (const seen of of[0] ?? []) await shownBefore(ctx.client, a, seen, 1, "skip");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect((await offers(app, headers)).short).toBe(true);
    // One of the eleven is left out of the log, and comes as seen before once these are read.
    expect(await roundOf(ctx.client, a)).toHaveLength(QUEUE_PAGE);
  });

  test("A short round offers each deal-breaker relaxed, with the pool's growth in steps", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-offers", [
      { fields: {}, count: 12 },
      { fields: { smoking: "regularly" }, count: 10 },
    ]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({
      short: true,
      offers: [
        { ...UNANSWERED, more: 10 },
        { ...ASIDE, more: 20 },
      ],
      relaxed: [],
    });
  });

  test("Reading the offers relaxes nothing", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-read-only", [{ fields: {}, count: 3 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const before = {
      round: await roundOf(ctx.client, a),
      preferences: (
        await ctx.client.query("SELECT * FROM preferences WHERE account_id = $1 ORDER BY field", [
          a,
        ])
      ).rows,
    };

    await offers(app, headers);
    await offers(app, headers);

    expect(await roundOf(ctx.client, a)).toEqual(before.round);
    expect(
      (
        await ctx.client.query("SELECT * FROM preferences WHERE account_id = $1 ORDER BY field", [
          a,
        ])
      ).rows,
    ).toEqual(before.preferences);
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });

  test("A relaxation adds a page of the people it lets in, labelled with the field, and the queue goes on to the rest", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-relax", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: QUEUE_PAGE + 2 },
    ]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await passAll(app, headers, (await readToday(app, headers)).entries);

    const entries = await added(await relax(app, headers, UNANSWERED));

    const unanswered = new Set(of[1]);
    expect(entries.map((e) => [e.position, e.reason, e.relaxedField, e.decision])).toEqual(
      Array.from({ length: QUEUE_PAGE }, (_, i) => [i + 2, "relaxed", "smoking", null]),
    );
    const round = await roundOf(ctx.client, a);
    expect(round.slice(1).every((e) => unanswered.has(e.candidate_id))).toBe(true);
    // The answer's cards are the round's own, as its read serves them.
    expect((await readToday(app, headers)).entries).toEqual(entries);
    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [UNANSWERED] });

    await passAll(app, headers, entries);
    const rest = await readToday(app, headers);

    expect(rest.entries?.map((e) => [e.position, e.reason, e.relaxedField])).toEqual([
      [12, "relaxed", "smoking"],
      [13, "relaxed", "smoking"],
    ]);
    expect((await roundOf(ctx.client, a)).slice(-2).map((e) => e.relaxed_field)).toEqual([
      "smoking",
      "smoking",
    ]);
    await passAll(app, headers, rest.entries);
    expect((await readToday(app, headers)).entries).toEqual([]);
    expect(await offers(app, headers)).toEqual({ short: true, offers: [], relaxed: [UNANSWERED] });
  });

  test("the rest of a relaxation carries every relaxation of the day it needs", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-rest-needs", [
      { fields: { hasKids: "no" }, count: QUEUE_PAGE + 1 },
    ]);
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await added(await relax(app, headers, UNANSWERED))).toEqual([]);
    const page = await added(await relax(app, headers, { field: "hasKids", kind: "aside" }));
    expect(page).toHaveLength(QUEUE_PAGE);
    await passAll(app, headers, page);

    expect((await readToday(app, headers)).entries).toHaveLength(1);
    const { rows } = await ctx.client.query<{ relaxed_with: string[] }>(
      `SELECT e.relaxed_with FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND e.candidate_id = ANY($2::uuid[]) AND e.decision IS NULL`,
      [a, of[0]],
    );
    expect(rows.map((row) => [...row.relaxed_with].sort())).toEqual([["hasKids", "smoking"]]);

    // So undoing either takes it back.
    expect(
      RelaxationUndone.parse(await (await undo(app, headers, "smoking")).json()).removed,
    ).toEqual([QUEUE_PAGE + 1]);
  });

  test("One tap undoes a relaxation, and takes back its undecided cards only", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-undo", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 4 },
    ]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await readToday(app, headers);
    const [liked, ...others] = await added(await relax(app, headers, UNANSWERED));
    if (!liked || others.length !== 3) throw new Error("nothing added");
    expect((await decide(app, headers, liked.position, "like")).status).toBe(200);

    const undone = await undo(app, headers, "smoking");

    expect(undone.status).toBe(200);
    expect(RelaxationUndone.parse(await undone.json())).toEqual({
      removed: others.map((card) => card.position),
    });
    expect((await readToday(app, headers)).entries?.map((e) => [e.position, e.decision])).toEqual([
      [1, null],
    ]);
    expect((await roundOf(ctx.client, a)).map((e) => e.relaxed_field)).toEqual([null, "smoking"]);
    // Their places stay given: tapped again, the three come after the highest.
    const again = await added(await relax(app, headers, ASIDE));
    expect(again.map((card) => card.position)).toEqual([6, 7, 8]);
  });

  test("A change to a deal-breaker keeps the day's relaxation of its field", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-changed", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: { smoking: "regularly" }, count: 1 },
    ]);
    const [b] = of[1] ?? [];
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await readToday(app, headers);
    const [card] = await added(await relax(app, headers, ASIDE));
    if (!card) throw new Error("nothing added");

    const changed = await app.request("/preferences/deal-breakers", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({
        dealBreakers: [{ field: "smoking", accept: ["never", "quitting"], includeUnknown: false }],
      }),
    });

    expect(changed.status).toBe(200);
    expect((await readToday(app, headers)).entries?.map((e) => e.position)).toContain(
      card.position,
    );
    const again = await relax(app, headers, ASIDE);
    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("already_relaxed");

    await opens(ctx.client, a, NEXT_NOON);
    const tomorrow = await roundOf(ctx.client, a, NEXT_DAY);
    expect(tomorrow.map((e) => e.candidate_id)).not.toContain(b);
  });

  test("Tomorrow's queue reads the deal-breakers as stored", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-tomorrow", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 6 },
    ]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await readToday(app, headers);
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(6);

    await opens(ctx.client, a, NEXT_NOON);

    const unanswered = new Set(of[1]);
    const tomorrow = await roundOf(ctx.client, a, NEXT_DAY);
    expect(tomorrow.filter((e) => unanswered.has(e.candidate_id))).toEqual([]);
    expect(tomorrow.map((e) => e.reason)).toEqual(["matches_filters"]);
  });

  test("relaxations add up, and undoing the first takes back a card that needed both", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-stacked", [
      { fields: { hasKids: "yes_with_me" }, count: 1 },
      { fields: { hasKids: "no" }, count: 1 },
    ]);
    const [c] = of[0] ?? [];
    const [b] = of[1] ?? [];
    if (!b || !c) throw new Error("people not written");
    // A's second deal-breaker: kids as A has them. B fails it and did not answer smoking; C only the latter.
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(1);
    const both = await added(await relax(app, headers, { field: "hasKids", kind: "aside" }));
    expect(both.map((e) => e.relaxedField)).toEqual(["hasKids"]);
    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c, b]);

    const undone = await undo(app, headers, "smoking");

    expect(RelaxationUndone.parse(await undone.json()).removed).toHaveLength(2);
    expect(await roundOf(ctx.client, a)).toEqual([]);
    expect((await offers(app, headers)).relaxed).toEqual([{ field: "hasKids", kind: "aside" }]);
  });

  test("undoing the first relaxation keeps a later one's card that did not need it", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-stacked-keep", [
      { fields: { hasKids: "yes_with_me" }, count: 1 },
      { fields: { smoking: "never", hasKids: "no" }, count: 1 },
    ]);
    const [b] = of[0] ?? [];
    const [d] = of[1] ?? [];
    if (!b || !d) throw new Error("people not written");
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    // B needs smoking alone, D kids alone.
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(1);
    expect(
      await added(await relax(app, headers, { field: "hasKids", kind: "aside" })),
    ).toHaveLength(1);

    await undo(app, headers, "smoking");

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([d]);
  });

  test("a person whose profile no longer counts as complete is offered nothing, and relaxes nothing", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-incomplete", [{ fields: {}, count: 2 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await added(await relax(app, headers, ASIDE));
    // The profile loses what made it complete: the pond no longer counts A.
    await ctx.client.query(
      "UPDATE profile SET bio = NULL, bio_preset = NULL WHERE account_id = $1",
      [a],
    );

    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [ASIDE] });
    expect((await relax(app, headers, { field: "smoking", kind: "unanswered" })).status).toBe(409);
    expect((await relax(app, headers, { field: "hasKids", kind: "aside" })).status).toBe(404);
  });

  test("a round in a pond closed since is offered nothing, and relaxes nothing (ADR-060 §1)", async ({
    ctx,
  }) => {
    const { a, pond } = await pondWith(ctx, "test-short-closed", [{ fields: {}, count: 2 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect((await offers(app, headers)).offers).not.toEqual([]);

    await ctx.client.query("UPDATE ponds SET matching_open = false WHERE id = $1", [pond]);

    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });
    expect((await relax(app, headers, ASIDE)).status).toBe(404);
  });

  test("a like on a card two relaxations let in reaches its person", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-stacked-like", [
      { fields: { hasKids: "no" }, count: 1 },
    ]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await added(await relax(app, headers, UNANSWERED))).toEqual([]);
    const [card] = await added(await relax(app, headers, { field: "hasKids", kind: "aside" }));
    if (!card) throw new Error("nothing added");
    expect((await decide(app, headers, card.position, "like")).status).toBe(200);

    await opens(ctx.client, b, NEXT_NOON);

    expect(await roundOf(ctx.client, b, NEXT_DAY)).toEqual([
      { candidate_id: a, reason: "liked_you", relaxed_field: null },
    ]);
  });

  test("somebody whose like waits on the person never comes in by a relaxation", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-waiting", [{ fields: {}, count: 2 }]);
    const [liker, other] = of[0] ?? [];
    if (!liker || !other) throw new Error("people not written");
    // The liker's like of yesterday waits on A, whose smoking deal-breaker keeps the liker away.
    await shownBefore(ctx.client, liker, a, 1, "like");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await roundOf(ctx.client, a)).toEqual([]);

    await added(await relax(app, headers, UNANSWERED));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([other]);
  });

  test("a relaxation adds nobody within their clock, and new people before those seen", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-cooling", [{ fields: {}, count: 4 }]);
    const [passed, liked, skipped, fresh] = of[0] ?? [];
    if (!passed || !liked || !skipped || !fresh) throw new Error("people not written");
    await shownBefore(ctx.client, a, passed, 2, "pass");
    await shownBefore(ctx.client, a, liked, 3, "like");
    await shownBefore(ctx.client, a, skipped, 3, "skip");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    await added(await relax(app, headers, UNANSWERED));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([fresh, skipped]);
  });

  test("A relaxation never lets in somebody whose own filters exclude the person", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-rule-7", [
      { fields: { hasKids: "no" }, count: 1 },
      { fields: {}, count: 1 },
    ]);
    const [b] = of[0] ?? [];
    const [c] = of[1] ?? [];
    if (!b || !c) throw new Error("people not written");
    // B did not answer smoking, and has a kids deal-breaker of his own that A's answer fails.
    await dealBreaker(ctx.client, b, "hasKids", ["no"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    await added(await relax(app, headers, ASIDE));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c]);
  });

  test("A like on a relaxed card reaches its person", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-relaxed-like", [{ fields: {}, count: 1 }]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const [card] = await added(await relax(app, headers, UNANSWERED));
    if (!card) throw new Error("nothing added");
    expect((await decide(app, headers, card.position, "like")).status).toBe(200);
    // Without the like's waiver, A's stored deal-breaker keeps B away from A.
    await opens(ctx.client, b);
    expect((await roundOf(ctx.client, b)).map((e) => e.candidate_id)).toEqual([]);

    await opens(ctx.client, b, NEXT_NOON);

    expect(await roundOf(ctx.client, b, NEXT_DAY)).toEqual([
      { candidate_id: a, reason: "liked_you", relaxed_field: null },
    ]);
  });

  test("A like on a relaxed card goes through while the day's relaxation stands", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-like-relaxed", [{ fields: {}, count: 2 }]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const [card] = await added(await relax(app, headers, UNANSWERED));
    if (!card) throw new Error("nothing added");

    expect((await decide(app, headers, card.position, "like")).status).toBe(200);

    expect((await offers(app, headers)).relaxed).toEqual([UNANSWERED]);
  });

  test("a card that needs a relaxation is gone with it, and its place answers not_found", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-like-undone", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const [card] = await added(await relax(app, headers, UNANSWERED));
    if (!card) throw new Error("nothing added");
    expect((await undo(app, headers, "smoking")).status).toBe(200);

    const refused = await decide(app, headers, card.position, "like");

    expect(refused.status).toBe(404);
    expect(await codeOf(refused)).toBe("not_found");
  });

  test("The same deal-breaker is relaxed once a day", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-twice", [{ fields: {}, count: 4 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(4);
    const before = await roundOf(ctx.client, a);

    const again = await relax(app, headers, ASIDE);

    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("already_relaxed");
    expect(await roundOf(ctx.client, a)).toEqual(before);
  });

  test("A card says which of the person's deal-breakers its person did not answer", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(
      ctx,
      "test-short-not-answered",
      [
        { fields: {}, count: 1 },
        { fields: { smoking: "never" }, count: 1 },
      ],
      true,
    );
    const [b] = of[0] ?? [];
    const [c] = of[1] ?? [];
    if (!b || !c) throw new Error("people not written");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const { entries } = await readToday(app, headers);

    const byPerson = new Map(entries?.map((entry) => [entry.card.accountId, entry]));
    expect(byPerson.get(b)?.notAnswered).toEqual(["smoking"]);
    expect(byPerson.get(c)?.notAnswered).toEqual([]);
    expect(byPerson.get(b)?.relaxedField).toBeUndefined();
  });

  test("A hidden answer reads on a card as one not given", async ({ ctx }) => {
    const { a, of } = await pondWith(
      ctx,
      "test-short-hidden-label",
      [
        { fields: {}, count: 1 },
        { fields: { smoking: "never" }, count: 1 },
      ],
      true,
    );
    const [b] = of[0] ?? [];
    const [c] = of[1] ?? [];
    if (!b || !c) throw new Error("people not written");
    await hidden(ctx.client, [c], "smoking");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const { entries } = await readToday(app, headers);

    const byPerson = new Map(entries?.map((entry) => [entry.card.accountId, entry]));
    expect(byPerson.get(b)?.card.fields.smoking).toBeUndefined();
    expect(byPerson.get(c)?.card.fields.smoking).toBeUndefined();
    expect(byPerson.get(b)?.notAnswered).toEqual(["smoking"]);
    expect(byPerson.get(c)?.notAnswered).toEqual(["smoking"]);
  });
});

describe("the inbox stop and the short pool (ADR-062 §4)", () => {
  /** matching_config inbox_stop, the maintainer's of 01/11/2026. */
  const STOP = 30;

  /** A woman's likes of `liked` until their inbox is at the stop. */
  async function pileOn(ctx: TestContext, pond: string, liked: string) {
    const likers = await people(ctx.client, pond, STOP, HER);
    for (const liker of likers) await shownBefore(ctx.client, liker, liked, 1, "like");
  }

  test("The stop holds a person out of what a relaxation lets in", async ({ ctx }) => {
    const { pond, a, of } = await pondWith(ctx, "test-stop-relaxed", [
      { fields: {}, count: QUEUE_PAGE + 3 },
    ]);
    const [held, ...others] = of[0] ?? [];
    if (!held) throw new Error("people not written");
    await pileOn(ctx, pond, held);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const page = await added(await relax(app, headers, UNANSWERED));

    expect(page).toHaveLength(QUEUE_PAGE);
    await passAll(app, headers, page);
    await passAll(app, headers, (await readToday(app, headers)).entries);
    expect((await readToday(app, headers)).entries).toEqual([]);
    const log = (await roundOf(ctx.client, a)).map((e) => e.candidate_id);
    expect(new Set(log)).toEqual(new Set(others));
  });

  test("somebody held is no new person left: the round is short, and offers", async ({ ctx }) => {
    const { pond, a, of } = await pondWith(ctx, "test-stop-short", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 1 },
    ]);
    const [held] = of[0] ?? [];
    if (!held) throw new Error("people not written");
    await pileOn(ctx, pond, held);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({
      short: true,
      offers: [
        { ...UNANSWERED, more: 0 },
        { ...ASIDE, more: 0 },
      ],
      relaxed: [],
    });
  });

  test("a relaxation that would let in nobody but somebody held is not offered", async ({
    ctx,
  }) => {
    const { pond, a, of } = await pondWith(ctx, "test-stop-not-offered", [
      { fields: {}, count: 1 },
    ]);
    const [held] = of[0] ?? [];
    if (!held) throw new Error("people not written");
    await pileOn(ctx, pond, held);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({ short: true, offers: [], relaxed: [] });
  });
});

describe("A hidden answer counts under a deal-breaker as a shown one does", () => {
  test.for([
    ["with", true],
    ["without", false],
  ] as const)("%s people who did not answer", async ([, includeUnknown], { ctx }) => {
    const { a, of } = await pondWith(
      ctx,
      `test-short-hidden-counts-${includeUnknown}`,
      [
        { fields: { smoking: "regularly" }, count: 1 },
        { fields: { smoking: "never" }, count: 1 },
      ],
      includeUnknown,
    );
    const [b] = of[0] ?? [];
    const [c] = of[1] ?? [];
    await hidden(ctx.client, [b, c], "smoking");

    await opens(ctx.client, a);

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c]);
  });
});

describe("a person's own hidden answer", () => {
  test("Hiding one's own answer leaves a deal-breaker on it in force", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-hidden-own", [
      { fields: { smoking: "regularly" }, count: 1 },
      { fields: { smoking: "never" }, count: 1 },
    ]);
    const [c] = of[1] ?? [];
    await hidden(ctx.client, [a], "smoking");

    await opens(ctx.client, a);

    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const stored = await app.request("/preferences/deal-breakers", { headers });
    expect(DealBreakersResponse.parse(await stored.json()).dealBreakers).toMatchObject([
      { field: "smoking", paused: false },
    ]);
    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c]);
  });
});

describe("a deal-breaker on height through the night (#508)", () => {
  /** "A", a woman of 170 cm who asks for somebody taller and lets through who did not answer, and the men of the pond. */
  async function taller(ctx: TestContext, slug: string) {
    const pond = await pondNamed(ctx.client, slug);
    const [a] = await people(ctx.client, pond, 1, { ...HER, fields: { height: 170 } });
    if (!a) throw new Error("A not written");
    await dealBreaker(ctx.client, a, "height", ["taller"], true);
    const [tall] = await people(ctx.client, pond, 1, men({ height: 171 }));
    const [same] = await people(ctx.client, pond, 1, men({ height: 170 }));
    const [open] = await people(ctx.client, pond, 1, men({}));
    if (!tall || !same || !open) throw new Error("people not written");
    await openPond(ctx.client, pond);
    return { a, tall, same, open };
  }

  test("holds in the round both ways, and a card says a person did not answer height", async ({
    ctx,
  }) => {
    const { a, tall, same, open } = await taller(ctx, "test-height-round");
    for (const id of [a, same, tall]) await opens(ctx.client, id);

    const hers = (await roundOf(ctx.client, a)).map((e) => e.candidate_id);
    expect(new Set(hers)).toEqual(new Set([tall, open]));
    // Both ways: she is the one woman of the pond, and her filter keeps her off his round.
    expect((await roundOf(ctx.client, same)).map((e) => e.candidate_id)).toEqual([]);
    expect((await roundOf(ctx.client, tall)).map((e) => e.candidate_id)).toEqual([a]);

    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const { entries } = await readToday(app, headers);
    const byPerson = new Map(entries?.map((entry) => [entry.card.accountId, entry]));
    expect(byPerson.get(open)?.notAnswered).toEqual(["height"]);
    expect(byPerson.get(tall)?.notAnswered).toEqual([]);
  });

  test("a height hidden from the card is compared all the same (#515)", async ({ ctx }) => {
    const { a, tall, same, open } = await taller(ctx, "test-height-hidden");
    await hidden(ctx.client, [tall, same], "height");
    await opens(ctx.client, a);

    const hers = (await roundOf(ctx.client, a)).map((e) => e.candidate_id);
    expect(new Set(hers)).toEqual(new Set([tall, open]));

    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const { entries } = await readToday(app, headers);
    const byPerson = new Map(entries?.map((entry) => [entry.card.accountId, entry]));
    // The card says nothing of it, as of one not given (ADR-042 §8).
    expect(byPerson.get(tall)?.notAnswered).toEqual(["height"]);
  });

  test("a short round offers to set it aside for the day", async ({ ctx }) => {
    const { a, same } = await taller(ctx, "test-height-relaxed");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const aside = { field: "height", kind: "aside" } as const;
    const { offers: offered } = await offers(app, headers);
    expect(offered.map(({ field, kind }) => ({ field, kind }))).toEqual([aside]);
    await added(await relax(app, headers, aside));
    const relaxed = (await roundOf(ctx.client, a)).find((e) => e.candidate_id === same);
    expect(relaxed).toMatchObject({ reason: "relaxed", relaxed_field: "height" });
  });
});

describe("a deal-breaker on distance through the night (#514, ADR-061 §7)", () => {
  const SET_ASIDE = { field: "distance", kind: "aside" } as const;

  /** "A" in Kallio who accepts nearby, and men at these homes; everybody's matching open. */
  async function nearbyOnly(ctx: TestContext, slug: string, homes: readonly string[]) {
    const pond = await pondNamed(ctx.client, slug);
    const [a] = await people(ctx.client, pond, 1, HER);
    if (!a) throw new Error("A not written");
    await dealBreaker(ctx.client, a, "distance", ["nearby"], true);
    const men: string[] = [];
    for (const home of homes) {
      const [man] = await people(ctx.client, pond, 1, { ...MEN, home });
      if (!man) throw new Error("a man not written");
      men.push(man);
    }
    await openPond(ctx.client, pond);
    return { a, men };
  }

  test("A short round offers a distance deal-breaker set aside, never for those who did not answer", async ({
    ctx,
  }) => {
    const { a } = await nearbyOnly(
      ctx,
      "test-distance-offer",
      Array.from({ length: 12 }, () => HOMES.close),
    );
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({
      short: true,
      offers: [{ ...SET_ASIDE, more: 10 }],
      relaxed: [],
    });
    const refused = await relax(app, headers, { field: "distance", kind: "unanswered" });
    expect(refused.status).toBe(404);
    expect(await codeOf(refused)).toBe("not_found");
    expect(await roundOf(ctx.client, a)).toEqual([]);
    const { rows } = await ctx.client.query("SELECT 1 FROM round_relaxation");
    expect(rows).toEqual([]);
  });

  test("A distance deal-breaker set aside lets in people beyond it, never against their own filters", async ({
    ctx,
  }) => {
    const { a, men } = await nearbyOnly(ctx, "test-distance-aside", [HOMES.close, HOMES.around]);
    const [b, c] = men;
    if (!b || !c) throw new Error("people not written");
    await dealBreaker(ctx.client, b, "distance", ["nearby"], true);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const cards = await added(await relax(app, headers, SET_ASIDE));

    expect(cards.map((card) => [card.card.accountId, card.distance, card.relaxedField])).toEqual([
      [c, "around", "distance"],
    ]);
    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: c, reason: "relaxed", relaxed_field: "distance" },
    ]);
  });

  test("A move closes nothing: the offers read the pool as it stands", async ({ ctx }) => {
    // The offer is on smoking, and the one man it would let in lives in Kallio.
    const { a } = await pondWith(ctx, "test-short-moved", [{ fields: {}, count: 1 }]);
    await dealBreaker(ctx.client, a, "distance", ["nearby", "close", "around"], true);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const open = await offers(app, headers);
    expect(open.offers.map((offer) => offer.field)).toEqual(["smoking", "smoking"]);

    expect((await putHome(app, headers, { postalCode: HOMES.far })).status).toBe(200);

    // From Rovaniemi he is past her distance as well: smoking alone lets nobody in.
    expect(await offers(app, headers)).toEqual({ short: true, offers: [], relaxed: [] });
    expect(await added(await relax(app, headers, UNANSWERED))).toEqual([]);
    expect((await undo(app, headers, "smoking")).status).toBe(200);

    expect((await putHome(app, headers, { postalCode: HOME })).status).toBe(200);

    expect(await offers(app, headers)).toEqual(open);
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(1);
  });

  test("set aside, it is undone as any other, and tomorrow's round filters again", async ({
    ctx,
  }) => {
    const { a, men } = await nearbyOnly(ctx, "test-distance-undo", [HOMES.close]);
    const [b] = men;
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await added(await relax(app, headers, SET_ASIDE));
    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([b]);

    const undone = await undo(app, headers, "distance");
    expect(RelaxationUndone.parse(await undone.json()).removed).toEqual([1]);
    expect(await roundOf(ctx.client, a)).toEqual([]);

    await opens(ctx.client, a, NEXT_NOON);
    expect(await roundOf(ctx.client, a, NEXT_DAY)).toEqual([]);
  });

  test("a like on a card a distance set aside let in reaches its person", async ({ ctx }) => {
    const { a, men } = await nearbyOnly(ctx, "test-distance-like", [HOMES.close]);
    const [b] = men;
    if (!b) throw new Error("people not written");
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const [card] = await added(await relax(app, headers, SET_ASIDE));
    if (!card) throw new Error("nothing added");
    expect((await decide(app, headers, card.position, "like")).status).toBe(200);

    await opens(ctx.client, b, NEXT_NOON);

    expect(await roundOf(ctx.client, b, NEXT_DAY)).toEqual([
      { candidate_id: a, reason: "liked_you", relaxed_field: null },
    ]);
  });

  test("A card never says that its person did not answer a distance", async ({ ctx }) => {
    const { a, men } = await nearbyOnly(ctx, "test-distance-card", [HOMES.nearby]);
    const [b] = men;
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const { entries } = await readToday(app, headers);

    expect(entries?.map((entry) => entry.card.accountId)).toEqual([b]);
    expect(entries?.[0]?.notAnswered).toEqual([]);
  });

  test("Every entry is written with its band, whichever way it came into the round", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-distance-every-way");
    const [a] = await people(ctx.client, pond, 1, HER);
    if (!a) throw new Error("A not written");
    await dealBreaker(ctx.client, a, "smoking", ["never"], true);
    const man = async (home: string, fields: ProfileFields = {}) => {
      const [id] = await people(ctx.client, pond, 1, { ...men(fields), home });
      if (!id) throw new Error("a man not written");
      return id;
    };
    const fresh = await man(HOMES.close);
    const waited = await man(HOMES.far);
    const seen = await man(HOMES.nearby);
    const relaxedIn = await man(HOMES.around, { smoking: "regularly" });
    await openPond(ctx.client, pond);
    await shownBefore(ctx.client, waited, a, 1, "like");
    await shownBefore(ctx.client, a, seen, 45, null);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await added(await relax(app, headers, ASIDE));

    const { entries } = await readToday(app, headers);

    expect(entries?.map((e) => [e.card.accountId, e.reason, e.distance])).toEqual([
      [waited, "liked_you", "far"],
      [fresh, "matches_filters", "close"],
      [seen, "seen_before", "nearby"],
      [relaxedIn, "relaxed", "around"],
    ]);

    // Measured when each was written: a relaxation's from the home of that moment.
    const later = await signInAs(ctx.client, relaxedIn);
    const moved = await app.request("/account/home", {
      method: "PUT",
      headers: jsonHeaders(later.headers),
      body: JSON.stringify({ postalCode: "96100" }),
    });
    expect(moved.status).toBe(200);
    const again = await readToday(app, headers);
    expect(again.entries?.map((e) => e.distance)).toEqual(["far", "close", "nearby", "around"]);
  });
});

describe("the routes' edges", () => {
  test("the relaxation routes need a session", async ({ ctx }) => {
    const app = await appAt(ctx.client);
    for (const [method, path] of [
      ["GET", `/rounds/${DAY}/relaxations`],
      ["POST", `/rounds/${DAY}/relaxations`],
      ["DELETE", `/rounds/${DAY}/relaxations/smoking`],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(UNANSWERED) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  test.for([
    ["a field that is no deal-breaker field", { field: "intent", kind: "aside" }],
    ["a kind off the list", { field: "smoking", kind: "widen" }],
    ["words beside the relaxation", { ...UNANSWERED, note: "please" }],
    ["no kind", { field: "smoking" }],
  ] as const)(
    "a relaxation with %s is refused before anything is read",
    async ([, body], { ctx }) => {
      const { a } = await pondWith(ctx, "test-short-invalid", [{ fields: {}, count: 1 }]);
      await opens(ctx.client, a);
      const app = await appAt(ctx.client);
      const { headers } = await signInAs(ctx.client, a);

      const response = await relax(app, headers, body);

      expect(response.status).toBe(400);
      expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
    },
  );

  test("a day that has ended answers round_expired, and one not begun is not found", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-days", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const later = await appAt(ctx.client, new Date("2026-10-21T09:00:00.000Z"));
    const { headers } = await signInAs(ctx.client, a);

    for (const response of [
      await later.request(`/rounds/${DAY}/relaxations`, { headers }),
      await relax(later, headers, UNANSWERED),
      await undo(later, headers, "smoking"),
    ]) {
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe("round_expired");
    }
    const app = await appAt(ctx.client);
    expect((await app.request(`/rounds/${NEXT_DAY}/relaxations`, { headers })).status).toBe(404);
  });

  test("with no round today, nothing is offered, relaxed or undone", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-short-no-round");
    const [a] = await people(ctx.client, pond, 1, HER);
    if (!a) throw new Error("A not written");
    await dealBreaker(ctx.client, a, "smoking", ["never"], false);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect((await app.request(`/rounds/${DAY}/relaxations`, { headers })).status).toBe(404);
    expect((await relax(app, headers, UNANSWERED)).status).toBe(404);
    expect((await undo(app, headers, "smoking")).status).toBe(404);
  });

  test.for([
    ["a field that is no deal-breaker of the person's", "languages", "aside", false, true],
    ["a paused deal-breaker", "smoking", "aside", false, false],
    ["unanswered where those people are let through already", "smoking", "unanswered", true, true],
  ] as const)(
    "%s is no relaxation to offer, and nothing is written",
    async ([, field, kind, includeUnknown, answered], { ctx }) => {
      const pond = await pondNamed(ctx.client, "test-short-not-offered");
      const [a] = await people(ctx.client, pond, 1, {
        ...HER,
        fields: answered ? HER.fields : { hasKids: "yes_with_me" },
      });
      await people(ctx.client, pond, 2, men({}));
      if (!a) throw new Error("A not written");
      await dealBreaker(ctx.client, a, "smoking", ["never"], includeUnknown);
      await openPond(ctx.client, pond);
      await opens(ctx.client, a);
      const app = await appAt(ctx.client);
      const { headers } = await signInAs(ctx.client, a);
      const before = await roundOf(ctx.client, a);

      const response = await relax(app, headers, { field, kind });

      expect(response.status).toBe(404);
      expect(await codeOf(response)).toBe("not_found");
      expect(await roundOf(ctx.client, a)).toEqual(before);
      expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
    },
  );

  test("a round that is not short offers nothing, and a relaxation that finds nobody adds no card", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-full", [
      { fields: { smoking: "never" }, count: QUEUE_PAGE + 1 },
    ]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });
    // Tapped all the same, it is recorded, adds nobody, and can be undone.
    expect(await added(await relax(app, headers, UNANSWERED))).toEqual([]);
    expect((await offers(app, headers)).relaxed).toEqual([UNANSWERED]);
    const undone = await undo(app, headers, "smoking");
    expect(RelaxationUndone.parse(await undone.json())).toEqual({ removed: [] });
  });

  test("offers neither a deal-breaker relaxed today nor a paused one, and keeps offering the others", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-offers-left", [
      { fields: { hasKids: "no" }, count: 12 },
      { fields: {}, count: 12 },
    ]);
    // A second deal-breaker A answered, and a third on languages, which A did not: paused.
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await dealBreaker(ctx.client, a, "languages", ["fi"], false);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await added(await relax(app, headers, UNANSWERED));

    const { short, offers: left, relaxed } = await offers(app, headers);

    expect(short).toBe(true);
    expect(relaxed).toEqual([UNANSWERED]);
    expect(left.map((offer) => [offer.field, offer.kind])).toEqual([
      ["hasKids", "unanswered"],
      ["hasKids", "aside"],
    ]);
  });

  test("a relaxation past a ceiling set in the panel is kept, its cards in the round, and says so with the wait", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-card-budget", [{ fields: {}, count: 2 }]);
    await opens(ctx.client, a);
    await setConfig(ctx.client, "exposure_cards_per_day", 1);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const response = await relax(app, headers, UNANSWERED);

    expect(response.status).toBe(429);
    expect(await codeOf(response)).toBe("card_budget_exceeded");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await roundOf(ctx.client, a)).map((e) => e.reason)).toEqual(["relaxed", "relaxed"]);
  });

  test("the routes take the clock of the day when the app is given none", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-clock", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const { headers } = await signInAs(ctx.client, a);
    // The harness's app passes no now, so the routes read the clock: frozen at noon of the round's day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
    try {
      const response = await ctx.app.request(`/rounds/${DAY}/relaxations`, { headers });
      expect(response.status).toBe(200);
      expect(RelaxationsResponse.parse(await response.json()).short).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test.for([
    ["GET", "/rounds/2026-02-30/relaxations"],
    ["GET", "/rounds/today/relaxations"],
    ["POST", "/rounds/today/relaxations"],
    ["DELETE", `/rounds/${DAY}/relaxations/intent`],
    ["DELETE", "/rounds/today/relaxations/smoking"],
  ] as const)("%s %s is refused before anything is read", async ([method, path], { ctx }) => {
    const { a } = await pondWith(ctx, "test-short-params", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const response = await app.request(path, {
      method,
      headers: jsonHeaders(headers),
      ...(method === "POST" ? { body: JSON.stringify(UNANSWERED) } : {}),
    });

    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("validation_failed");
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });

  test("a paused person's round offers nothing, and nothing in it can be relaxed", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-paused-owner", [{ fields: {}, count: 2 }]);
    await opens(ctx.client, a);
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [a]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });
    expect((await relax(app, headers, UNANSWERED)).status).toBe(404);
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });

  test("undoing what was not relaxed today is not found", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-undo-none", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const response = await undo(app, headers, "smoking");

    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("not_found");
  });

  test("a person's relaxation changes only their own round", async ({ ctx }) => {
    const { pond, a, of } = await pondWith(ctx, "test-short-own", [{ fields: {}, count: 3 }]);
    const [other] = await people(ctx.client, pond, 1, HER);
    if (!other) throw new Error("other not written");
    await dealBreaker(ctx.client, other, "smoking", ["never"], false);
    await openPond(ctx.client, pond);
    await opens(ctx.client, a);
    await opens(ctx.client, other);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const theirs = await roundOf(ctx.client, other);

    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(of[0]?.length ?? 0);

    expect(await roundOf(ctx.client, other)).toEqual(theirs);
    const otherHeaders = (await signInAs(ctx.client, other)).headers;
    expect((await offers(app, otherHeaders)).relaxed).toEqual([]);
    expect((await undo(app, otherHeaders, "smoking")).status).toBe(404);
  });

  test("the person's export names the field a relaxed card came in by", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-export", [{ fields: {}, count: 1 }]);
    await opens(ctx.client, a);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await added(await relax(app, headers, UNANSWERED));

    const { document } = await exportAccount(
      { ...(await deps(ctx.client, NOON)), version: "0.0.0-test" },
      a,
      englishT,
    );

    expect(
      document.rounds.items[0]?.entries.map((e) => [
        e.reason,
        e.relaxedField,
        e.relaxedFieldInWords,
        e.distance,
        e.distanceInWords,
      ]),
    ).toEqual([["relaxed", "smoking", "Smoking", "nearby", "Nearby"]]);
    expect(document.rounds.items[0]?.relaxations).toEqual([
      {
        field: "smoking",
        fieldInWords: "Smoking",
        kind: "unanswered",
        kindInWords: "Let through people who did not answer it, for the day",
        at: NOON.toISOString(),
      },
    ]);
  });
});
