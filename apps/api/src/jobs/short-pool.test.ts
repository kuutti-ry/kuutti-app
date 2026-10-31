import type { Queryable } from "@kuutti/db";
import {
  DealBreakersResponse,
  ErrorResponse,
  type ProfileFields,
  RelaxationAnswer,
  RelaxationsResponse,
  RelaxationUndone,
  RoundResponse,
} from "@kuutti/schema";
import { vi } from "vitest";
import { type App, createApp } from "../app.ts";
import { exportAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { saveRound } from "../matching/index.ts";
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
import { type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { buildRounds } from "./round-builder.ts";

// The short pool (#99, ADR-042, features/matching/short-pool.feature): the
// order of coming back, an unopened round, the offers and their steps, a
// relaxation and its undo at the routes, the next day's round, rule 7, a
// relaxed like, and "did not answer"; then the routes' edges. The pure rules
// are matching/pool.test.ts (relaxedBy) and matching/round-order.test.ts
// (comingBackOrder).

/** 04:00 in Helsinki: the night of 2026-10-20. */
const NIGHT = new Date("2026-10-20T01:00:00.000Z");
const DAY = finnishDay(NIGHT);
/** Noon the same day. */
const NOON = new Date("2026-10-20T09:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-21T01:00:00.000Z");
const NEXT_DAY = finnishDay(NEXT_NIGHT);

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

const deps = async (db: Queryable, now = NIGHT) => ({
  db,
  logger: (await captureLogger()).logger,
  now: () => now,
});

async function setConfig(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT coalesce(max(version), 0) + 1, $1, $2::jsonb, 'test' FROM matching_config WHERE key = $1`,
    [key, JSON.stringify(value)],
  );
}

/** Everybody's matching open in the pond, as the gate leaves it. */
async function opened(db: Queryable, pondId: string, ids: readonly string[]) {
  await db.query(
    `INSERT INTO gate (account_id, pond_id, admitted_at, opened_at, counted_at)
     SELECT id, $2, $3, $3, $3 FROM unnest($1::uuid[]) AS id`,
    [ids, pondId, new Date(NIGHT.getTime() - 24 * 3600 * 1000)],
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
  await opened(ctx.client, pond, [a, ...of.flat()]);
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

const daysBefore = (days: number) =>
  finnishDay(new Date(NIGHT.getTime() - days * 24 * 3600 * 1000));

/** An earlier round of `owner` with `candidate` in it, decided as said; opened unless told otherwise. */
async function shownBefore(
  db: Queryable,
  owner: string,
  candidate: string,
  days: number,
  decision: "like" | "pass" | null,
  opened = true,
) {
  const earlier = new Date(NIGHT.getTime() - days * 24 * 3600 * 1000);
  const built = await saveRound(await deps(db, earlier), {
    accountId: owner,
    day: daysBefore(days),
    ordering: "count",
    entries: [{ candidateId: candidate, reason: "matches_filters" }],
  });
  if (!built) throw new Error("earlier round not written");
  if (opened) {
    await db.query("UPDATE rounds SET opened_at = $2 WHERE id = $1", [built.roundId, earlier]);
  }
  if (decision) {
    await db.query("UPDATE round_entries SET decision = $2, decided_at = $3 WHERE round_id = $1", [
      built.roundId,
      decision,
      earlier,
    ]);
  }
}

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
    await setConfig(ctx.client, "round_size", 2);
    const { a, of } = await pondWith(ctx, "test-short-new-first", [
      { fields: { smoking: "never" }, count: 3 },
    ]);
    const [b, c, d] = of[0] ?? [];
    if (!b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, a, c, 45, null);
    await shownBefore(ctx.client, a, d, 40, null);

    await buildRounds(await deps(ctx.client));

    expect((await roundOf(ctx.client, a)).map((e) => [e.candidate_id, e.reason])).toEqual([
      [b, "matches_filters"],
      [c, "seen_before"],
    ]);
  });

  test("Earlier people come back undecided first, then passed, each shown longest ago first", async ({
    ctx,
  }) => {
    const { a, of } = await pondWith(ctx, "test-short-order", [
      { fields: { smoking: "never" }, count: 4 },
    ]);
    const [c, d, e, f] = of[0] ?? [];
    if (!c || !d || !e || !f) throw new Error("people not written");
    await shownBefore(ctx.client, a, f, 100, "pass");
    await shownBefore(ctx.client, a, d, 40, "like");
    await shownBefore(ctx.client, a, e, 120, "pass");
    await shownBefore(ctx.client, a, c, 45, null);

    await buildRounds(await deps(ctx.client));

    expect((await roundOf(ctx.client, a)).map((x) => [x.candidate_id, x.reason])).toEqual([
      [c, "seen_before"],
      [d, "seen_before"],
      [e, "seen_before"],
      [f, "seen_before"],
    ]);
  });

  test("somebody shown twice comes back by the later showing and its decision", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-twice-shown", [
      { fields: { smoking: "never" }, count: 2 },
    ]);
    const [c, d] = of[0] ?? [];
    if (!c || !d) throw new Error("people not written");
    // C was passed long ago and left undecided since: the latest showing puts C among the undecided.
    await shownBefore(ctx.client, a, c, 120, "pass");
    await shownBefore(ctx.client, a, c, 45, null);
    await shownBefore(ctx.client, a, d, 100, "pass");

    await buildRounds(await deps(ctx.client));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c, d]);
  });

  test("A round never opened showed nobody", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-unopened", [
      { fields: { smoking: "never" }, count: 1 },
    ]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 1, null, false);

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: b, reason: "matches_filters", relaxed_field: null },
    ]);
  });
});

describe("relaxing a deal-breaker for the day", () => {
  test("A short round offers each deal-breaker relaxed, with the pool's growth in steps", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-offers", [
      { fields: {}, count: 12 },
      { fields: { smoking: "regularly" }, count: 10 },
    ]);
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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

  test("A relaxation adds the people it lets in, labelled with the field, up to the room left", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "round_size", 3);
    const { a, of } = await pondWith(ctx, "test-short-relax", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 4 },
    ]);
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect((await readToday(app, headers)).entries).toHaveLength(1);

    const entries = await added(await relax(app, headers, UNANSWERED));

    const unanswered = new Set(of[1]);
    expect(entries.map((e) => [e.position, e.reason, e.relaxedField, e.decision])).toEqual([
      [2, "relaxed", "smoking", null],
      [3, "relaxed", "smoking", null],
    ]);
    const round = await roundOf(ctx.client, a);
    expect(round.slice(1).every((e) => unanswered.has(e.candidate_id))).toBe(true);
    expect(round.slice(1).map((e) => e.relaxed_field)).toEqual(["smoking", "smoking"]);
    // The answer's cards are the round's own, as its read serves them.
    expect((await readToday(app, headers)).entries?.slice(1)).toEqual(entries);
    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [UNANSWERED] });
  });

  test("One tap undoes a relaxation, and takes back its undecided cards only", async ({ ctx }) => {
    await setConfig(ctx.client, "round_size", 3);
    const { a } = await pondWith(ctx, "test-short-undo", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 4 },
    ]);
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await readToday(app, headers);
    const [liked, other] = await added(await relax(app, headers, UNANSWERED));
    if (!liked || !other) throw new Error("nothing added");
    const decided = await app.request(`/rounds/${DAY}/entries/${liked.position}/decision`, {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ decision: "like" }),
    });
    expect(decided.status).toBe(200);

    const undone = await undo(app, headers, "smoking");

    expect(undone.status).toBe(200);
    expect(RelaxationUndone.parse(await undone.json())).toEqual({ removed: [other.position] });
    expect((await readToday(app, headers)).entries?.map((e) => [e.position, e.decision])).toEqual([
      [1, null],
      [liked.position, "like"],
    ]);
    // round_size 3: the card before, the liked one and the one taken back; an undo gives no room back.
    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });
  });

  test("Tomorrow's round is built from the deal-breakers as stored", async ({ ctx }) => {
    await setConfig(ctx.client, "round_size", 3);
    const { a, of } = await pondWith(ctx, "test-short-tomorrow", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 6 },
    ]);
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    await readToday(app, headers);
    expect(await added(await relax(app, headers, UNANSWERED))).toHaveLength(2);

    await buildRounds(await deps(ctx.client, NEXT_NIGHT));

    const unanswered = new Set(of[1]);
    const tomorrow = await roundOf(ctx.client, a, NEXT_DAY);
    expect(tomorrow.filter((e) => unanswered.has(e.candidate_id))).toEqual([]);
    expect(tomorrow.every((e) => e.reason !== "relaxed")).toBe(true);
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
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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

  test("a like on a card two relaxations let in reaches its person", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-stacked-like", [
      { fields: { hasKids: "no" }, count: 1 },
    ]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await dealBreaker(ctx.client, a, "hasKids", ["yes_with_me"], false);
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await added(await relax(app, headers, UNANSWERED))).toEqual([]);
    const [card] = await added(await relax(app, headers, { field: "hasKids", kind: "aside" }));
    if (!card) throw new Error("nothing added");
    const liked = await app.request(`/rounds/${DAY}/entries/${card.position}/decision`, {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ decision: "like" }),
    });
    expect(liked.status).toBe(200);

    await buildRounds(await deps(ctx.client, NEXT_NIGHT));

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
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    expect(await roundOf(ctx.client, a)).toEqual([]);

    await added(await relax(app, headers, UNANSWERED));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([other]);
  });

  test("a relaxation adds nobody passed or shown within the cooldowns", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-cooling", [{ fields: {}, count: 3 }]);
    const [passed, shown, fresh] = of[0] ?? [];
    if (!passed || !shown || !fresh) throw new Error("people not written");
    await shownBefore(ctx.client, a, passed, 2, "pass");
    await shownBefore(ctx.client, a, shown, 3, null);
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    await added(await relax(app, headers, UNANSWERED));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([fresh]);
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
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    await added(await relax(app, headers, ASIDE));

    expect((await roundOf(ctx.client, a)).map((e) => e.candidate_id)).toEqual([c]);
  });

  test("A like on a relaxed card reaches its person", async ({ ctx }) => {
    const { a, of } = await pondWith(ctx, "test-short-relaxed-like", [{ fields: {}, count: 1 }]);
    const [b] = of[0] ?? [];
    if (!b) throw new Error("people not written");
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const [card] = await added(await relax(app, headers, UNANSWERED));
    if (!card) throw new Error("nothing added");
    const liked = await app.request(`/rounds/${DAY}/entries/${card.position}/decision`, {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ decision: "like" }),
    });
    expect(liked.status).toBe(200);
    // Without the like's waiver, A's stored deal-breaker keeps B away from A.
    expect((await roundOf(ctx.client, b)).map((e) => e.candidate_id)).toEqual([]);

    await buildRounds(await deps(ctx.client, NEXT_NIGHT));

    expect(await roundOf(ctx.client, b, NEXT_DAY)).toEqual([
      { candidate_id: a, reason: "liked_you", relaxed_field: null },
    ]);
  });

  test("The same deal-breaker is relaxed once a day", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-twice", [{ fields: {}, count: 4 }]);
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const { entries } = await readToday(app, headers);

    const byPerson = new Map(
      (await roundOf(ctx.client, a)).map((e, index) => [e.candidate_id, entries?.[index]]),
    );
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
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    const { entries } = await readToday(app, headers);

    const byPerson = new Map(
      (await roundOf(ctx.client, a)).map((e, index) => [e.candidate_id, entries?.[index]]),
    );
    expect(byPerson.get(b)?.card.fields.smoking).toBeUndefined();
    expect(byPerson.get(c)?.card.fields.smoking).toBeUndefined();
    expect(byPerson.get(b)?.notAnswered).toEqual(["smoking"]);
    expect(byPerson.get(c)?.notAnswered).toEqual(["smoking"]);
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

    await buildRounds(await deps(ctx.client));

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

    await buildRounds(await deps(ctx.client));

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
    await opened(ctx.client, pond, [a, tall, same, open]);
    return { a, tall, same, open };
  }

  test("holds in the round both ways, and a card says a person did not answer height", async ({
    ctx,
  }) => {
    const { a, tall, same, open } = await taller(ctx, "test-height-round");
    await buildRounds(await deps(ctx.client));

    const hers = (await roundOf(ctx.client, a)).map((e) => e.candidate_id);
    expect(new Set(hers)).toEqual(new Set([tall, open]));
    // Both ways: she is the one woman of the pond, and her filter keeps her off his round.
    expect((await roundOf(ctx.client, same)).map((e) => e.candidate_id)).toEqual([]);
    expect((await roundOf(ctx.client, tall)).map((e) => e.candidate_id)).toEqual([a]);

    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const { entries } = await readToday(app, headers);
    const byPerson = new Map(
      (await roundOf(ctx.client, a)).map((e, index) => [e.candidate_id, entries?.[index]]),
    );
    expect(byPerson.get(open)?.notAnswered).toEqual(["height"]);
    expect(byPerson.get(tall)?.notAnswered).toEqual([]);
  });

  test("a height hidden from the card is compared all the same (#515)", async ({ ctx }) => {
    const { a, tall, same, open } = await taller(ctx, "test-height-hidden");
    await hidden(ctx.client, [tall, same], "height");
    await buildRounds(await deps(ctx.client));

    const hers = (await roundOf(ctx.client, a)).map((e) => e.candidate_id);
    expect(new Set(hers)).toEqual(new Set([tall, open]));

    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);
    const { entries } = await readToday(app, headers);
    const byPerson = new Map(
      (await roundOf(ctx.client, a)).map((e, index) => [e.candidate_id, entries?.[index]]),
    );
    // The card says nothing of it, as of one not given (ADR-042 §8).
    expect(byPerson.get(tall)?.notAnswered).toEqual(["height"]);
  });

  test("a short round offers to set it aside for the day", async ({ ctx }) => {
    const { a, same } = await taller(ctx, "test-height-relaxed");
    await buildRounds(await deps(ctx.client));
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
      await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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
      const him = await people(ctx.client, pond, 2, men({}));
      if (!a) throw new Error("A not written");
      await dealBreaker(ctx.client, a, "smoking", ["never"], includeUnknown);
      await opened(ctx.client, pond, [a, ...him]);
      await buildRounds(await deps(ctx.client));
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
    await setConfig(ctx.client, "round_size", 1);
    const { a } = await pondWith(ctx, "test-short-full", [
      { fields: { smoking: "never" }, count: 1 },
      { fields: {}, count: 1 },
    ]);
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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

  test("a relaxation that runs out the day's cards is kept, its cards in the round, and says so with the wait", async ({
    ctx,
  }) => {
    const { a } = await pondWith(ctx, "test-short-card-budget", [{ fields: {}, count: 2 }]);
    await buildRounds(await deps(ctx.client));
    await setConfig(ctx.client, "exposure_cards_per_day", 0);
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
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [a]);
    const app = await appAt(ctx.client);
    const { headers } = await signInAs(ctx.client, a);

    expect(await offers(app, headers)).toEqual({ short: false, offers: [], relaxed: [] });
    expect((await relax(app, headers, UNANSWERED)).status).toBe(404);
    expect((await ctx.client.query("SELECT 1 FROM round_relaxation")).rows).toEqual([]);
  });

  test("undoing what was not relaxed today is not found", async ({ ctx }) => {
    const { a } = await pondWith(ctx, "test-short-undo-none", [{ fields: {}, count: 1 }]);
    await buildRounds(await deps(ctx.client));
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
    await opened(ctx.client, pond, [other]);
    await buildRounds(await deps(ctx.client));
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
    await buildRounds(await deps(ctx.client));
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
      ]),
    ).toEqual([["relaxed", "smoking", "Smoking"]]);
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
