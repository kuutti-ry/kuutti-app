import { type Queryable, SEED_PONDS } from "@kuutti/db";
// biome-ignore lint/style/noRestrictedImports: a test of the builder over the synthetic population (#95); nothing of it is bundled
import { generatePopulation, openPonds, writePopulation } from "@kuutti/db/demo";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { type ProfileFields, RoundResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { exportRounds, inEachOthersPool, saveRound } from "../matching/index.ts";
import { signInAs } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { openPond, type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { openPondIds, subjectsOfPond } from "./pool.ts";
import { buildRoundOf, buildRounds, roundsJob } from "./round-builder.ts";

// The round builder (#95, ADR-035, features/matching/rounds.feature): who
// gets a round and whom it holds, the cooldowns, a conversation, the night
// and the day's first read, a block and a deal-breaker across the pond, and
// the whole synthetic population. The order's rule alone is
// matching/round-order.test.ts.

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

/** An open pond, `women` women and `men` men in it. */
async function pondOf(ctx: TestContext, slug: string, women: number, men: number) {
  const pond = await pondNamed(ctx.client, slug);
  await openPond(ctx.client, pond);
  const her = await people(ctx.client, pond, women, WOMEN);
  const him = await people(ctx.client, pond, men, MEN);
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

/**
 * An earlier round of `owner` with `candidate` in it, opened, and decided as
 * said; `opened` false for a round built and never read (ADR-042 §1).
 */
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

/** A block through the route, as a person sets one from a card they were shown. */
async function blocks(app: App, db: Queryable, blocker: string, blocked: string) {
  await cardShown(db, blocker, blocked);
  const who = await signInAs(db, blocker);
  const response = await app.request("/blocks", {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ accountId: blocked }),
  });
  expect(response.status).toBe(204);
}

describe("who gets a round", () => {
  test("Everybody complete in an open pond gets a round for the day, and nobody else", async ({
    ctx,
  }) => {
    const { pond, women, men } = await pondOf(ctx, "test-rounds-who", 1, 2);
    const [a] = women;
    const [b] = await people(ctx.client, pond, 1, WOMEN);
    const closed = await pondNamed(ctx.client, "test-rounds-who-closed");
    const [c] = await people(ctx.client, closed, 1, WOMEN);
    await people(ctx.client, closed, 1, MEN);
    if (!a || !b || !c) throw new Error("people not written");
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [b]);

    const result = await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, a)).sort()).toEqual([...men].sort());
    expect(await roundOf(ctx.client, b)).toBeNull();
    expect(await roundOf(ctx.client, c)).toBeNull();
    // A's two cards, and each man's one: A; B, with no photos, is nobody's card.
    // How many, never whose.
    expect(result).toEqual({ ponds: 1, built: 3, cards: 4, failed: 0 });
  });

  test("Somebody hidden from others, or not complete, is nobody's card", async ({ ctx }) => {
    const { pond, women } = await pondOf(ctx, "test-rounds-hidden", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const [b] = await people(ctx.client, pond, 1, { ...MEN });
    const [c] = await people(ctx.client, pond, 1, { ...MEN });
    if (!b || !c) throw new Error("people not written");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [b]);
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [c]);

    await buildRounds(await deps(ctx.client));

    const round = candidates(await roundOf(ctx.client, a));
    expect(round).toHaveLength(1);
    expect(round).not.toContain(b);
    expect(round).not.toContain(c);
    // B, shadow-banned, still has a round of their own: the ban shows them nothing different.
    expect(candidates(await roundOf(ctx.client, b))).toEqual([a]);
  });

  test("a person of another pond is nobody's card here, and that pond's switch is its own", async ({
    ctx,
  }) => {
    const { women } = await pondOf(ctx, "test-rounds-here", 1, 1);
    const elsewhere = await pondNamed(ctx.client, "test-rounds-elsewhere");
    const [them] = await people(ctx.client, elsewhere, 1, MEN);
    if (!them) throw new Error("people not written");
    await buildRounds(await deps(ctx.client));
    expect(await roundOf(ctx.client, them)).toBeNull();
    expect(candidates(await roundOf(ctx.client, women[0] ?? ""))).not.toContain(them);
  });

  test("Nobody to show makes an empty round, never a filler", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-empty");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    // A man who seeks men only: in the pond, not in A's pool.
    const [b] = await people(ctx.client, pond, 1, { ...MEN, seeks: ["man"] });
    if (!a || !b) throw new Error("people not written");
    await openPond(ctx.client, pond);

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
    await openPond(ctx.client, pond);

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
    await openPond(ctx.client, pond);

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
    await buildRounds(await deps(ctx.client));
    expect(await roundOf(ctx.client, a)).toBeNull();
    // The pond opens after the night.
    await openPond(ctx.client, pond);

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
    await people(ctx.client, pond, 2, MEN);
    if (!a) throw new Error("people not written");

    const read = await readToday(await appAt(ctx.client, NOON), ctx.client, a);

    expect(read).toEqual({ day: DAY, entries: null, fishToSend: true, likesLeft: 10 });
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
    expect(await readToday(app, ctx.client, a)).toEqual({
      day: DAY,
      entries: null,
      fishToSend: true,
      likesLeft: 10,
    });
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

  test("buildRoundOf builds nothing for somebody erased or paused, and a round already built stands", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-of", 2, 1);
    const [a, paused] = women;
    const [b] = men;
    if (!a || !paused || !b) throw new Error("people not written");
    const d = await deps(ctx.client, NOON);
    expect(await buildRoundOf(d, a)).toBe(true);
    // Asked again, the round stands: true, and nothing more is written.
    expect(await buildRoundOf(d, a)).toBe(true);
    const { rows } = await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [a]);
    expect(rows).toHaveLength(1);
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

  test("nobody's round is built whose profile is no longer complete, though their pond is open", async ({
    ctx,
  }) => {
    const { women } = await pondOf(ctx, "test-rounds-incomplete", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [a]);
    // The person is asked alone first: the pond is never read for them.
    const asked: string[] = [];
    const db: Queryable = {
      query: ((text: string, values?: unknown[]) => {
        asked.push(String(text));
        return ctx.client.query(text, values);
      }) as Queryable["query"],
    };
    expect(await buildRoundOf({ ...(await deps(ctx.client, NOON)), db }, a)).toBe(false);
    expect(asked.some((text) => text.includes("SELECT id FROM account WHERE pond_id"))).toBe(false);
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("a read that lost the day's first build to another is answered with the round the other built", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-lost", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    const who = await signInAs(ctx.client, a);
    // Right after this read found no round, another device's read builds it.
    let raced = false;
    const db: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        if (!raced && String(text).includes("p.matching_open FROM account a")) {
          raced = true;
          expect(await buildRoundOf(await deps(ctx.client, NOON), a)).toBe(true);
        }
        return ctx.client.query(text, values);
      }) as Queryable["query"],
    };
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db, now: () => NOON });

    const answer = await app.request("/rounds/today", { headers: who.headers });

    expect(raced).toBe(true);
    expect(answer.status).toBe(200);
    expect(RoundResponse.parse(await answer.json()).entries).toHaveLength(1);
    expect(
      (await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [a])).rows,
    ).toHaveLength(1);
  });

  test("a read whose round another read saved first, while it built, is answered with that round", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-lost-save", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    // Both reads pass every look; the other writes first, and this one's INSERT finds its round.
    let raced = false;
    const db: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        if (!raced && String(text).includes("INSERT INTO rounds") && values?.[0] === a) {
          raced = true;
          expect(await buildRoundOf(await deps(ctx.client, NOON), a)).toBe(true);
        }
        return ctx.client.query(text, values);
      }) as Queryable["query"],
    };

    expect(await buildRoundOf({ ...(await deps(ctx.client, NOON)), db }, a)).toBe(true);

    expect(raced).toBe(true);
    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
    expect(
      (await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [a])).rows,
    ).toHaveLength(1);
  });

  test("liked-you places alone never pass ROUND_ENTRIES_MAX either, the oldest likes kept", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "liked_you_cap", 60);
    const { women, men } = await pondOf(ctx, "test-rounds-cap-liked", 1, 55);
    const [a] = women;
    if (!a) throw new Error("people not written");
    // Fifty-five likes, the first the oldest: it is in the round, the newest is not.
    for (const [i, liker] of men.entries())
      await shownBefore(ctx.client, liker, a, 13 - Math.floor(i / 5), "like");

    await buildRounds(await deps(ctx.client));

    const round = await roundOf(ctx.client, a);
    expect(round).toHaveLength(50);
    expect(new Set(round?.map((card) => card.reason))).toEqual(new Set(["liked_you"]));
    expect(candidates(round)).toContain(men[0]);
    expect(candidates(round)).not.toContain(men.at(-1));
  });

  test("a round never holds more places than the contract's ROUND_ENTRIES_MAX, the liked-you ones first", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "liked_you_cap", 3);
    await setConfig(ctx.client, "round_size", 49);
    const { women, men } = await pondOf(ctx, "test-rounds-cap", 1, 55);
    const [a] = women;
    if (!a) throw new Error("people not written");
    for (const liker of men.slice(0, 3)) await shownBefore(ctx.client, liker, a, 1, "like");

    await buildRounds(await deps(ctx.client));

    const round = await roundOf(ctx.client, a);
    expect(round).toHaveLength(50);
    expect(round?.slice(0, 3).map((card) => card.reason)).toEqual([
      "liked_you",
      "liked_you",
      "liked_you",
    ]);
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

  test("A shadow-banned person's round holds no liked-you places, and the likes wait for the lift", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-shadow", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [a]);

    await buildRounds(await deps(ctx.client));

    // A like back would make no match and tell A of the ban (ADR-024 §7): B is in no place.
    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: c, reason: "matches_filters" }]);

    // The ban lifted, the next night's round opens with B's like, still within its days.
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [a]);
    const nextNight = new Date(NIGHT.getTime() + 24 * 3600 * 1000);
    await buildRounds(await deps(ctx.client, nextNight));
    expect((await roundOf(ctx.client, a, finnishDay(nextNight)))?.[0]).toEqual({
      candidate_id: b,
      reason: "liked_you",
    });
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
  // Three hundred people and every round: about twelve
  // seconds here and more under CI's coverage, past the default fifteen.
  test("every open person gets a round, and nobody a candidate a hard filter excludes, in either direction", {
    timeout: 60_000,
  }, async ({ ctx }) => {
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
    // each, as the people of the other tests have, and the demo commands' open ponds.
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       SELECT p.account_id, md5(p.account_id::text || n::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
              800, 1067, 'approved', n
         FROM profile p, generate_series(0, 2) n`,
    );
    await openPonds(ctx.client);

    const result = await buildRounds(await deps(ctx.client));

    // Everybody's pool facts, read as the builder reads them, to ask every card both ways.
    const ponds = await openPondIds(ctx.client);
    const everybody = new Map(
      (await Promise.all(ponds.map((pond) => subjectsOfPond(ctx.client, pond, NIGHT))))
        .flat()
        .map((subject) => [subject.id, subject]),
    );
    expect(everybody.size).toBeGreaterThan(50);
    expect(result.built).toBe(everybody.size);
    expect(result.failed).toBe(0);
    for (const [accountId, owner] of everybody) {
      const round = await roundOf(ctx.client, accountId);
      expect(round).not.toBeNull();
      expect((round ?? []).length).toBeLessThanOrEqual(10);
      for (const card of round ?? []) {
        const candidate = everybody.get(card.candidate_id);
        expect(candidate?.visible).toBe(true);
        if (!candidate) continue;
        expect(inEachOthersPool(owner.person, candidate.person)).toBe(true);
        expect(inEachOthersPool(candidate.person, owner.person)).toBe(true);
      }
    }
  });
});

// features/safety/blocks.feature (#84, ADR-030 §3) and
// features/matching/filters.feature (#87): nobody is shown to somebody who
// did not opt into them, across a whole pond's rounds.
describe("the filters across a pond's rounds", () => {
  /** Women who seek women: every two of them are in each other's pool. */
  const ALIKE: PeopleOptions = { ...WOMEN, seeks: ["woman"] };

  async function alikePond(ctx: TestContext, slug: string, count: number) {
    const pond = await pondNamed(ctx.client, slug);
    await openPond(ctx.client, pond);
    return { pond, ids: await people(ctx.client, pond, count, ALIKE) };
  }

  test("The round leaves a blocked pair out of each other's cards", async ({ ctx }) => {
    const { ids } = await alikePond(ctx, "test-rounds-blocks", 4);
    const [she, her, x, y] = ids;
    if (!she || !her || !x || !y) throw new Error("people not written");
    await blocks(await appAt(ctx.client, NIGHT), ctx.client, she, her);

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, she)).sort()).toEqual([x, y].sort());
    expect(candidates(await roundOf(ctx.client, her)).sort()).toEqual([x, y].sort());
    expect(candidates(await roundOf(ctx.client, x)).sort()).toEqual([she, her, y].sort());
  });

  test("A block holds for a later account of either identity", async ({ ctx }) => {
    const { pond, ids } = await alikePond(ctx, "test-rounds-blocks-later", 3);
    const [a, b, c] = ids;
    if (!a || !b || !c) throw new Error("people not written");
    await blocks(await appAt(ctx.client, NIGHT), ctx.client, a, b);
    // B deletes the account, the cooldown passes, and B comes back: a new
    // account on the same identity (a complete person here, given B's identity).
    await eraseAccount(await deps(ctx.client), b);
    const [again] = await people(ctx.client, pond, 1, ALIKE);
    if (!again) throw new Error("people not written");
    await ctx.client.query(
      "UPDATE account SET identity_id = (SELECT identity_id FROM account WHERE id = $2) WHERE id = $1",
      [again, b],
    );

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, a))).toEqual([c]);
    expect(candidates(await roundOf(ctx.client, again))).toEqual([c]);
    // The card and the photos ask the same of the identities, both ways; the
    // card builder and the photo route are held to it across a later account
    // of either in profile/service.test.ts and media/budget.test.ts.
    const between = async (one: string, other: string) =>
      (
        await ctx.client.query<{ blocked: boolean }>("SELECT blocked_between($1, $2) AS blocked", [
          one,
          other,
        ])
      ).rows[0]?.blocked;
    expect(await between(a, again)).toBe(true);
    expect(await between(again, a)).toBe(true);
    expect(await between(c, again)).toBe(false);
  });

  test("The round leaves a pair a deal-breaker excludes out of each other's cards", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-deal-breakers");
    await openPond(ctx.client, pond);
    const [holder] = await people(ctx.client, pond, 1, {
      ...ALIKE,
      fields: { smoking: "never" },
    });
    const [smoker] = await people(ctx.client, pond, 1, {
      ...ALIKE,
      fields: { smoking: "regularly" },
    });
    // Somebody who did not answer, whom the holder lets through, and somebody who never smokes.
    const [open] = await people(ctx.client, pond, 1, ALIKE);
    const [never] = await people(ctx.client, pond, 1, { ...ALIKE, fields: { smoking: "never" } });
    if (!holder || !smoker || !open || !never) throw new Error("people not written");
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'smoking', '["never"]'::jsonb, 'hard', true)`,
      [holder],
    );
    const { logger, lines } = await captureLogger();

    await buildRounds({ db: ctx.client, logger, now: () => NIGHT });

    expect(candidates(await roundOf(ctx.client, holder)).sort()).toEqual([open, never].sort());
    expect(candidates(await roundOf(ctx.client, smoker)).sort()).toEqual([open, never].sort());
    // Nothing of anybody's answers or filters reaches the night's line.
    expect(JSON.stringify(lines())).not.toMatch(/smoking|never|regularly/);

    // The holder takes their own answer back: the deal-breaker is paused, and the next night shows both.
    await ctx.client.query("UPDATE profile SET fields = fields - 'smoking' WHERE account_id = $1", [
      holder,
    ]);
    const tomorrow = new Date(NIGHT.getTime() + 24 * 3600 * 1000);
    await buildRounds(await deps(ctx.client, tomorrow));
    expect(candidates(await roundOf(ctx.client, smoker, finnishDay(tomorrow)))).toContain(holder);
  });

  test("a deal-breaker on an option the registry no longer has, or a field off the whitelist, filters nothing", async ({
    ctx,
  }) => {
    const { ids } = await alikePond(ctx, "test-rounds-stale-deal-breakers", 3);
    const [holder, x, y] = ids;
    if (!holder || !x || !y) throw new Error("people not written");
    await ctx.client.query(
      `UPDATE profile SET fields = fields || '{"smoking": "never", "drinking": "never"}'::jsonb
        WHERE account_id = $1`,
      [holder],
    );
    // Written by hand: rows the save would refuse today (ADR-009 §1: an option
    // removed is a data change). Each would refuse the two, who answered
    // neither, if it were read as a deal-breaker: drinking has options, but no
    // deal-breaker may be set on it.
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'smoking', '["cigars"]'::jsonb, 'hard', false),
              ($1, 'drinking', '["never"]'::jsonb, 'hard', false)`,
      [holder],
    );

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, holder)).sort()).toEqual([x, y].sort());
  });

  test("an answer the registry no longer has is read as none, by the holder's deal-breaker and by the other's", async ({
    ctx,
  }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-stale-answers");
    await openPond(ctx.client, pond);
    // H accepts no children or no answer; C's answer is an option the registry dropped.
    const [h, c] = await people(ctx.client, pond, 2, {
      ...ALIKE,
      fields: { smoking: "never", hasKids: "no" },
    });
    // P refuses smokers, then P's own answer becomes a dropped option: the deal-breaker is paused.
    const [p] = await people(ctx.client, pond, 1, { ...ALIKE, fields: { smoking: "never" } });
    const [smoker] = await people(ctx.client, pond, 1, {
      ...ALIKE,
      fields: { smoking: "regularly" },
    });
    if (!h || !c || !p || !smoker) throw new Error("people not written");
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'hasKids', '["no"]'::jsonb, 'hard', true),
              ($2, 'smoking', '["never"]'::jsonb, 'hard', false)`,
      [h, p],
    );
    for (const [account, stale] of [
      [c, { hasKids: "maybe" }],
      [p, { smoking: "cigars" }],
    ] as const) {
      await ctx.client.query(
        "UPDATE profile SET fields = fields || $2::jsonb WHERE account_id = $1",
        [account, JSON.stringify(stale)],
      );
    }

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, h))).toContain(c);
    expect(candidates(await roundOf(ctx.client, p))).toContain(smoker);
    // The holder's own screen says the same of P's deal-breaker.
    const who = await signInAs(ctx.client, p);
    const app = await appAt(ctx.client, NIGHT);
    const read = await app.request("/preferences/deal-breakers", { headers: who.headers });
    expect(await read.json()).toMatchObject({ dealBreakers: [{ field: "smoking", paused: true }] });
  });

  test("a dance partner is a card for dance partners only (#175)", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-dance");
    await openPond(ctx.client, pond);
    const dancers = await people(ctx.client, pond, 2, { ...ALIKE, intent: "dance_partner" });
    const [either] = await people(ctx.client, pond, 1, { ...ALIKE, intent: "open_to_either" });
    const [dancer, partner] = dancers;
    if (!dancer || !partner || !either) throw new Error("people not written");

    await buildRounds(await deps(ctx.client));

    expect(candidates(await roundOf(ctx.client, dancer))).toEqual([partner]);
    expect(await roundOf(ctx.client, either)).toEqual([]);
  });
});
