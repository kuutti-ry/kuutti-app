import { type Queryable, SEED_PONDS } from "@kuutti/db";
// biome-ignore lint/style/noRestrictedImports: a test of the builder over the synthetic population (#95); nothing of it is bundled
import { generatePopulation, writePopulation } from "@kuutti/db/demo";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { type ProfileFields, RoundResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { exportRounds, inEachOthersPool, saveRound } from "../matching/index.ts";
import { signInAs } from "../test/account.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { countGates } from "./pond-gate.ts";
import { buildRoundOf, buildRounds, roundsJob } from "./round-builder.ts";

// The round builder (#95, ADR-035, features/matching/rounds.feature): who
// gets a round and whom it holds, the cooldowns, a conversation, the night
// and the day's first read, and the whole synthetic population. The order's
// rule alone is matching/round-order.test.ts.

/** 04:00 in Helsinki: the night of 2026-10-20. */
const NIGHT = new Date("2026-10-20T01:00:00.000Z");
const DAY = finnishDay(NIGHT);
/** Noon the same day. */
const NOON = new Date("2026-10-20T09:00:00.000Z");

/** Women who seek men, and men who seek women: each in the pool of every one of the others. */
const WOMEN: PeopleOptions = { gender: "woman", seeks: ["man"], complete: true, consented: true };
const MEN: PeopleOptions = { gender: "man", seeks: ["woman"], complete: true, consented: true };

const deps = async (db: Queryable, now = NIGHT) => ({
  db,
  logger: (await captureLogger()).logger,
  now: () => now,
});

/** A value of matching_config above every version a migration wrote, so it is the one read. */
async function setConfig(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT coalesce(max(version), 0) + 1, $1, $2::jsonb, 'test' FROM matching_config WHERE key = $1`,
    [key, JSON.stringify(value)],
  );
}

/** Where the gate stands for these people: matching open, let in only, or waiting in the line. */
async function gated(
  db: Queryable,
  pondId: string,
  ids: readonly string[],
  state: "open" | "admitted" | "waiting",
) {
  await db.query(
    `INSERT INTO gate (account_id, pond_id, admitted_at, place_said, opened_at, counted_at)
     SELECT id, $2,
            CASE WHEN $3 <> 'waiting' THEN $4::timestamptz END,
            CASE WHEN $3 = 'waiting' THEN 10 END,
            CASE WHEN $3 = 'open' THEN $4::timestamptz END,
            $4
       FROM unnest($1::uuid[]) AS id`,
    [ids, pondId, state, new Date(NIGHT.getTime() - 24 * 3600 * 1000)],
  );
}

/** A pond, `women` women and `men` men in it, everybody's matching open. */
async function pondOf(ctx: TestContext, slug: string, women: number, men: number) {
  const pond = await pondNamed(ctx.client, slug);
  const her = await people(ctx.client, pond, women, WOMEN);
  const him = await people(ctx.client, pond, men, MEN);
  await gated(ctx.client, pond, [...her, ...him], "open");
  return { pond, women: her, men: him };
}

type Card = { candidate_id: string; reason: string };

/** The cards of a person's round on a day, in order; null when they have no round. */
async function roundOf(db: Queryable, accountId: string, day = DAY): Promise<Card[] | null> {
  const { rows } = await db.query<{ candidate_id: string | null; reason: string | null }>(
    `SELECT e.candidate_id, e.reason FROM rounds r
       LEFT JOIN round_entries e ON e.round_id = r.id
      WHERE r.account_id = $1 AND r.day = $2 ORDER BY e.position`,
    [accountId, day],
  );
  if (rows.length === 0) return null;
  return rows.flatMap((row) =>
    row.candidate_id && row.reason ? [{ candidate_id: row.candidate_id, reason: row.reason }] : [],
  );
}

const candidates = (round: Card[] | null) => (round ?? []).map((card) => card.candidate_id);

/** The day `days` before the night's, as YYYY-MM-DD. */
const daysBefore = (days: number) =>
  finnishDay(new Date(NIGHT.getTime() - days * 24 * 3600 * 1000));

/** An earlier round of `owner` with `candidate` in it, decided as said. */
async function shownBefore(
  db: Queryable,
  owner: string,
  candidate: string,
  days: number,
  decision: "like" | "pass" | null,
) {
  const earlier = new Date(NIGHT.getTime() - days * 24 * 3600 * 1000);
  const built = await saveRound(await deps(db, earlier), {
    accountId: owner,
    day: daysBefore(days),
    ordering: "count",
    entries: [{ candidateId: candidate, reason: "matches_filters" }],
  });
  if (!built) throw new Error("earlier round not written");
  if (decision) {
    await db.query("UPDATE round_entries SET decision = $2, decided_at = $3 WHERE round_id = $1", [
      built.roundId,
      decision,
      earlier,
    ]);
  }
}

async function appAt(db: Queryable, now: Date): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => now });
}

async function readToday(app: App, db: Queryable, accountId: string): Promise<RoundResponse> {
  const who = await signInAs(db, accountId);
  const answer = await app.request("/rounds/today", { headers: who.headers });
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

describe("who gets a round", () => {
  test("Everybody whose matching has opened gets a round for the day, and nobody else", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-who");
    const [a, b, c] = await people(ctx.client, pond, 3, WOMEN);
    const men = await people(ctx.client, pond, 2, MEN);
    if (!a || !b || !c) throw new Error("people not written");
    await gated(ctx.client, pond, [a, ...men], "open");
    await gated(ctx.client, pond, [b], "admitted");
    await gated(ctx.client, pond, [c], "waiting");

    const result = await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, a)).sort()).toEqual([...men].sort());
    expect(await roundOf(ctx.client, b)).toBeNull();
    expect(await roundOf(ctx.client, c)).toBeNull();
    // A's two cards, and each man's two: A and B, who is let in; C, waiting, is nobody's card.
    // How many, never whose.
    expect(result).toEqual({ ponds: 1, built: 3, cards: 6, failed: 0 });
  });

  test("Somebody hidden from others, or not let in, is nobody's card", async ({ ctx }) => {
    const { pond, women } = await pondOf(ctx, "test-rounds-hidden", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const [b] = await people(ctx.client, pond, 1, { ...MEN });
    const [c] = await people(ctx.client, pond, 1, { ...MEN });
    if (!b || !c) throw new Error("people not written");
    await gated(ctx.client, pond, [b], "open");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [b]);
    // C is complete but was never counted: no row at the gate.

    await buildRounds(await deps(ctx.client));

    const round = candidates(await roundOf(ctx.client, a));
    expect(round).toHaveLength(1);
    expect(round).not.toContain(b);
    expect(round).not.toContain(c);
    // B, shadow-banned, still has a round of their own: the ban shows them nothing different.
    expect(candidates(await roundOf(ctx.client, b))).toEqual([a]);
  });

  test("a person in another pond, or whose matching opened in a pond they left, gets nothing from this one", async ({
    ctx,
  }) => {
    const { pond, women } = await pondOf(ctx, "test-rounds-here", 1, 1);
    const elsewhere = await pondNamed(ctx.client, "test-rounds-elsewhere");
    const [moved] = await people(ctx.client, elsewhere, 1, MEN);
    if (!moved) throw new Error("people not written");
    // Opened in the first pond, then moved: the row is of a pond the person left.
    await gated(ctx.client, pond, [moved], "open");
    await buildRounds(await deps(ctx.client));
    expect(await roundOf(ctx.client, moved)).toBeNull();
    expect(candidates(await roundOf(ctx.client, women[0] ?? ""))).not.toContain(moved);
  });

  test("Nobody to show makes an empty round, never a filler", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-empty");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    // A man who seeks men only: in the pond, not in A's pool.
    const [b] = await people(ctx.client, pond, 1, { ...MEN, seeks: ["man"] });
    if (!a || !b) throw new Error("people not written");
    await gated(ctx.client, pond, [a, b], "open");

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([]);
  });
});

describe("whom a round holds", () => {
  test("A round holds at most round_size cards, the most soft matches first", async ({ ctx }) => {
    await setConfig(ctx.client, "round_size", 2);
    const pond = await pondNamed(ctx.client, "test-rounds-size");
    const [a] = await people(ctx.client, pond, 1, {
      ...WOMEN,
      fields: { education: "amk", drinking: "rarely" },
    });
    const answers: ProfileFields[] = [
      { education: "kandi", drinking: "never" },
      { education: "amk" },
      {},
    ];
    const chosen: (string | undefined)[] = [];
    for (const fields of answers) {
      chosen.push((await people(ctx.client, pond, 1, { ...MEN, fields }))[0]);
    }
    const [two, one, none] = chosen;
    if (!a || !two || !one || !none) throw new Error("people not written");
    await gated(ctx.client, pond, [a, two, one, none], "open");

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: two, reason: "matches_filters" },
      { candidate_id: one, reason: "matches_filters" },
    ]);
  });

  test("the round is ten cards by the row the first cut wrote (#95)", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-rounds-ten", 1, 12);
    await buildRounds(await deps(ctx.client));
    expect(await roundOf(ctx.client, women[0] ?? "")).toHaveLength(10);
  });

  describe("Somebody shown before waits out the cooldown, then comes back as seen before", () => {
    test.for([
      { days: 1, decided: "left it", outcome: 'not in "A"\'s round' },
      { days: 29, decided: "liked them", outcome: 'not in "A"\'s round' },
      { days: 30, decided: "left it", outcome: 'in "A"\'s round, labelled seen before' },
      { days: 30, decided: "liked them", outcome: 'in "A"\'s round, labelled seen before' },
      { days: 30, decided: "passed", outcome: 'not in "A"\'s round' },
      { days: 89, decided: "passed", outcome: 'not in "A"\'s round' },
      { days: 90, decided: "passed", outcome: 'in "A"\'s round, labelled seen before' },
    ])("$days days ago, $decided: $outcome", async ({ days, decided, outcome }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-rounds-cool-${days}-${decided}`, 1, 1);
      const [a] = women;
      const [b] = men;
      if (!a || !b) throw new Error("people not written");
      const decision = decided === "passed" ? "pass" : decided === "liked them" ? "like" : null;
      await shownBefore(ctx.client, a, b, days, decision);

      await buildRounds(await deps(ctx.client));

      expect(await roundOf(ctx.client, a)).toEqual(
        outcome.startsWith("in") ? [{ candidate_id: b, reason: "seen_before" }] : [],
      );
    });
  });

  test("Two people with a conversation between them are never each other's cards", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-talking", 1, 2);
    const [a] = women;
    const [b, other] = men;
    if (!a || !b || !other) throw new Error("people not written");
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO conversation DEFAULT VALUES RETURNING id",
    );
    await ctx.client.query(
      `INSERT INTO conversation_participant (conversation_id, account_id, side)
       VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
      [rows[0]?.id, a, b],
    );

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, a))).toEqual([other]);
    expect(candidates(await roundOf(ctx.client, b))).toEqual([]);
  });

  test("a person who hides from their own field is in no round of somebody of it, nor they in hers", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-field");
    const [a] = await people(ctx.client, pond, 1, {
      ...WOMEN,
      fields: { field: ["tech"], hideFromField: true },
    });
    const [same] = await people(ctx.client, pond, 1, { ...MEN, fields: { field: ["tech"] } });
    const [apart] = await people(ctx.client, pond, 1, { ...MEN, fields: { field: ["health"] } });
    if (!a || !same || !apart) throw new Error("people not written");
    await gated(ctx.client, pond, [a, same, apart], "open");

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, a))).toEqual([apart]);
    expect(candidates(await roundOf(ctx.client, same))).toEqual([]);
  });
});

describe("when a round is built", () => {
  test("The day's round is built once, whoever asks", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-rounds-once", 1, 3);
    const [a] = women;
    if (!a) throw new Error("people not written");
    await buildRounds(await deps(ctx.client));
    const first = await roundOf(ctx.client, a);

    expect(await buildRounds(await deps(ctx.client))).toEqual({
      ponds: 1,
      built: 0,
      cards: 0,
      failed: 0,
    });
    const read = await readToday(await appAt(ctx.client, NOON), ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual(first);
    expect(read.entries?.map((entry) => entry.position)).toEqual([1, 2, 3]);
    const { rows } = await ctx.client.query(
      "SELECT 1 FROM rounds WHERE account_id = $1 AND day = $2",
      [a, DAY],
    );
    expect(rows).toHaveLength(1);
  });

  test("The day's first read builds the round when the night built none", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-read");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    const men = await people(ctx.client, pond, 2, MEN);
    if (!a) throw new Error("people not written");
    await gated(ctx.client, pond, men, "admitted");
    await buildRounds(await deps(ctx.client));
    expect(await roundOf(ctx.client, a)).toBeNull();
    // A's matching opens after the night, at a first ask.
    await gated(ctx.client, pond, [a], "open");

    const app = await appAt(ctx.client, NOON);
    const first = await readToday(app, ctx.client, a);

    expect(first.day).toBe(DAY);
    expect(first.entries).toHaveLength(2);
    expect(candidates(await roundOf(ctx.client, a)).sort()).toEqual([...men].sort());
    const again = await readToday(app, ctx.client, a);
    expect(again.entries?.map((entry) => entry.card)).toEqual(
      first.entries?.map((entry) => entry.card),
    );
  });

  test("A person whose matching has not opened reads no round", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-closed");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    const men = await people(ctx.client, pond, 2, MEN);
    if (!a) throw new Error("people not written");
    await gated(ctx.client, pond, [a, ...men], "admitted");

    const read = await readToday(await appAt(ctx.client, NOON), ctx.client, a);

    expect(read).toEqual({ day: DAY, entries: null });
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("in production the first read builds nothing yet (ADR-035, Open 1)", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-rounds-production", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({ APP_ENV: "production", ADMIN_APP_URL: "https://admin.kuutti.app" }),
      logger,
      db: ctx.client,
      now: () => NOON,
    });
    expect(await readToday(app, ctx.client, a)).toEqual({ day: DAY, entries: null });
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("the first read after midnight builds the new day's round, before the night does", async ({
    ctx,
  }) => {
    const { women } = await pondOf(ctx, "test-rounds-early", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    // 00:30 in Helsinki: the day has begun and the night's jobs have not run.
    const early = new Date("2026-10-19T21:30:00.000Z");
    expect(finnishDay(early)).toBe(DAY);
    expect((await readToday(await appAt(ctx.client, early), ctx.client, a)).entries).toHaveLength(
      1,
    );
    // The night finds it built and leaves it.
    expect((await buildRounds(await deps(ctx.client))).built).toBe(1);
    expect(await roundOf(ctx.client, a)).toHaveLength(1);
  });

  test("buildRoundOf builds nothing for somebody erased, paused, or with a round already", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-of", 2, 1);
    const [a, paused] = women;
    const [b] = men;
    if (!a || !paused || !b) throw new Error("people not written");
    const d = await deps(ctx.client, NOON);
    expect(await buildRoundOf(d, a)).toBe(true);
    expect(await buildRoundOf(d, a)).toBe(false);
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [paused]);
    expect(await buildRoundOf(d, paused)).toBe(false);
    expect(await buildRoundOf(d, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
  });

  test("a round the day's first read built while the night ran is kept, and not counted as the night's", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-race", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    // Right after the night has asked who has a round already, A's read builds A's.
    let raced = false;
    const db: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        const result = await ctx.client.query(text, values);
        if (!raced && String(text).startsWith("SELECT account_id FROM rounds")) {
          raced = true;
          expect(await buildRoundOf(await deps(ctx.client, NOON), a)).toBe(true);
        }
        return result;
      }) as Queryable["query"],
    };

    const result = await buildRounds({ ...(await deps(ctx.client)), db });

    expect(raced).toBe(true);
    // B's round is the night's; A's was the read's, and stays as it was written.
    expect(result).toEqual({ ponds: 1, built: 1, cards: 1, failed: 0 });
    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
  });

  test("nobody's round is built whose profile is no longer complete, though their gate is open", async ({
    ctx,
  }) => {
    const { women } = await pondOf(ctx, "test-rounds-incomplete", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [a]);
    expect(await buildRoundOf(await deps(ctx.client, NOON), a)).toBe(false);
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("one person's round failing builds everybody else's, and says how many failed", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-fail", 2, 1);
    const [a, broken] = women;
    if (!a || !broken) throw new Error("people not written");
    const { logger, lines } = await captureLogger();
    // The database refuses broken's round, and only broken's.
    const db: Queryable = {
      query: ((text: string, values?: unknown[]) => {
        if (String(text).includes("INSERT INTO rounds") && values?.[0] === broken) {
          return Promise.reject(new Error("refused"));
        }
        return ctx.client.query(text, values);
      }) as Queryable["query"],
    };

    const result = await roundsJob({ db, logger, now: () => NIGHT }).run();

    expect(result).toEqual({ ponds: 1, built: 2, cards: 3, failed: 1 });
    expect(candidates(await roundOf(ctx.client, a))).toEqual(men);
    expect(await roundOf(ctx.client, broken)).toBeNull();
    expect(lines().filter((line) => line.msg === "round not built")).toEqual([
      expect.objectContaining({ job: "round-builder", accountId: broken }),
    ]);
  });

  test("round_built names the ordering of the first cut", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-rounds-event", 1, 2);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const who = await signInAs(ctx.client, a);
    const app = await appAt(ctx.client, new Date(NIGHT.getTime() - 3600 * 1000));
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

    await buildRounds(await deps(ctx.client));

    const { rows } = await ctx.client.query<{ props: Record<string, unknown> }>(
      "SELECT props FROM events WHERE name = 'round_built'",
    );
    expect(rows.map((row) => row.props)).toEqual([
      {
        ordering: "count",
        size: 2,
        matchesFilters: 2,
        likedYou: 0,
        seenBefore: 0,
        relaxed: 0,
        fish: 0,
      },
    ]);
  });
});

describe("liked-you (#97, ADR-037)", () => {
  test("A like given on an ended day is in the liked person's next round, first and labelled", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-first", 1, 3);
    const [a] = women;
    const [b, c, d] = men;
    if (!a || !b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");

    await buildRounds(await deps(ctx.client));

    const round = await roundOf(ctx.client, a);
    expect(round?.[0]).toEqual({ candidate_id: b, reason: "liked_you" });
    expect(round?.slice(1).map((card) => card.reason)).toEqual([
      "matches_filters",
      "matches_filters",
    ]);
    expect(new Set(candidates(round).slice(1))).toEqual(new Set([c, d]));
  });

  test("More waiting likes than liked_you_cap wait for a later round, oldest first", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "liked_you_cap", 2);
    const { women, men } = await pondOf(ctx, "test-liked-cap", 1, 3);
    const [a] = women;
    const [b, c, d] = men;
    if (!a || !b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 3, "like");
    await shownBefore(ctx.client, c, a, 2, "like");
    await shownBefore(ctx.client, d, a, 1, "like");

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: b, reason: "liked_you" },
      { candidate_id: c, reason: "liked_you" },
    ]);
  });

  describe("A like waits until it is answered or expires", () => {
    test.for([
      {
        days: 1,
        answer: '"A" has not seen it',
        outcome: 'first in "A"\'s round, labelled liked you',
      },
      {
        days: 13,
        answer: '"A" left it undecided twelve days ago',
        outcome: 'first in "A"\'s round, labelled liked you',
      },
      {
        days: 14,
        answer: '"A" has not seen it',
        outcome: 'in "A"\'s round as an ordinary card',
      },
      { days: 3, answer: '"A" passed it two days ago', outcome: 'not in "A"\'s round' },
      { days: 3, answer: '"A" liked it two days ago', outcome: 'not in "A"\'s round' },
    ])("$days days ago, $answer: $outcome", async ({ days, answer, outcome }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-liked-wait-${days}-${answer.length}`, 1, 1);
      const [a] = women;
      const [b] = men;
      if (!a || !b) throw new Error("people not written");
      await shownBefore(ctx.client, b, a, days, "like");
      if (answer.includes("undecided")) await shownBefore(ctx.client, a, b, 12, null);
      if (answer.includes("passed")) await shownBefore(ctx.client, a, b, 2, "pass");
      if (answer.includes("liked it")) await shownBefore(ctx.client, a, b, 2, "like");

      await buildRounds(await deps(ctx.client));

      const round = await roundOf(ctx.client, a);
      if (outcome.startsWith("first")) {
        expect(round?.[0]).toEqual({ candidate_id: b, reason: "liked_you" });
      } else if (outcome.includes("ordinary")) {
        expect(round).toEqual([{ candidate_id: b, reason: "matches_filters" }]);
      } else {
        expect(round).toEqual([]);
      }
    });
  });

  test("A like of today waits for the night", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-liked-today", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 0, "like");

    const read = await readToday(await appAt(ctx.client, NOON), ctx.client, a);

    expect(read.entries?.map((entry) => entry.reason)).not.toContain("liked_you");
    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: b, reason: "matches_filters" }]);
  });

  test("A like never reaches the round from somebody the person passed, or who no longer passes the filters", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-refused", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 30, "pass");
    await shownBefore(ctx.client, b, a, 1, "like");
    await shownBefore(ctx.client, c, a, 1, "like");
    await ctx.client.query(
      `UPDATE preferences SET value = '["man"]'::jsonb WHERE account_id = $1 AND field = 'seeks'`,
      [c],
    );

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([]);
  });

  test("a like from somebody erased, shadow-banned or with a conversation with the person never comes", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-gone", 1, 4);
    const [a] = women;
    const [erased, hidden, talking, kept] = men;
    if (!a || !erased || !hidden || !talking || !kept) throw new Error("people not written");
    for (const liker of [erased, hidden, talking, kept]) {
      await shownBefore(ctx.client, liker, a, 1, "like");
    }
    const { logger } = await captureLogger();
    await eraseAccount({ db: ctx.client, logger, now: () => NIGHT }, erased);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [hidden]);
    const { rows } = await ctx.client.query<{ id: string }>(
      "INSERT INTO conversation DEFAULT VALUES RETURNING id",
    );
    await ctx.client.query(
      `INSERT INTO conversation_participant (conversation_id, account_id, side)
       VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
      [rows[0]?.id, a, talking],
    );

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: kept, reason: "liked_you" }]);
  });

  test("The sender learns nothing of what became of a like", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-liked-silent", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");
    await buildRounds(await deps(ctx.client));
    const app = await appAt(ctx.client, NOON);
    const before = {
      today: await readToday(app, ctx.client, b),
      history: await exportRounds(ctx.client, b, 10),
    };

    const who = await signInAs(ctx.client, a);
    const passed = await app.request(`/rounds/${DAY}/entries/1/decision`, {
      method: "PUT",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "pass" }),
    });
    expect(passed.status).toBe(200);

    expect(await readToday(app, ctx.client, b)).toEqual(before.today);
    expect(await exportRounds(ctx.client, b, 10)).toEqual(before.history);
  });
});

/** `sender`'s like of `liked`, shown `days` ago, made a fish (#378). */
async function fishBefore(db: Queryable, sender: string, liked: string, days: number) {
  await shownBefore(db, sender, liked, days, "like");
  await db.query(
    `UPDATE round_entries e SET fish = true FROM rounds r
      WHERE r.id = e.round_id AND r.account_id = $1 AND e.candidate_id = $2`,
    [sender, liked],
  );
}

describe("the fish (#378, ADR-039)", () => {
  test("A fish sent today is at the front of the recipient's next round, ahead of every ordinary like", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-fish-first", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 2, "like");
    await fishBefore(ctx.client, c, a, 1);

    await buildRounds(await deps(ctx.client));

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: c, reason: "fish" },
      { candidate_id: b, reason: "liked_you" },
    ]);
  });

  describe("Fish and likes waiting on one person come fish oldest first, then likes oldest first", () => {
    test.for([
      { sender: "F1", place: 1, label: "fish" },
      { sender: "F2", place: 2, label: "fish" },
      { sender: "L1", place: 3, label: "liked you" },
      { sender: "L2", place: 4, label: "liked you" },
      { sender: "L3", place: 5, label: "liked you" },
    ])("$sender at place $place, labelled $label", async ({ sender, place, label }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-fish-queue-${sender}`, 1, 5);
      const [a] = women;
      const [f1, f2, l1, l2, l3] = men;
      if (!a || !f1 || !f2 || !l1 || !l2 || !l3) throw new Error("people not written");
      await fishBefore(ctx.client, f1, a, 3);
      await fishBefore(ctx.client, f2, a, 1);
      await shownBefore(ctx.client, l1, a, 4, "like");
      await shownBefore(ctx.client, l2, a, 2, "like");
      await shownBefore(ctx.client, l3, a, 1, "like");
      const who = { F1: f1, F2: f2, L1: l1, L2: l2, L3: l3 }[sender];

      await buildRounds(await deps(ctx.client));

      const round = await roundOf(ctx.client, a);
      expect(round?.[place - 1]).toEqual({
        candidate_id: who,
        reason: label === "fish" ? "fish" : "liked_you",
      });
    });
  });

  test("round_built counts the fish places", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-fish-event", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    const who = await signInAs(ctx.client, a);
    const answer = await (await appAt(ctx.client, new Date(NIGHT.getTime() - 3600 * 1000))).request(
      "/consents",
      {
        method: "POST",
        headers: { ...who.headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "research",
          version: CURRENT_CONSENT_VERSIONS.research,
          locale: "fi",
        }),
      },
    );
    expect(answer.status).toBe(200);
    await fishBefore(ctx.client, b, a, 1);

    await buildRounds(await deps(ctx.client));

    const { rows } = await ctx.client.query<{ props: Record<string, unknown> }>(
      "SELECT props FROM events WHERE name = 'round_built'",
    );
    expect(rows.map((row) => row.props)).toEqual([
      {
        ordering: "count",
        size: 1,
        matchesFilters: 0,
        likedYou: 0,
        seenBefore: 0,
        relaxed: 0,
        fish: 1,
      },
    ]);
  });
});

describe("over the synthetic population", () => {
  // Three hundred people, the gate's count and every round: about twelve
  // seconds here and more under CI's coverage, past the default fifteen.
  test("every open person gets a round, and nobody a candidate a hard filter excludes, in either direction", {
    timeout: 60_000,
  }, async ({ ctx }) => {
    await setConfig(ctx.client, "gate_k", 5);
    // The population lives in the seed's ponds, which this database has not been given.
    for (const pond of SEED_PONDS) {
      await ctx.client.query(
        `INSERT INTO ponds (slug, name_nominative, name_inessive) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING`,
        [pond.slug, pond.nameNominative, pond.nameInessive],
      );
    }
    await writePopulation(ctx.client, generatePopulation({ size: 300, seed: 7 }), CONSENT_VERSIONS);
    // Without the photos release nobody has a face, so nobody is complete: three approved rows
    // each, as the people of the other tests have, and the gate counts the population.
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       SELECT p.account_id, md5(p.account_id::text || n::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
              800, 1067, 'approved', n
         FROM profile p, generate_series(0, 2) n`,
    );
    const { logger } = await captureLogger();
    await countGates({ db: ctx.client, logger, now: () => NIGHT });

    const result = await buildRounds(await deps(ctx.client));

    const { rows: open } = await ctx.client.query<{ account_id: string; pond_id: string }>(
      `SELECT g.account_id, g.pond_id FROM gate g JOIN account a ON a.id = g.account_id
        WHERE g.opened_at IS NOT NULL AND a.state IN ('active', 'shadow_banned')`,
    );
    expect(open.length).toBeGreaterThan(50);
    expect(result.built).toBe(open.length);
    expect(result.failed).toBe(0);
    // Everybody's pool facts, read as the builder reads them, to ask every card both ways.
    const { subjectsOfPond } = await import("./pond-gate.ts");
    const ponds = [...new Set(open.map((row) => row.pond_id))];
    const everybody = new Map(
      (await Promise.all(ponds.map((pond) => subjectsOfPond(ctx.client, pond, NIGHT))))
        .flat()
        .map((subject) => [subject.id, subject]),
    );
    for (const { account_id } of open) {
      const round = await roundOf(ctx.client, account_id);
      expect(round).not.toBeNull();
      expect((round ?? []).length).toBeLessThanOrEqual(10);
      const owner = everybody.get(account_id);
      if (!owner) throw new Error("an open person the builder cannot read");
      for (const card of round ?? []) {
        const candidate = everybody.get(card.candidate_id);
        expect(candidate?.visible).toBe(true);
        expect(candidate?.admittedAt).not.toBeNull();
        if (!candidate) continue;
        expect(inEachOthersPool(owner.person, candidate.person)).toBe(true);
        expect(inEachOthersPool(candidate.person, owner.person)).toBe(true);
      }
    }
  });
});
