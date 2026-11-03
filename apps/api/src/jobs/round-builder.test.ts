import { type Queryable, SEED_PONDS } from "@kuutti/db";
// biome-ignore lint/style/noRestrictedImports: a test of the builder over the synthetic population (#95); nothing of it is bundled
import { generatePopulation, openPonds, writePopulation } from "@kuutti/db/demo";
import { CONSENT_VERSIONS } from "@kuutti/i18n";
import {
  ErrorResponse,
  type ProfileFields,
  QUEUE_PAGE,
  RoundDecisionAnswer,
  RoundResponse,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { addDays, finnishDay } from "../lib/finnish-day.ts";
import { exportRounds, inEachOthersPool, pruneRounds } from "../matching/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween, interleaved } from "../test/chat.ts";
import {
  captureLogger,
  describe,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { HOME, HOMES, openPond, type PeopleOptions, people, pondNamed } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { endedConversation, logged, shownAt } from "../test/rounds.ts";
import { subjectsOfPond } from "./pool.ts";
import { fillQueue, fitsNow } from "./round-builder.ts";

// The queue's builder (#95, #502, ADR-035, ADR-062,
// features/matching/rounds.feature): who has a queue and whom it holds, a page at
// a time from the day's first read, the ladder of clocks, a conversation, the
// likes waiting, the inbox stop, the filters on every read, a block and a
// deal-breaker across the pond, and the whole synthetic population. The order's
// rule alone is matching/round-order.test.ts, and a card's decision
// matching/rounds.test.ts.

/** Noon in Helsinki, 2026-10-20: nothing here runs at night. */
const NOON = new Date("2026-10-20T09:00:00.000Z");
const DAY = finnishDay(NOON);
const DAY_MS = 24 * 3600 * 1000;
const NEXT_NOON = new Date(NOON.getTime() + DAY_MS);
const NEXT_DAY = finnishDay(NEXT_NOON);

/** Women who seek men, and men who seek women: each in the pool of every one of the others. */
const WOMEN: PeopleOptions = { gender: "woman", seeks: ["man"], complete: true, consented: true };
const MEN: PeopleOptions = { gender: "man", seeks: ["woman"], complete: true, consented: true };

const deps = async (db: Queryable, now = NOON) => ({
  db,
  logger: (await captureLogger()).logger,
  now: () => now,
});

/** The next people of the person's queue, as a read that finds nothing left adds them. */
const fill = async (db: Queryable, accountId: string, now = NOON) =>
  fillQueue(await deps(db, now), accountId);

async function fillAll(db: Queryable, ids: readonly (string | undefined)[], now = NOON) {
  for (const id of ids) await fill(db, id ?? "", now);
}

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

const daysAgo = (days: number) => new Date(NOON.getTime() - days * DAY_MS);
const daysOn = (days: number) => new Date(NOON.getTime() + days * DAY_MS);

/** `owner` was shown `candidate` `days` ago and decided as said; with no decision a card displayed and left. */
const shownBefore = (
  db: Queryable,
  owner: string,
  candidate: string,
  days: number,
  decision: "like" | "pass" | "skip" | null,
  options: { displayed?: boolean; fish?: boolean; secondPass?: boolean } = {},
) => shownAt(db, daysAgo(days), owner, candidate, decision, options);

async function appAt(db: Queryable, now: Date = NOON): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => now });
}

async function readToday(app: App, db: Queryable, accountId: string): Promise<RoundResponse> {
  const who = await signInAs(db, accountId);
  const answer = await app.request("/rounds/today", { headers: who.headers });
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

async function decideAs(
  app: App,
  db: Queryable,
  accountId: string,
  position: number,
  decision: string,
  day = DAY,
) {
  const who = await signInAs(db, accountId);
  return app.request(`/rounds/${day}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}

/** Every card the read gave, passed. */
async function passAll(app: App, db: Queryable, accountId: string, read: RoundResponse) {
  for (const entry of read.entries ?? []) {
    expect((await decideAs(app, db, accountId, entry.position, "pass", read.day)).status).toBe(200);
  }
}

const accountsOf = (read: RoundResponse) => read.entries?.map((entry) => entry.card.accountId);

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

describe("who has a queue", () => {
  test("The day's first read opens the day and fills ten, nobody built at night", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-queue-first", 1, 12);
    const [a] = women;
    if (!a) throw new Error("people not written");
    expect(await roundOf(ctx.client, a)).toBeNull();

    const first = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(first.day).toBe(DAY);
    expect(first.entries?.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const log = await roundOf(ctx.client, a);
    expect(candidates(log)).toEqual(accountsOf(first));
    expect(new Set(candidates(log)).size).toBe(QUEUE_PAGE);
    for (const card of log ?? []) expect(men).toContain(card.candidate_id);
    expect(new Set(log?.map((card) => card.reason))).toEqual(new Set(["matches_filters"]));
    const { rows } = await ctx.client.query<{ opened_at: Date | null; built_at: Date }>(
      "SELECT opened_at, built_at FROM rounds WHERE account_id = $1",
      [a],
    );
    expect(rows).toEqual([{ opened_at: NOON, built_at: NOON }]);
  });

  test("Only somebody complete in an open pond opens a day", async ({ ctx }) => {
    const { pond, women, men } = await pondOf(ctx, "test-rounds-who", 1, 2);
    const [a] = women;
    const [b] = await people(ctx.client, pond, 1, WOMEN);
    const closed = await pondNamed(ctx.client, "test-rounds-who-closed");
    const [c] = await people(ctx.client, closed, 1, WOMEN);
    await people(ctx.client, closed, 1, MEN);
    if (!a || !b || !c) throw new Error("people not written");
    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [b]);

    expect(await fill(ctx.client, a)).toBe(true);
    expect(await fill(ctx.client, b)).toBe(false);
    expect(await fill(ctx.client, c)).toBe(false);

    expect(candidates(await roundOf(ctx.client, a)).sort()).toEqual([...men].sort());
    expect(await roundOf(ctx.client, b)).toBeNull();
    expect(await roundOf(ctx.client, c)).toBeNull();
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

    await fillAll(ctx.client, [a, b]);

    const round = candidates(await roundOf(ctx.client, a));
    expect(round).toHaveLength(1);
    expect(round).not.toContain(b);
    expect(round).not.toContain(c);
    // B, shadow-banned, still has a queue of their own: the ban shows them nothing different.
    expect(candidates(await roundOf(ctx.client, b))).toEqual([a]);
  });

  test("a person of another pond is nobody's card here, and that pond's switch is its own", async ({
    ctx,
  }) => {
    const { women } = await pondOf(ctx, "test-rounds-here", 1, 1);
    const elsewhere = await pondNamed(ctx.client, "test-rounds-elsewhere");
    const [them] = await people(ctx.client, elsewhere, 1, MEN);
    if (!them) throw new Error("people not written");
    await fillAll(ctx.client, [women[0], them]);
    expect(await roundOf(ctx.client, them)).toBeNull();
    expect(candidates(await roundOf(ctx.client, women[0] ?? ""))).not.toContain(them);
  });

  test("Nobody to show makes an empty queue, never a filler", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-empty");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    // A man who seeks men only: in the pond, not in A's pool.
    const [b] = await people(ctx.client, pond, 1, { ...MEN, seeks: ["man"] });
    if (!a || !b) throw new Error("people not written");
    await openPond(ctx.client, pond);

    const read = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(read.entries).toEqual([]);
    expect(await roundOf(ctx.client, a)).toEqual([]);
  });

  test("A person whose matching has not opened reads no round", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-rounds-closed");
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    await people(ctx.client, pond, 2, MEN);
    if (!a) throw new Error("people not written");

    const read = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(read).toEqual({
      day: DAY,
      entries: null,
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("in production a read fills the queue as anywhere, the switch being what holds it (ADR-062 §13)", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-production", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({ APP_ENV: "production", ADMIN_APP_URL: "https://admin.kuutti.app" }),
      logger,
      db: ctx.client,
      now: () => NOON,
    });
    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual(men);
    expect(candidates(await roundOf(ctx.client, a))).toEqual(men);
  });

  test("somebody erased or paused opens no day, and adding to a day already open adds what is left", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-of", 2, 1);
    const [a, paused] = women;
    const [b] = men;
    if (!a || !paused || !b) throw new Error("people not written");
    expect(await fill(ctx.client, a)).toBe(true);
    // Asked again, with nobody left: nothing is written.
    expect(await fill(ctx.client, a)).toBe(false);
    const { rows } = await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [a]);
    expect(rows).toHaveLength(1);
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [paused]);
    expect(await fill(ctx.client, paused)).toBe(false);
    expect(await fill(ctx.client, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
  });

  test("nobody's day opens whose profile is no longer complete, and the pond is never read for them", async ({
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
    expect(await fillQueue({ ...(await deps(ctx.client)), db }, a)).toBe(false);
    expect(asked.some((text) => text.includes("SELECT id FROM account WHERE pond_id"))).toBe(false);
    expect(await roundOf(ctx.client, a)).toBeNull();
  });
});

describe("a page at a time (ADR-062 §1)", () => {
  test("A read with undecided cards adds nobody", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-queue-undecided", 1, 12);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const first = await readToday(app, ctx.client, a);
    const [left, ...rest] = first.entries ?? [];
    if (!left) throw new Error("no cards");
    await passAll(app, ctx.client, a, { ...first, entries: rest });

    const again = await readToday(app, ctx.client, a);

    expect(again.entries?.map((entry) => entry.position)).toEqual([left.position]);
    expect(await roundOf(ctx.client, a)).toHaveLength(QUEUE_PAGE);
  });

  test("The eleventh person comes once ten are decided", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-queue-eleventh", 1, 12);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const first = await readToday(app, ctx.client, a);
    await passAll(app, ctx.client, a, first);

    const next = await readToday(app, ctx.client, a);

    expect(next.entries?.map((entry) => entry.position)).toEqual([11, 12]);
    expect(new Set([...(accountsOf(first) ?? []), ...(accountsOf(next) ?? [])])).toEqual(
      new Set(men),
    );
  });

  test("The queue's end is an empty list, and null means no matching", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-queue-end", 1, 2);
    const [a] = women;
    const closed = await pondNamed(ctx.client, "test-queue-end-closed");
    const [b] = await people(ctx.client, closed, 1, WOMEN);
    await people(ctx.client, closed, 1, MEN);
    if (!a || !b) throw new Error("people not written");
    const app = await appAt(ctx.client);
    await passAll(app, ctx.client, a, await readToday(app, ctx.client, a));

    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);
    expect((await readToday(app, ctx.client, b)).entries).toBeNull();
  });

  test("Two reads at once queue nobody twice", async () => {
    await withTwoConnections("kuutti-502-first-read", async (pool, first, second) => {
      const pond = await pondNamed(pool, "test-queue-two-reads");
      await openPond(pool, pond);
      const [a] = await people(pool, pond, 1, WOMEN);
      await people(pool, pond, 12, MEN);
      if (!a) throw new Error("people not written");
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // One read has opened the day and written its ten, not yet committed; the other waits.
      expect(await fill(first, a)).toBe(true);
      const beside = watched(fill(second, a));
      expect(await waitsFor(pool, secondPid, firstPid, beside.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await beside.outcome).toBe(false);
      await second.query("COMMIT");

      const { rows } = await pool.query<{ position: number; candidate_id: string }>(
        `SELECT e.position, e.candidate_id FROM round_entries e JOIN rounds r ON r.id = e.round_id
          WHERE r.account_id = $1 ORDER BY e.position`,
        [a],
      );
      expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(new Set(rows.map((row) => row.candidate_id)).size).toBe(QUEUE_PAGE);
    });
  });

  test("two reads past the first page queue nobody twice either, and leave no place twice", async () => {
    await withTwoConnections("kuutti-502-next-read", async (pool, first, second) => {
      const pond = await pondNamed(pool, "test-queue-two-more");
      await openPond(pool, pond);
      const [a] = await people(pool, pond, 1, WOMEN);
      await people(pool, pond, 12, MEN);
      if (!a) throw new Error("people not written");
      await fill(pool, a);
      await pool.query(
        `UPDATE round_entries SET decision = 'pass', decided_at = now()
          WHERE round_id = (SELECT id FROM rounds WHERE account_id = $1)`,
        [a],
      );
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      expect(await fill(first, a)).toBe(true);
      const beside = watched(fill(second, a));
      expect(await waitsFor(pool, secondPid, firstPid, beside.settled)).toBe(true);
      await first.query("COMMIT");
      expect(await beside.outcome).toBe(false);
      await second.query("COMMIT");

      const { rows } = await pool.query<{ last_position: number; n: number; people: number }>(
        `SELECT r.last_position, count(*)::int AS n, count(DISTINCT e.candidate_id)::int AS people
           FROM rounds r JOIN round_entries e ON e.round_id = r.id
          WHERE r.account_id = $1 GROUP BY r.last_position`,
        [a],
      );
      expect(rows).toEqual([{ last_position: 12, n: 12, people: 12 }]);
    });
  });

  test("a read that another read beat to the day's places is answered with them", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-lost", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const who = await signInAs(ctx.client, a);
    // Both reads pass every look; the other writes first, and this one's places find it done.
    const db = interleaved(ctx.client, /INSERT INTO rounds/, () => fill(ctx.client, a));
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db, now: () => NOON });

    const answer = await app.request("/rounds/today", { headers: who.headers });

    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(200);
    expect(accountsOf(RoundResponse.parse(await answer.json()))).toEqual(men);
    expect(
      (await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [a])).rows,
    ).toHaveLength(1);
    expect(candidates(await roundOf(ctx.client, a))).toEqual(men);
  });

  test("the first read after midnight opens the new day", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-rounds-early", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    // 00:30 in Helsinki.
    const early = new Date("2026-10-19T21:30:00.000Z");
    expect(finnishDay(early)).toBe(DAY);
    expect((await readToday(await appAt(ctx.client, early), ctx.client, a)).entries).toHaveLength(
      1,
    );
    expect(await roundOf(ctx.client, a)).toHaveLength(1);
  });

  test("a person paused while their read walks the pool opens no day", async ({ ctx }) => {
    const { women } = await pondOf(ctx, "test-queue-paused", 1, 1);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const db = interleaved(
      ctx.client,
      /INSERT INTO rounds|state IN \('active', 'shadow_banned'\) FOR SHARE/,
      () => ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [a]),
    );

    expect(await fillQueue({ ...(await deps(ctx.client)), db }, a)).toBe(false);

    expect(db.ran()).toBe(true);
    expect(await roundOf(ctx.client, a)).toBeNull();
  });

  test("a card that cannot be served makes a read go on to the next people", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-queue-unserved", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await logged(ctx.client, a, DAY, [b]);
    // Sanctioned since it was queued: left out, and with nothing else the read adds C.
    await ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [b]);

    const read = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(accountsOf(read)).toEqual([c]);
    expect(read.entries?.map((entry) => entry.position)).toEqual([2]);
    expect(candidates(await roundOf(ctx.client, a))).toEqual([b, c]);
  });
});

describe("whom the queue holds", () => {
  test("new people of one band come the most soft matches first", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-queue-soft");
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

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: two, reason: "matches_filters" },
      { candidate_id: one, reason: "matches_filters" },
      { candidate_id: none, reason: "matches_filters" },
    ]);
  });

  describe("Somebody seen before waits out their clock, then comes back as seen before", () => {
    test.for([
      { days: 1, decided: "left it undecided", outcome: 'in "A"\'s queue, labelled seen before' },
      { days: 1, decided: "skipped them", outcome: 'in "A"\'s queue, labelled seen before' },
      { days: 1, decided: "passed", outcome: 'not in "A"\'s queue' },
      { days: 29, decided: "passed", outcome: 'not in "A"\'s queue' },
      { days: 30, decided: "passed", outcome: 'in "A"\'s queue, labelled seen before' },
      { days: 29, decided: "passed a second time", outcome: 'not in "A"\'s queue' },
      { days: 364, decided: "passed a second time", outcome: 'not in "A"\'s queue' },
      {
        days: 365,
        decided: "passed a second time",
        outcome: 'in "A"\'s queue, labelled seen before',
      },
      { days: 1, decided: "liked them", outcome: 'not in "A"\'s queue' },
      { days: 89, decided: "liked them", outcome: 'not in "A"\'s queue' },
      { days: 90, decided: "liked them", outcome: 'in "A"\'s queue, labelled seen before' },
    ])("$days days ago, $decided: $outcome", async ({ days, decided, outcome }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-rounds-cool-${days}-${decided}`, 1, 1);
      const [a] = women;
      const [b] = men;
      if (!a || !b) throw new Error("people not written");
      const decision = decided.startsWith("passed")
        ? "pass"
        : decided === "liked them"
          ? "like"
          : decided === "skipped them"
            ? "skip"
            : null;
      await shownBefore(ctx.client, a, b, days, decision, {
        secondPass: decided === "passed a second time",
      });

      await fill(ctx.client, a);

      expect(await roundOf(ctx.client, a)).toEqual(
        outcome.startsWith("in") ? [{ candidate_id: b, reason: "seen_before" }] : [],
      );
    });
  });

  describe("An ended conversation keeps the two apart until its clock has run, both ways", () => {
    test.for([
      { ended: "one of them closed", days: 89, outcome: "not in the other's queue" },
      {
        ended: "one of them closed",
        days: 90,
        outcome: "in the other's queue, labelled seen before",
      },
      { ended: "the silence archived", days: 89, outcome: "not in the other's queue" },
      {
        ended: "the silence archived",
        days: 90,
        outcome: "in the other's queue, labelled seen before",
      },
    ])("$ended $days days ago: $outcome", async ({ ended, days, outcome }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-ended-${days}-${ended.length}`, 1, 1);
      const [a] = women;
      const [b] = men;
      if (!a || !b) throw new Error("people not written");
      const how = ended.includes("closed") ? "closed" : "archived";
      await endedConversation(ctx.client, a, b, daysAgo(days), how);

      await fillAll(ctx.client, [a, b]);

      const back = outcome.startsWith("in");
      expect(await roundOf(ctx.client, a)).toEqual(
        back ? [{ candidate_id: b, reason: "seen_before" }] : [],
      );
      expect(await roundOf(ctx.client, b)).toEqual(
        back ? [{ candidate_id: a, reason: "seen_before" }] : [],
      );
    });
  });

  test("the clock of an ended conversation counts Finnish days", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-ended-finnish", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    // 00:30 on 23 July in Helsinki, 89 days ago there, 22 July and 90 by the clock of Greenwich.
    const ended = new Date("2026-07-22T21:30:00.000Z");
    expect(finnishDay(ended)).toBe(addDays(DAY, -89));
    await endedConversation(ctx.client, a, b, ended, "closed");

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([]);
  });

  test("Two people with a conversation between them are never each other's cards", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-talking", 1, 2);
    const [a] = women;
    const [b, other] = men;
    if (!a || !b || !other) throw new Error("people not written");
    await conversationBetween(ctx.client, a, b);

    await fillAll(ctx.client, [a, b]);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([other]);
    expect(candidates(await roundOf(ctx.client, b))).toEqual([]);
  });

  test("A block never runs out", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-rounds-block-ladder", 1, 2);
    const [a] = women;
    const [b, other] = men;
    if (!a || !b || !other) throw new Error("people not written");
    await endedConversation(ctx.client, a, b, daysAgo(365), "closed");
    await blocks(await appAt(ctx.client), ctx.client, a, b);

    await fillAll(ctx.client, [a, b]);

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

    await fillAll(ctx.client, [a, same]);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([apart]);
    expect(candidates(await roundOf(ctx.client, same))).toEqual([]);
  });
});

describe("what seen means (ADR-062 §2)", () => {
  test("An entry queued and never displayed starts no clock, and its person is new again", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-seen-queued", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 1, null, { displayed: false });

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: b, reason: "matches_filters" }]);
  });

  test("a decision needs no seen report: seen means displayed or decided", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-seen-decided", 1, 2);
    const [a] = women;
    const [passed, skipped] = men;
    if (!a || !passed || !skipped) throw new Error("people not written");
    await shownBefore(ctx.client, a, passed, 1, "pass", { displayed: false });
    await shownBefore(ctx.client, a, skipped, 1, "skip", { displayed: false });

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: skipped, reason: "seen_before" },
    ]);
  });

  test("the phone's seen report is what displays a card, and a read alone displays none", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-seen-report", 1, 2);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const read = await readToday(app, ctx.client, a);
    const [shown, onlyServed] = accountsOf(read) ?? [];
    if (!shown || !onlyServed || men.length !== 2) throw new Error("no cards");
    const who = await signInAs(ctx.client, a);
    const seen = await app.request(`/rounds/${DAY}/entries/1/seen`, {
      method: "POST",
      headers: who.headers,
    });
    expect(seen.status).toBe(204);

    await fill(ctx.client, a, NEXT_NOON);

    // Served and never reported is new again, and new comes first.
    expect(await roundOf(ctx.client, a, NEXT_DAY)).toEqual([
      { candidate_id: onlyServed, reason: "matches_filters" },
      { candidate_id: shown, reason: "seen_before" },
    ]);
  });

  /** Whom the person's logs of earlier days still hold. */
  async function earlierEntries(db: Queryable, accountId: string) {
    const { rows } = await db.query<{ candidate_id: string }>(
      `SELECT e.candidate_id FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND r.day < $2`,
      [accountId, DAY],
    );
    return new Set(rows.map((row) => row.candidate_id));
  }

  test("The day's first read deletes what earlier days queued and never displayed", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-seen-deleted", 2, 3);
    const [a, other] = women;
    const [queued, displayed, decided] = men;
    if (!a || !other || !queued || !displayed || !decided) throw new Error("people not written");
    await shownBefore(ctx.client, a, queued, 1, null, { displayed: false });
    await shownBefore(ctx.client, a, displayed, 2, null);
    await shownBefore(ctx.client, a, decided, 3, "skip", { displayed: false });
    await shownBefore(ctx.client, other, queued, 1, null, { displayed: false });

    await fill(ctx.client, a);

    expect(await earlierEntries(ctx.client, a)).toEqual(new Set([displayed, decided]));
    expect(await earlierEntries(ctx.client, other)).toEqual(new Set([queued]));
  });

  test("only the day's first read deletes, and a person with no matching deletes nothing", async ({
    ctx,
  }) => {
    const { pond, women, men } = await pondOf(ctx, "test-seen-deleted-once", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 1, null, { displayed: false });
    await ctx.client.query("UPDATE ponds SET matching_open = false WHERE id = $1", [pond]);
    await fill(ctx.client, a);
    expect(await earlierEntries(ctx.client, a)).toEqual(new Set([b]));

    await openPond(ctx.client, pond);
    await fill(ctx.client, a);
    expect(await earlierEntries(ctx.client, a)).toEqual(new Set());

    // Written in by hand after the day opened: no later read of the day looks.
    await shownBefore(ctx.client, a, c, 1, null, { displayed: false });
    await fill(ctx.client, a);
    expect(await earlierEntries(ctx.client, a)).toEqual(new Set([c]));
  });

  test("A skip starts no clock, and the card returns another day", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-skip-returns", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    const app = await appAt(ctx.client);
    await readToday(app, ctx.client, a);
    expect((await decideAs(app, ctx.client, a, 1, "skip")).status).toBe(200);
    // Not the same day: the queue's order is its clock.
    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);

    const nextDay = await readToday(await appAt(ctx.client, NEXT_NOON), ctx.client, a);

    expect(nextDay.entries?.map((entry) => [entry.card.accountId, entry.reason])).toEqual([
      [b, "seen_before"],
    ]);
  });

  test("A card displayed and left undecided on an ended day reads as a skip", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-skip-undecided", 1, 3);
    const [a] = women;
    const [b, c, d] = men;
    if (!a || !b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 1, null);
    await shownBefore(ctx.client, a, c, 3, "skip");
    // A pass past its clock comes after them both, though it was shown longest ago.
    await shownBefore(ctx.client, a, d, 40, "pass");

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: c, reason: "seen_before" },
      { candidate_id: b, reason: "seen_before" },
      { candidate_id: d, reason: "seen_before" },
    ]);
  });

  test("A skip on a liked-you card answers nothing, and the like keeps waiting", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-skip-liked", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");
    const app = await appAt(ctx.client);
    const today = await readToday(app, ctx.client, a);
    expect(today.entries?.map((entry) => entry.reason)).toEqual(["liked_you"]);

    const skipped = await decideAs(app, ctx.client, a, 1, "skip");

    expect(skipped.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await skipped.json()).match).toBeNull();
    const talking = await ctx.client.query("SELECT 1 FROM conversation");
    expect(talking.rows).toEqual([]);
    const tomorrow = await readToday(await appAt(ctx.client, NEXT_NOON), ctx.client, a);
    expect(tomorrow.entries?.map((entry) => entry.reason)).toEqual(["liked_you"]);
    // Its last day, and the day after, when it has expired and the skip alone is left.
    await readToday(await appAt(ctx.client, daysOn(12)), ctx.client, a);
    expect((await roundOf(ctx.client, a, finnishDay(daysOn(12))))?.[0]?.reason).toBe("liked_you");
    await fill(ctx.client, a, daysOn(13));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(13)))).toEqual([
      { candidate_id: b, reason: "seen_before" },
    ]);
  });

  test("A pass whose earlier one has been pruned counts as a first", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-pass-pruned", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 366, "pass");
    expect(await pruneRounds(ctx.client, NOON)).toBe(1);
    const app = await appAt(ctx.client);

    const read = await readToday(app, ctx.client, a);
    expect(read.entries?.map((entry) => entry.reason)).toEqual(["matches_filters"]);
    expect((await decideAs(app, ctx.client, a, 1, "pass")).status).toBe(200);

    const { rows } = await ctx.client.query(
      `SELECT e.second_pass FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1`,
      [a],
    );
    expect(rows).toEqual([{ second_pass: false }]);
    await fill(ctx.client, a, daysOn(29));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(29)))).toEqual([]);
    await fill(ctx.client, a, daysOn(30));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(30)))).toEqual([
      { candidate_id: b, reason: "seen_before" },
    ]);
  });

  test("a second pass marked at the route holds the year, and the first pass's record may go", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-pass-second", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 40, "pass");
    const app = await appAt(ctx.client);
    expect((await readToday(app, ctx.client, a)).entries?.map((entry) => entry.reason)).toEqual([
      "seen_before",
    ]);
    expect((await decideAs(app, ctx.client, a, 1, "pass")).status).toBe(200);

    // Three hundred days on the first pass is pruned, and the mark alone says a year.
    const later = daysOn(330);
    expect(await pruneRounds(ctx.client, later)).toBe(1);
    await fill(ctx.client, a, later);
    expect(await roundOf(ctx.client, a, finnishDay(later))).toEqual([]);
    await fill(ctx.client, a, daysOn(365));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(365)))).toEqual([
      { candidate_id: b, reason: "seen_before" },
    ]);
  });

  test("A third pass is another year", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-pass-third", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 400, "pass");
    await shownBefore(ctx.client, a, b, 365, "pass", { secondPass: true });
    const app = await appAt(ctx.client);
    expect((await readToday(app, ctx.client, a)).entries?.map((entry) => entry.reason)).toEqual([
      "seen_before",
    ]);

    expect((await decideAs(app, ctx.client, a, 1, "pass")).status).toBe(200);

    const { rows } = await ctx.client.query(
      `SELECT e.second_pass FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND r.day = $2`,
      [a, DAY],
    );
    expect(rows).toEqual([{ second_pass: true }]);
    await fill(ctx.client, a, daysOn(364));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(364)))).toEqual([]);
    await fill(ctx.client, a, daysOn(365));
    expect(await roundOf(ctx.client, a, finnishDay(daysOn(365)))).toEqual([
      { candidate_id: b, reason: "seen_before" },
    ]);
  });

  test("the latest showing rules: somebody shown twice comes back by the later decision", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-seen-latest", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    // Passed yesterday after a skip long ago: the pass's clock runs, whatever came before.
    await shownBefore(ctx.client, a, b, 40, "skip");
    await shownBefore(ctx.client, a, b, 1, "pass");

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([]);
  });
});

describe("distance (#514, ADR-061 §5 to §7)", () => {
  /** Each card of a person's round with the band written on it, in order. */
  async function bandsOf(db: Queryable, accountId: string, day = DAY) {
    const { rows } = await db.query<{ candidate_id: string; distance: string | null }>(
      `SELECT e.candidate_id, e.distance FROM rounds r JOIN round_entries e ON e.round_id = r.id
        WHERE r.account_id = $1 AND r.day = $2 ORDER BY e.position`,
      [accountId, day],
    );
    return rows.map((row) => [row.candidate_id, row.distance]);
  }

  /** "A", a woman living in Kallio, and one man at each home; everybody's matching open. */
  async function around(ctx: TestContext, slug: string, homes: readonly string[]) {
    const pond = await pondNamed(ctx.client, slug);
    const [a] = await people(ctx.client, pond, 1, WOMEN);
    if (!a) throw new Error("A not written");
    const men: string[] = [];
    for (const home of homes) {
      const [man] = await people(ctx.client, pond, 1, { ...MEN, home });
      if (!man) throw new Error("a man not written");
      men.push(man);
    }
    await openPond(ctx.client, pond);
    return { pond, a, men };
  }

  const moves = async (ctx: TestContext, accountId: string, postalCode: string) => {
    const who = await signInAs(ctx.client, accountId);
    const res = await ctx.app.request("/account/home", {
      method: "PUT",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ postalCode }),
    });
    expect(res.status).toBe(200);
  };

  test("the queue writes new people nearest band first, whatever the soft matches, with each band", async ({
    ctx,
  }) => {
    const { a, men } = await around(ctx, "test-distance-order", [
      HOMES.far,
      HOMES.around,
      HOMES.close,
      HOMES.nearby,
    ]);
    const [far, further, close, nearby] = men;
    // The furthest is the most like her: it moves him up nothing.
    await ctx.client.query(
      `UPDATE profile SET fields = fields || '{"education": "amk", "drinking": "rarely"}'::jsonb
        WHERE account_id = ANY($1::uuid[])`,
      [[a, far]],
    );

    await fill(ctx.client, a);

    expect(await bandsOf(ctx.client, a)).toEqual([
      [nearby, "nearby"],
      [close, "close"],
      [further, "around"],
      [far, "far"],
    ]);
  });

  test("A distance deal-breaker keeps the two out of each other's rounds", async ({ ctx }) => {
    const { a, men } = await around(ctx, "test-distance-filter", [HOMES.nearby, HOMES.close]);
    const [b, c] = men;
    if (!b || !c) throw new Error("people not written");
    await ctx.client.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, 'distance', '["nearby"]', 'hard', true)`,
      [a],
    );

    await fillAll(ctx.client, [a, b, c]);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
    expect(candidates(await roundOf(ctx.client, b))).toEqual([a]);
    expect(candidates(await roundOf(ctx.client, c))).toEqual([]);
  });

  test("The liked-you places keep their order, whatever the band", async ({ ctx }) => {
    const { a, men } = await around(ctx, "test-distance-liked", [HOMES.far, HOMES.nearby]);
    const [b, c] = men;
    if (!b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 3, "like");
    await shownBefore(ctx.client, c, a, 1, "like");

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: b, reason: "liked_you" },
      { candidate_id: c, reason: "liked_you" },
    ]);
    expect(await bandsOf(ctx.client, a)).toEqual([
      [b, "far"],
      [c, "nearby"],
    ]);
  });

  test("Coming back keeps its order, whatever the band", async ({ ctx }) => {
    const { a, men } = await around(ctx, "test-distance-back", [HOMES.far, HOMES.nearby]);
    const [c, d] = men;
    if (!c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, a, c, 45, null);
    await shownBefore(ctx.client, a, d, 40, null);

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([
      { candidate_id: c, reason: "seen_before" },
      { candidate_id: d, reason: "seen_before" },
    ]);
    expect(await bandsOf(ctx.client, a)).toEqual([
      [c, "far"],
      [d, "nearby"],
    ]);
  });

  test("An entry keeps its band, so moving home and reading again says nothing new", async ({
    ctx,
  }) => {
    const { a, men } = await around(ctx, "test-distance-frozen", [HOMES.close]);
    const [b] = men;
    if (!b) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const said = async () =>
      (await readToday(app, ctx.client, a)).entries?.map((entry) => entry.distance);
    expect(await said()).toEqual(["close"]);

    // Next door to B, and then B far away: the entry is what was written.
    await moves(ctx, a, HOMES.close);
    expect(await said()).toEqual(["close"]);
    await moves(ctx, b, HOMES.far);
    expect(await said()).toEqual(["close"]);
  });

  test("A new home and a changed edge count from the next entry, never on an entry written", async ({
    ctx,
  }) => {
    const { a, men } = await around(ctx, "test-distance-next", [HOMES.close, HOMES.nearby]);
    const [b, c] = men;
    if (!b || !c) throw new Error("people not written");
    await fill(ctx.client, a);
    const written = [
      [c, "nearby"],
      [b, "close"],
    ];
    expect(await bandsOf(ctx.client, a)).toEqual(written);

    // To B's own area, and with nearby ending at a kilometre.
    await moves(ctx, a, HOMES.close);
    await setConfig(ctx.client, "distance_nearby_km", 1);

    expect(await bandsOf(ctx.client, a)).toEqual(written);
    // A's cards were never displayed, so their people are new again (ADR-062 §2).
    await fill(ctx.client, a, NEXT_NOON);
    expect(await bandsOf(ctx.client, a, NEXT_DAY)).toEqual([
      [b, "nearby"],
      [c, "close"],
    ]);
  });

  test("Only a round's entry says a band, and as a word", async ({ ctx }) => {
    const { a, men } = await around(ctx, "test-distance-word", [HOMES.close]);
    const [b] = men;
    if (!b) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const who = await signInAs(ctx.client, a);

    const round = await app.request("/rounds/today", { headers: who.headers });
    const text = await round.text();
    const [entry] = RoundResponse.parse(JSON.parse(text)).entries ?? [];
    expect(entry?.distance).toBe("close");
    expect(entry?.card).not.toHaveProperty("distance");

    const preview = await app.request("/profile/card", { headers: who.headers });
    const own = await preview.text();
    expect(JSON.parse(own).card).not.toHaveProperty("distance");
    // The word, and no figure behind it: neither kilometres nor a centre says how far.
    for (const answer of [text, own]) {
      expect(answer).not.toMatch(/\b(km|kilomet\w*|metres?)\b/i);
      expect(answer).not.toMatch(/"(x|y|edges|homePlace|home_place)"/);
    }
  });

  test("a person whose home left the list is in nobody's round, and gets none", async ({ ctx }) => {
    const { a, men } = await around(ctx, "test-distance-no-home", [HOMES.nearby, "12345"]);
    const [b, gone] = men;
    if (!b || !gone) throw new Error("people not written");

    await fillAll(ctx.client, [a, gone]);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
    expect(await roundOf(ctx.client, gone)).toBeNull();
  });

  test("an entry from before distance reads as no band", async ({ ctx }) => {
    const { a } = await around(ctx, "test-distance-old", [HOMES.nearby]);
    await fill(ctx.client, a);
    await ctx.client.query(
      `UPDATE round_entries SET distance = NULL
        WHERE round_id IN (SELECT id FROM rounds WHERE account_id = $1)`,
      [a],
    );
    const round = await readToday(await appAt(ctx.client), ctx.client, a);
    expect(round.entries?.map((entry) => entry.distance)).toEqual([null]);
  });
});

describe("liked-you (#97, ADR-037, ADR-062 §2)", () => {
  test("A like given on an ended day comes first in the liked person's queue, labelled", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-first", 1, 3);
    const [a] = women;
    const [b, c, d] = men;
    if (!a || !b || !c || !d) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");

    await fill(ctx.client, a);

    const round = await roundOf(ctx.client, a);
    expect(round?.[0]).toEqual({ candidate_id: b, reason: "liked_you" });
    expect(round?.slice(1).map((card) => card.reason)).toEqual([
      "matches_filters",
      "matches_filters",
    ]);
    expect(new Set(candidates(round).slice(1))).toEqual(new Set([c, d]));
  });

  test("More likes than a page all come, the oldest first and ahead of anybody new", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-all", 1, 13);
    const [a] = women;
    const [fresh, ...likers] = men;
    if (!a || !fresh) throw new Error("people not written");
    // Twelve likes a day apart, the first the oldest.
    for (const [i, liker] of likers.entries()) {
      await shownBefore(ctx.client, liker, a, 12 - i, "like");
    }
    const app = await appAt(ctx.client);

    const first = await readToday(app, ctx.client, a);

    expect(accountsOf(first)).toEqual(likers.slice(0, QUEUE_PAGE));
    expect(new Set(first.entries?.map((entry) => entry.reason))).toEqual(new Set(["liked_you"]));
    await passAll(app, ctx.client, a, first);

    const second = await readToday(app, ctx.client, a);

    expect(accountsOf(second)).toEqual(likers.slice(QUEUE_PAGE));
    await passAll(app, ctx.client, a, second);
    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([fresh]);
  });

  test("Fit moves no like", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-liked-fit");
    await openPond(ctx.client, pond);
    const soft: ProfileFields = { education: "amk", drinking: "rarely" };
    const [a] = await people(ctx.client, pond, 1, { ...WOMEN, fields: soft });
    const [b] = await people(ctx.client, pond, 1, MEN);
    const [c] = await people(ctx.client, pond, 1, { ...MEN, fields: soft });
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 2, "like");
    await shownBefore(ctx.client, c, a, 1, "like");

    await fill(ctx.client, a);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([b, c]);
  });

  describe("A like waits until it is answered or expires", () => {
    test.for([
      {
        days: 1,
        answer: '"A" has not seen it',
        outcome: 'first in "A"\'s queue, labelled liked you',
      },
      {
        days: 13,
        answer: '"A" left it undecided twelve days ago',
        outcome: 'first in "A"\'s queue, labelled liked you',
      },
      {
        days: 13,
        answer: '"A" skipped it twelve days ago',
        outcome: 'first in "A"\'s queue, labelled liked you',
      },
      {
        days: 14,
        answer: '"A" has not seen it',
        outcome: 'in "A"\'s queue as an ordinary card',
      },
      { days: 3, answer: '"A" passed it two days ago', outcome: 'not in "A"\'s queue' },
      { days: 3, answer: '"A" liked it two days ago', outcome: 'not in "A"\'s queue' },
    ])("$days days ago, $answer: $outcome", async ({ days, answer, outcome }, { ctx }) => {
      const { women, men } = await pondOf(ctx, `test-liked-wait-${days}-${answer.length}`, 1, 1);
      const [a] = women;
      const [b] = men;
      if (!a || !b) throw new Error("people not written");
      await shownBefore(ctx.client, b, a, days, "like");
      if (answer.includes("undecided")) await shownBefore(ctx.client, a, b, 12, null);
      if (answer.includes("skipped")) await shownBefore(ctx.client, a, b, 12, "skip");
      if (answer.includes("passed")) await shownBefore(ctx.client, a, b, 2, "pass");
      if (answer.includes("liked it")) await shownBefore(ctx.client, a, b, 2, "like");

      await fill(ctx.client, a);

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

  test("A like of today waits for the day to end", async ({ ctx }) => {
    const { women, men } = await pondOf(ctx, "test-liked-today", 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 0, "like");

    const read = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(read.entries?.map((entry) => entry.reason)).not.toContain("liked_you");
    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: b, reason: "matches_filters" }]);
  });

  test("A like never reaches the queue from somebody the person passed, or who no longer passes the filters", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-refused", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, a, b, 29, "pass");
    await shownBefore(ctx.client, b, a, 1, "like");
    await shownBefore(ctx.client, c, a, 1, "like");
    await ctx.client.query(
      `UPDATE preferences SET value = '["man"]'::jsonb WHERE account_id = $1 AND field = 'seeks'`,
      [c],
    );

    await fill(ctx.client, a);

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
    await eraseAccount({ db: ctx.client, logger, now: () => NOON }, erased);
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [hidden]);
    await conversationBetween(ctx.client, a, talking);

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: kept, reason: "liked_you" }]);
  });

  test("A shadow-banned person's queue holds no liked-you places, and the likes wait for the lift", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-liked-shadow", 1, 2);
    const [a] = women;
    const [b, c] = men;
    if (!a || !b || !c) throw new Error("people not written");
    await shownBefore(ctx.client, b, a, 1, "like");
    await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [a]);

    await fill(ctx.client, a);

    // A like back would make no match and tell A of the ban (ADR-024 §7): B is in no place.
    expect(await roundOf(ctx.client, a)).toEqual([{ candidate_id: c, reason: "matches_filters" }]);

    // The ban lifted, the next day's read opens with B's like, still within its days.
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [a]);
    await fill(ctx.client, a, NEXT_NOON);
    expect((await roundOf(ctx.client, a, NEXT_DAY))?.[0]).toEqual({
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
    await fillAll(ctx.client, [a, b]);
    const app = await appAt(ctx.client);
    const before = {
      today: await readToday(app, ctx.client, b),
      history: await exportRounds(ctx.client, b, 10),
    };

    expect((await decideAs(app, ctx.client, a, 1, "pass")).status).toBe(200);

    expect(await readToday(app, ctx.client, b)).toEqual(before.today);
    expect(await exportRounds(ctx.client, b, 10)).toEqual(before.history);
  });
});

/** `sender`'s like of `liked`, shown `days` ago, made a fish (#378). */
const fishBefore = (db: Queryable, sender: string, liked: string, days: number) =>
  shownBefore(db, sender, liked, days, "like", { fish: true });

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

    await fill(ctx.client, a);

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

      await fill(ctx.client, a);

      const round = await roundOf(ctx.client, a);
      expect(round?.[place - 1]).toEqual({
        candidate_id: who,
        reason: label === "fish" ? "fish" : "liked_you",
      });
    });
  });
});

describe("the inbox stop (ADR-062 §4)", () => {
  /** The maintainer's number of 01/11/2026 (matching_config inbox_stop), which every test here leaves as it stands. */
  const STOP = 30;

  /** `count` women of the pond, who each liked `liked` yesterday: likes their inbox can show. */
  async function pile(ctx: TestContext, pond: string, liked: string, count: number) {
    const likers = await people(ctx.client, pond, count, WOMEN);
    for (const liker of likers) await shownBefore(ctx.client, liker, liked, 1, "like");
    return likers;
  }

  /** "A", who has never met "B", "B" with `likes` likes waiting, and the pond. */
  async function pileOnB(ctx: TestContext, slug: string, likes: number) {
    const { pond, women, men } = await pondOf(ctx, slug, 1, 1);
    const [a] = women;
    const [b] = men;
    if (!a || !b) throw new Error("people not written");
    const likers = await pile(ctx, pond, b, likes);
    return { pond, a, b, likers };
  }

  describe("Somebody with inbox_stop likes waiting is in nobody's queue", () => {
    test.for([
      { likes: 29, outcome: 'in "A"\'s queue' },
      { likes: 30, outcome: 'not in "A"\'s queue' },
    ])("$likes likes: $outcome", async ({ likes, outcome }, { ctx }) => {
      const { a, b } = await pileOnB(ctx, `test-stop-${likes}`, likes);

      await fill(ctx.client, a);

      expect(await roundOf(ctx.client, a)).toEqual(
        outcome.startsWith("in") ? [{ candidate_id: b, reason: "matches_filters" }] : [],
      );
    });
  });

  describe("Only the likes the inbox could show now count towards the stop", () => {
    test.for([
      { like: "has expired" },
      { like: "was given today" },
      { like: "came from somebody who no longer fits" },
      { like: 'came from somebody "B" passed since' },
      { like: 'came from somebody "B" passed before it, within their clock' },
      { like: "came from somebody shadow-banned" },
    ])("one more that $like", async ({ like }, { ctx }) => {
      const { pond, a, b } = await pileOnB(ctx, `test-stop-counts-${like.length}`, STOP - 1);
      const [other] = await people(ctx.client, pond, 1, WOMEN);
      if (!other) throw new Error("people not written");
      const given = like === "has expired" ? 14 : like === "was given today" ? 0 : 1;
      await shownBefore(ctx.client, other, b, like.includes("since") ? 3 : given, "like");
      if (like.includes("no longer fits")) {
        await ctx.client.query(
          `UPDATE preferences SET value = '["woman"]'::jsonb WHERE account_id = $1 AND field = 'seeks'`,
          [other],
        );
      }
      if (like.includes("since")) await shownBefore(ctx.client, b, other, 2, "pass");
      if (like.includes("before it")) await shownBefore(ctx.client, b, other, 5, "pass");
      if (like.includes("shadow-banned")) {
        await ctx.client.query("UPDATE account SET state = 'shadow_banned' WHERE id = $1", [other]);
      }

      await fill(ctx.client, a);

      expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
    });
  });

  describe("Only a like or a pass clears one from the pile", () => {
    test.for([
      { decides: "likes", decision: "like", outcome: 'in "A"\'s queue' },
      { decides: "passes", decision: "pass", outcome: 'in "A"\'s queue' },
      { decides: "skips", decision: "skip", outcome: 'not in "A"\'s queue' },
    ])("$decides: $outcome", async ({ decision, outcome }, { ctx }) => {
      const { a, b } = await pileOnB(ctx, `test-stop-clears-${decision}`, STOP);
      const app = await appAt(ctx.client);
      const read = await readToday(app, ctx.client, b);
      expect(read.entries?.[0]?.reason).toBe("liked_you");

      expect((await decideAs(app, ctx.client, b, 1, decision)).status).toBe(200);
      await fill(ctx.client, a);

      expect(candidates(await roundOf(ctx.client, a))).toEqual(outcome.startsWith("in") ? [b] : []);
    });
  });

  test("a card of the pile left undecided clears nothing", async ({ ctx }) => {
    const { a, b } = await pileOnB(ctx, "test-stop-undecided", STOP);
    const app = await appAt(ctx.client);
    await readToday(app, ctx.client, b);
    const who = await signInAs(ctx.client, b);
    const seen = await app.request(`/rounds/${DAY}/entries/1/seen`, {
      method: "POST",
      headers: who.headers,
    });
    expect(seen.status).toBe(204);

    await fill(ctx.client, a);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([]);
  });

  test("The stop holds a person out of seen-before cards too", async ({ ctx }) => {
    const { a, b } = await pileOnB(ctx, "test-stop-seen", STOP);
    await shownBefore(ctx.client, a, b, 1, "skip");

    await fill(ctx.client, a);

    expect(await roundOf(ctx.client, a)).toEqual([]);
  });

  test("the stop lifted, the person comes back in the queue the next read adds to", async ({
    ctx,
  }) => {
    const { a, b } = await pileOnB(ctx, "test-stop-lifted", STOP);
    const app = await appAt(ctx.client);
    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);
    await readToday(app, ctx.client, b);

    expect((await decideAs(app, ctx.client, b, 1, "pass")).status).toBe(200);

    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([b]);
  });

  test("The stop holds back no like the person sent", async ({ ctx }) => {
    const { pond, b } = await pileOnB(ctx, "test-stop-sent", STOP);
    const [c] = await people(ctx.client, pond, 1, WOMEN);
    if (!c) throw new Error("people not written");
    await shownBefore(ctx.client, b, c, 1, "like");

    await fill(ctx.client, c);

    expect(await roundOf(ctx.client, c)).toEqual([{ candidate_id: b, reason: "liked_you" }]);
  });

  test("An entry queued already stays when the stop comes", async ({ ctx }) => {
    const { a, b } = await pileOnB(ctx, "test-stop-queued", STOP);
    await logged(ctx.client, a, DAY, [b]);

    const read = await readToday(await appAt(ctx.client), ctx.client, a);

    expect(accountsOf(read)).toEqual([b]);
  });

  test("The stop says nothing to anybody", async ({ ctx }) => {
    const { a, b } = await pileOnB(ctx, "test-stop-silent", STOP);
    const app = await appAt(ctx.client);
    const who = await signInAs(ctx.client, b);

    const asHeld = await (await app.request("/rounds/today", { headers: who.headers })).text();
    const toOther = await readToday(app, ctx.client, a);

    expect(JSON.stringify(toOther)).not.toContain(b);
    for (const answer of [asHeld, JSON.stringify(toOther)]) {
      expect(answer).not.toMatch(/stop|pile|held|waiting|inbox/i);
    }
    const keys = Object.keys(RoundResponse.parse(JSON.parse(asHeld))).sort();
    expect(keys).toEqual(["day", "entries", "fishToSend", "likesLeft", "yourTurn"]);
    expect(Object.keys(toOther).sort()).toEqual(keys);
  });

  test("An inbox_stop of 0 is off", async ({ ctx }) => {
    await withMatchingConfig(ctx.client, { inbox_stop: 0 });
    const { a, b } = await pileOnB(ctx, "test-stop-off", STOP);

    await fill(ctx.client, a);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([b]);
  });

  test("a queue goes on past the people held, past a page of them", async ({ ctx }) => {
    // Women in Kallio, and men nearby at the stop ahead of one far away: the walk reaches him.
    const { pond, women } = await pondOf(ctx, "test-stop-walks", 1, 0);
    const [a] = women;
    if (!a) throw new Error("people not written");
    const held = await people(ctx.client, pond, QUEUE_PAGE + 1, { ...MEN, home: HOMES.nearby });
    const [far] = await people(ctx.client, pond, 1, { ...MEN, home: HOMES.far });
    if (!far) throw new Error("people not written");
    // Each of them liked all of those men yesterday, in one round each: three hundred likes.
    for (const liker of await people(ctx.client, pond, STOP, WOMEN)) {
      const roundId = await logged(ctx.client, liker, finnishDay(daysAgo(1)), held);
      await ctx.client.query(
        "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
        [roundId, daysAgo(1)],
      );
    }

    await fill(ctx.client, a);

    expect(candidates(await roundOf(ctx.client, a))).toEqual([far]);
  });
});

describe("over the synthetic population", () => {
  // Three hundred people and everybody's first page: about twelve seconds here
  // and more under CI's coverage, past the default fifteen.
  test("every open person opens a day, and nobody a candidate a hard filter excludes, in either direction", {
    timeout: 60_000,
  }, async ({ ctx }) => {
    // The population lives in the seed's ponds, which this database has not been given.
    for (const pond of SEED_PONDS) {
      await ctx.client.query(
        `INSERT INTO ponds (slug, name_nominative) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING`,
        [pond.slug, pond.nameNominative],
      );
    }
    await writePopulation(
      ctx.client,
      generatePopulation({ size: 300, seed: 7, homes: { [HOME]: 1 } }),
      CONSENT_VERSIONS,
    );
    // Without the photos release nobody has a face, so nobody is complete: three approved rows
    // each, as the people of the other tests have, and the demo commands' open ponds.
    await ctx.client.query(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, position)
       SELECT p.account_id, md5(p.account_id::text || n::text), 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
              800, 1067, 'approved', n
         FROM profile p, generate_series(0, 2) n`,
    );
    await openPonds(ctx.client);

    // Everybody's pool facts, read as the builder reads them, to ask every card both ways.
    const { rows: ponds } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM ponds WHERE matching_open",
    );
    const everybody = new Map(
      (await Promise.all(ponds.map((pond) => subjectsOfPond(ctx.client, pond.id, NOON))))
        .flat()
        .map((subject) => [subject.id, subject]),
    );
    expect(everybody.size).toBeGreaterThan(50);
    for (const accountId of everybody.keys()) await fill(ctx.client, accountId);

    for (const [accountId, owner] of everybody) {
      const round = await roundOf(ctx.client, accountId);
      expect(round).not.toBeNull();
      expect((round ?? []).length).toBeLessThanOrEqual(QUEUE_PAGE);
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
// did not opt into them, across a whole pond's queues.
describe("the filters across a pond's queues", () => {
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
    await blocks(await appAt(ctx.client), ctx.client, she, her);

    await fillAll(ctx.client, ids);

    expect(candidates(await roundOf(ctx.client, she)).sort()).toEqual([x, y].sort());
    expect(candidates(await roundOf(ctx.client, her)).sort()).toEqual([x, y].sort());
    expect(candidates(await roundOf(ctx.client, x)).sort()).toEqual([she, her, y].sort());
  });

  test("A block holds for a later account of either identity", async ({ ctx }) => {
    const { pond, ids } = await alikePond(ctx, "test-rounds-blocks-later", 3);
    const [a, b, c] = ids;
    if (!a || !b || !c) throw new Error("people not written");
    await blocks(await appAt(ctx.client), ctx.client, a, b);
    // B deletes the account, the cooldown passes, and B comes back: a new
    // account on the same identity (a complete person here, given B's identity).
    await eraseAccount(await deps(ctx.client), b);
    const [again] = await people(ctx.client, pond, 1, ALIKE);
    if (!again) throw new Error("people not written");
    await ctx.client.query(
      "UPDATE account SET identity_id = (SELECT identity_id FROM account WHERE id = $2) WHERE id = $1",
      [again, b],
    );

    await fillAll(ctx.client, [a, again]);

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

    await fillQueue({ db: ctx.client, logger, now: () => NOON }, holder);
    await fillQueue({ db: ctx.client, logger, now: () => NOON }, smoker);

    expect(candidates(await roundOf(ctx.client, holder)).sort()).toEqual([open, never].sort());
    expect(candidates(await roundOf(ctx.client, smoker)).sort()).toEqual([open, never].sort());
    // Nothing of anybody's answers or filters reaches a log line.
    expect(JSON.stringify(lines())).not.toMatch(/smoking|never|regularly/);

    // The holder takes their own answer back: the deal-breaker is paused, and the next day shows both.
    await ctx.client.query("UPDATE profile SET fields = fields - 'smoking' WHERE account_id = $1", [
      holder,
    ]);
    await fill(ctx.client, smoker, NEXT_NOON);
    expect(candidates(await roundOf(ctx.client, smoker, NEXT_DAY))).toContain(holder);
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

    await fill(ctx.client, holder);

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

    await fillAll(ctx.client, [h, p]);

    expect(candidates(await roundOf(ctx.client, h))).toContain(c);
    expect(candidates(await roundOf(ctx.client, p))).toContain(smoker);
    // The holder's own screen says the same of P's deal-breaker.
    const who = await signInAs(ctx.client, p);
    const app = await appAt(ctx.client);
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

    await fillAll(ctx.client, [dancer, either]);

    expect(candidates(await roundOf(ctx.client, dancer))).toEqual([partner]);
    expect(await roundOf(ctx.client, either)).toEqual([]);
  });
});

describe("filters at once (ADR-062 §8)", () => {
  type Pair = { a: string; b: string };
  /** What takes the two out of each other's pool, and what brings them back. */
  type Change = (db: Queryable, pair: Pair) => Promise<unknown>;

  const seeks = (db: Queryable, id: string, genders: string[]) =>
    db.query("UPDATE preferences SET value = $2::jsonb WHERE account_id = $1 AND field = 'seeks'", [
      id,
      JSON.stringify(genders),
    ]);
  const ages = (db: Queryable, id: string, min: number, max: number) =>
    db.query(
      "UPDATE preferences SET value = $2::jsonb WHERE account_id = $1 AND field = 'age_window'",
      [id, JSON.stringify({ min, max })],
    );
  const wants = (db: Queryable, id: string, intent: string) =>
    db.query("UPDATE profile SET fields = fields || $2::jsonb WHERE account_id = $1", [
      id,
      JSON.stringify({ intent }),
    ]);
  const dealBreaker = (db: Queryable, id: string, field: string, accept: string[]) =>
    db.query(
      `INSERT INTO preferences (account_id, field, value, mode, include_unknown)
       VALUES ($1, $2, $3::jsonb, 'hard', false)`,
      [id, field, JSON.stringify(accept)],
    );
  const dropDealBreaker = (db: Queryable, id: string, field: string) =>
    db.query("DELETE FROM preferences WHERE account_id = $1 AND field = $2", [id, field]);
  const lives = (db: Queryable, id: string, home: string) =>
    db.query("UPDATE account SET home_place = $2 WHERE id = $1", [id, home]);

  /** "A", a woman, and "B", a man, who answered smoking and live close, in an open pond. */
  async function aPair(ctx: TestContext, slug: string) {
    const pond = await pondNamed(ctx.client, slug);
    await openPond(ctx.client, pond);
    const [a] = await people(ctx.client, pond, 1, { ...WOMEN, fields: { smoking: "never" } });
    const [b] = await people(ctx.client, pond, 1, { ...MEN, fields: { smoking: "never" } });
    if (!a || !b) throw new Error("people not written");
    return { pond, a, b };
  }

  const NARROW_AND_BACK: Record<string, [Change, Change]> = {
    '"A" seeks somebody else': [
      (db, { a }) => seeks(db, a, ["non_binary"]),
      (db, { a }) => seeks(db, a, ["man"]),
    ],
    '"B" seeks somebody else': [
      (db, { b }) => seeks(db, b, ["non_binary"]),
      (db, { b }) => seeks(db, b, ["woman"]),
    ],
    '"A" narrows the age window': [
      (db, { a }) => ages(db, a, 25, 30),
      (db, { a }) => ages(db, a, 25, 40),
    ],
    '"B" narrows the age window': [
      (db, { b }) => ages(db, b, 25, 30),
      (db, { b }) => ages(db, b, 25, 40),
    ],
    '"A" wants something else from it': [
      (db, { a }) => wants(db, a, "dance_partner"),
      (db, { a }) => wants(db, a, "open_to_either"),
    ],
    '"B" wants something else from it': [
      (db, { b }) => wants(db, b, "dance_partner"),
      (db, { b }) => wants(db, b, "open_to_either"),
    ],
    '"A" sets a deal-breaker "B" fails': [
      (db, { a }) => dealBreaker(db, a, "smoking", ["regularly"]),
      (db, { a }) => dropDealBreaker(db, a, "smoking"),
    ],
    '"B" sets a deal-breaker "A" fails': [
      (db, { b }) => dealBreaker(db, b, "smoking", ["regularly"]),
      (db, { b }) => dropDealBreaker(db, b, "smoking"),
    ],
    '"A" moves past their distance deal-breaker': [
      (db, { a }) => lives(db, a, HOMES.far),
      (db, { a }) => lives(db, a, HOME),
    ],
    '"B" moves past "A"\'s distance deal-breaker': [
      (db, { b }) => lives(db, b, HOMES.far),
      (db, { b }) => lives(db, b, HOME),
    ],
  };

  const logHolds = async (db: Queryable, accountId: string, candidateId: string) => {
    const { rows } = await db.query<{ decision: string | null }>(
      `SELECT e.decision FROM round_entries e JOIN rounds r ON r.id = e.round_id
        WHERE r.account_id = $1 AND e.candidate_id = $2`,
      [accountId, candidateId],
    );
    return rows;
  };

  describe("A change of what fits works on the next read, whoever makes it", () => {
    test.for(Object.keys(NARROW_AND_BACK))("%s", async (row, { ctx }) => {
      const pair = await aPair(ctx, `test-fits-${row.length}-${row.charCodeAt(1)}`);
      const { a, b } = pair;
      const [narrow, back] = NARROW_AND_BACK[row] as [Change, Change];
      if (row.includes("distance"))
        await dealBreaker(ctx.client, a, "distance", ["nearby", "close"]);
      const app = await appAt(ctx.client);
      const first = await readToday(app, ctx.client, a);
      expect(accountsOf(first)).toEqual([b]);

      await narrow(ctx.client, pair);

      expect((await readToday(app, ctx.client, a)).entries).toEqual([]);
      expect(await logHolds(ctx.client, a, b)).toEqual([{ decision: null }]);

      await back(ctx.client, pair);

      const again = await readToday(app, ctx.client, a);
      expect(again.entries?.map((entry) => [entry.position, entry.card.accountId])).toEqual([
        [1, b],
      ]);
    });
  });

  test("the entries that fit are served, past those that do not, and the page is the fitting ones'", async ({
    ctx,
  }) => {
    const { women, men } = await pondOf(ctx, "test-fits-some", 1, 12);
    const [a] = women;
    const [out] = men;
    if (!a || !out) throw new Error("people not written");
    const app = await appAt(ctx.client);
    const first = await readToday(app, ctx.client, a);
    const leftOut = first.entries?.[0]?.card.accountId ?? "";
    await seeks(ctx.client, leftOut, ["man"]);

    const read = await readToday(app, ctx.client, a);

    expect(accountsOf(read)).toEqual(accountsOf(first)?.slice(1));
    expect(await roundOf(ctx.client, a)).toHaveLength(QUEUE_PAGE);
  });

  test("One change narrows and widens at once, and both work on the next read", async ({ ctx }) => {
    const { pond, a, b } = await aPair(ctx, "test-fits-both");
    const [c] = await people(ctx.client, pond, 1, {
      complete: true,
      consented: true,
      gender: "non_binary",
      seeks: ["woman"],
    });
    if (!c) throw new Error("people not written");
    const app = await appAt(ctx.client);
    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([b]);

    await seeks(ctx.client, a, ["non_binary"]);

    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([c]);
  });

  test("Widening at the queue's end works on the next read", async ({ ctx }) => {
    const { pond, a, b } = await aPair(ctx, "test-fits-widen");
    const [c] = await people(ctx.client, pond, 1, {
      complete: true,
      consented: true,
      gender: "non_binary",
      seeks: ["woman"],
    });
    if (!c) throw new Error("people not written");
    const app = await appAt(ctx.client);
    await passAll(app, ctx.client, a, await readToday(app, ctx.client, a));
    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);

    await seeks(ctx.client, a, ["man", "non_binary"]);

    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([c]);
    expect(await logHolds(ctx.client, a, b)).toEqual([{ decision: "pass" }]);
  });

  describe("A new like asks both people's filters, and a card that no longer fits answers not_found", () => {
    test.for(['"A"', '"B"'])("%s narrows", async (who, { ctx }) => {
      const pair = await aPair(ctx, `test-fits-like-${who.charCodeAt(1)}`);
      const { a, b } = pair;
      const app = await appAt(ctx.client);
      await readToday(app, ctx.client, a);
      await seeks(ctx.client, who === '"A"' ? a : b, ["non_binary"]);

      const refused = await decideAs(app, ctx.client, a, 1, "like");

      expect(refused.status).toBe(404);
      expect(ErrorResponse.parse(await refused.json()).error.code).toBe("not_found");
      expect(await logHolds(ctx.client, a, b)).toEqual([{ decision: null }]);
      expect((await readToday(app, ctx.client, a)).likesLeft).toBe(10);
    });
  });

  describe("A pass or a skip of a card that no longer fits still works", () => {
    test.for([
      { decides: "passes", decision: "pass" },
      { decides: "skips", decision: "skip" },
    ])("$decides", async ({ decision }, { ctx }) => {
      const { a, b } = await aPair(ctx, `test-fits-${decision}`);
      const app = await appAt(ctx.client);
      await readToday(app, ctx.client, a);
      await seeks(ctx.client, b, ["man"]);

      expect((await decideAs(app, ctx.client, a, 1, decision)).status).toBe(200);

      expect(await logHolds(ctx.client, a, b)).toEqual([{ decision }]);
    });
  });

  test("A like taken back works when the card no longer fits", async ({ ctx }) => {
    const { a, b } = await aPair(ctx, "test-fits-taken-back");
    const app = await appAt(ctx.client);
    await readToday(app, ctx.client, a);
    expect((await decideAs(app, ctx.client, a, 1, "like")).status).toBe(200);
    await seeks(ctx.client, b, ["man"]);

    expect((await decideAs(app, ctx.client, a, 1, "pass")).status).toBe(200);

    expect(await logHolds(ctx.client, a, b)).toEqual([{ decision: "pass" }]);
  });

  test("a block between the read and the like leaves the like not found, as a filter does", async ({
    ctx,
  }) => {
    const { a, b } = await aPair(ctx, "test-fits-block");
    const app = await appAt(ctx.client);
    await readToday(app, ctx.client, a);
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
      [b, a],
    );

    expect((await decideAs(app, ctx.client, a, 1, "like")).status).toBe(404);
    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);
  });

  test("A like back asks the filters with what the other person's like waived", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-fits-waived");
    await openPond(ctx.client, pond);
    const [a] = await people(ctx.client, pond, 1, { ...WOMEN, fields: { smoking: "regularly" } });
    // Each refuses smokers; only B's like, on a card B relaxed smoking for, sets that aside for "A".
    const [b, c] = await people(ctx.client, pond, 2, { ...MEN, fields: { smoking: "never" } });
    if (!a || !b || !c) throw new Error("people not written");
    await dealBreaker(ctx.client, b, "smoking", ["never"]);
    await dealBreaker(ctx.client, c, "smoking", ["never"]);
    const roundId = await logged(ctx.client, b, addDays(DAY, -1), [
      { candidateId: a, reason: "relaxed", relaxedWith: ["smoking"] },
    ]);
    await ctx.client.query(
      "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
      [roundId, daysAgo(1)],
    );
    const app = await appAt(ctx.client);

    const read = await readToday(app, ctx.client, a);

    expect(read.entries?.map((entry) => [entry.card.accountId, entry.reason])).toEqual([
      [b, "liked_you"],
    ]);
    const liked = await decideAs(app, ctx.client, a, 1, "like");
    expect(liked.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await liked.json()).match).not.toBeNull();
  });

  test("a like waived on an expired day waives nothing any more", async ({ ctx }) => {
    const pond = await pondNamed(ctx.client, "test-fits-waived-expired");
    await openPond(ctx.client, pond);
    const [a] = await people(ctx.client, pond, 1, { ...WOMEN, fields: { smoking: "regularly" } });
    const [b] = await people(ctx.client, pond, 1, { ...MEN, fields: { smoking: "never" } });
    if (!a || !b) throw new Error("people not written");
    await dealBreaker(ctx.client, b, "smoking", ["never"]);
    const roundId = await logged(ctx.client, b, addDays(DAY, -14), [
      { candidateId: a, reason: "relaxed", relaxedWith: ["smoking"] },
    ]);
    await ctx.client.query(
      "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
      [roundId, daysAgo(14)],
    );

    expect(await fitsNow({ now: () => NOON }, ctx.client, a, [b])).toEqual(new Set());
  });

  test("a person who is not complete now fits nobody, and a person with no pond neither", async ({
    ctx,
  }) => {
    const { a, b } = await aPair(ctx, "test-fits-nobody");
    const now = { now: () => NOON };
    expect(await fitsNow(now, ctx.client, a, [b])).toEqual(new Set([b]));

    await ctx.client.query("DELETE FROM photo WHERE account_id = $1", [a]);
    expect(await fitsNow(now, ctx.client, a, [b])).toEqual(new Set());

    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [b]);
    expect(await fitsNow(now, ctx.client, b, [a])).toEqual(new Set());
  });

  test("a read of a pond closed since still asks the filters of what the log holds", async ({
    ctx,
  }) => {
    const { pond, a, b } = await aPair(ctx, "test-fits-closed");
    const app = await appAt(ctx.client);
    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([b]);
    await ctx.client.query("UPDATE ponds SET matching_open = false WHERE id = $1", [pond]);

    expect(accountsOf(await readToday(app, ctx.client, a))).toEqual([b]);
    await seeks(ctx.client, b, ["man"]);
    expect((await readToday(app, ctx.client, a)).entries).toEqual([]);
  });
});
