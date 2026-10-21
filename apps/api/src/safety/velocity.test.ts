import type { Queryable } from "@kuutti/db";
import { AutomaticBanQueue, ErrorResponse, PhotoUrlResponse, RoundResponse } from "@kuutti/schema";
import { vi } from "vitest";
import { type App, createApp } from "../app.ts";
import { lockAccountForSanction } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { saveRound } from "../matching/index.ts";
import {
  type SignedIn,
  signedInAccount,
  staffSession,
  withMatchingConfig,
} from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import {
  test as base,
  captureLogger,
  describe,
  expect,
  type LogLine,
  testConfig,
} from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { checkPhotoFetches, roundReadRule } from "./automatic.ts";

// The velocity rules (#86, ADR-041, features/safety/velocity.feature): other
// people's photos fetched, different people's cards served and the round
// read faster than a person does, each at its threshold and one below, what
// counts and what does not, the window's edge, a read refused, the rule off,
// two rules met at once, the person already out of sight and staff, two
// checks at once, what the person still reads, a reversal, the moderators'
// list, and a check that fails. The triggers go through the routes; what
// came before is written straight into the test's transaction, except the
// round's reads, which live in the app's memory and come through the route.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T.getTime() + ms);
const ago = (ms: number) => at(-ms);

/** A clock the test moves: every reading is where the test last set it. */
function clock() {
  let now = T;
  return { now: () => now, set: (to: Date) => (now = to) };
}

async function appOn(
  db: Queryable,
  now: () => Date,
): Promise<{ app: App; lines: () => LogLine[] }> {
  const { logger, lines } = await captureLogger();
  return {
    app: createApp({ config: testConfig(), logger, db, now, media: testMediaDeps().deps }),
    lines,
  };
}

const test = base.extend<{ time: ReturnType<typeof clock>; app: App }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest fixtures declare dependencies by destructuring
  time: async ({}, use) => {
    await use(clock());
  },
  app: async ({ ctx, time }, use) => {
    await use((await appOn(ctx.client, time.now)).app);
  },
});

/** Another person's photo on a card the viewer was shown, so the viewer may fetch it. */
async function othersPhoto(db: Queryable, viewer: SignedIn): Promise<string> {
  const owner = await signedInAccount(db);
  return cardShown(db, viewer.accountId, owner.accountId, ago(2 * HOUR));
}

/** Fetch-log rows of the photo for the account at the times given, as issuing its URLs leaves them. */
async function handed(
  db: Queryable,
  accountId: string,
  photoId: string,
  times: Date[],
  variant: "thumb" | "card" | "full" = "card",
  purpose: "profile" | "message" = "profile",
) {
  await db.query(
    `INSERT INTO photo_access (account_id, photo_id, variant, at, purpose)
     SELECT $1, $2, $3, unnest($4::timestamptz[]), $5`,
    [accountId, photoId, variant, times, purpose],
  );
}

/** `n` times a second apart, the last a second before `last`. */
const spread = (n: number, last: Date = T) =>
  Array.from({ length: n }, (_, i) => new Date(last.getTime() - (n - i) * SECOND));

const fetchPhoto = (app: App, who: SignedIn, photoId: string, variant: string) =>
  app.request(`/photos/${photoId}/${variant}`, { headers: who.headers });

async function fetched(app: App, who: SignedIn, photoId: string, variant = "card") {
  const answer = await fetchPhoto(app, who, photoId, variant);
  expect(answer.status).toBe(200);
  return PhotoUrlResponse.parse(await answer.json());
}

type SanctionRow = {
  kind: string;
  reason: string;
  created_by: string | null;
  rule: string | null;
  rule_count: number | null;
  lifted_at: Date | null;
};

async function sanctionsOf(db: Queryable, accountId: string): Promise<SanctionRow[]> {
  return (
    await db.query<SanctionRow>(
      `SELECT kind, reason, created_by, rule, rule_count, lifted_at FROM sanction
        WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    )
  ).rows;
}

const byRule = (rule: string, count: number) => ({
  kind: "shadow_ban",
  reason: "scraping",
  created_by: null,
  rule,
  rule_count: count,
  lifted_at: null,
});

/** A round for the viewer today with one complete person's card; that person's account id. */
async function roundWithOne(db: Queryable, viewer: SignedIn): Promise<string> {
  const [subject] = await people(db, null, 1, { complete: true, consented: true });
  if (!subject) throw new Error("person not written");
  const built = await saveRound(
    { db, logger: (await captureLogger()).logger, now: () => T },
    {
      accountId: viewer.accountId,
      day: finnishDay(T),
      ordering: "count",
      entries: [{ candidateId: subject, reason: "matches_filters" }],
    },
  );
  if (!built) throw new Error("round not built");
  return subject;
}

const readRound = (app: App, who: SignedIn) =>
  app.request("/rounds/today", { headers: who.headers });

async function roundRead(app: App, who: SignedIn): Promise<RoundResponse> {
  const answer = await readRound(app, who);
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

/** Reads of the round through the route, at the times given. */
async function readsAt(
  app: App,
  time: ReturnType<typeof clock>,
  who: SignedIn,
  times: Date[],
): Promise<RoundResponse[]> {
  const answers: RoundResponse[] = [];
  for (const t of times) {
    time.set(t);
    answers.push(await roundRead(app, who));
  }
  return answers;
}

/** The viewer was served the cards of `n` other people, a second apart, ending a second before `last`. */
async function servedCards(db: Queryable, viewer: SignedIn, n: number, last: Date = T) {
  const subjects = await people(db, null, n);
  for (const [i, subject] of subjects.entries()) {
    await cardShown(db, viewer.accountId, subject, new Date(last.getTime() - (n - i) * SECOND));
  }
}

const json = (headers: Record<string, string>, body: unknown) => ({
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("the photo rule", () => {
  describe("Other people's photos fetched within the hour shadow-ban the fetcher at the threshold", () => {
    test.for([
      [118, "not sanctioned"],
      [
        119,
        "shadow-banned by nobody for the reason scraping, by the rule photo_fetches counting 120",
      ],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app }) => {
      const a = await signedInAccount(ctx.client);
      const photo = await othersPhoto(ctx.client, a);
      // Both sizes count, spread over the last 59 minutes.
      const times = Array.from({ length: earlier }, (_, i) => ago(59 * MINUTE - i * 20 * SECOND));
      await handed(
        ctx.client,
        a.accountId,
        photo,
        times.filter((_, i) => i % 2 === 0),
        "card",
      );
      await handed(
        ctx.client,
        a.accountId,
        photo,
        times.filter((_, i) => i % 2 === 1),
        "full",
      );
      const url = await fetched(app, a, photo, "card");
      expect(url.variant).toBe("card");
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual(
        earlier === 119 ? [byRule("photo_fetches", 120)] : [],
      );
    });
  });

  test("Thumbs, the person's own photos and a conversation's photos do not count", async ({
    ctx,
    app,
  }) => {
    // Each kind alone, 119 of it: any one of them counted would meet the rule.
    const kinds = [
      { variant: "thumb", own: false, purpose: "profile" },
      { variant: "card", own: true, purpose: "profile" },
      { variant: "full", own: true, purpose: "profile" },
      { variant: "card", own: false, purpose: "message" },
      { variant: "full", own: false, purpose: "message" },
    ] as const;
    for (const kind of kinds) {
      const a = await signedInAccount(ctx.client);
      const photo = await othersPhoto(ctx.client, a);
      // A's own photo, as somebody else's card shows it.
      const viewer = await signedInAccount(ctx.client);
      const own = await cardShown(ctx.client, viewer.accountId, a.accountId, ago(2 * HOUR));
      await handed(
        ctx.client,
        a.accountId,
        kind.own ? own : photo,
        spread(119),
        kind.variant,
        kind.purpose,
      );
      // Under the day's budget of the size, so the last fetch is issued and checked.
      await withMatchingConfig(ctx.client, {
        photo_fetches_per_day: { thumb: 600, card: 300, full: 300 },
      });
      await fetched(app, a, photo, "full");
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
    }
  });

  test("A fetch as old as the window does not count", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, [ago(60 * MINUTE), ...spread(118)]);
    await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a fetch a millisecond inside the window counts", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, [ago(60 * MINUTE - 1), ...spread(118)]);
    await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("photo_fetches", 120)]);
  });

  test("A thumb is never checked, and the next card is", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(120));
    await fetched(app, a, photo, "thumb");
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
    await fetched(app, a, photo, "card");
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("photo_fetches", 121)]);
  });

  test("a full-size fetch is checked like a card", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(119));
    expect((await fetched(app, a, photo, "full")).variant).toBe("full");
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("photo_fetches", 120)]);
  });

  test("an erased or unknown account is never checked", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(120));
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [a.accountId]);
    const deps = { db: ctx.client, logger, now: () => T };
    await checkPhotoFetches(deps, a.accountId);
    await checkPhotoFetches(deps, "00000000-0000-4000-8000-000000000000");
    await roundReadRule(deps)("00000000-0000-4000-8000-000000000000");
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
    expect(lines()).toEqual([]);
  });

  test("a fetch refused changes nothing and checks nothing", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(120));
    // A photo never shown, and the day's card budget spent: neither is issued, neither is checked.
    const stranger = await signedInAccount(ctx.client);
    const unseen = await cardShown(
      ctx.client,
      stranger.accountId,
      (await signedInAccount(ctx.client)).accountId,
    );
    expect((await fetchPhoto(app, a, unseen, "card")).status).toBe(404);
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 600, card: 0, full: 60 },
    });
    expect((await fetchPhoto(app, a, photo, "card")).status).toBe(429);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  describe("A velocity rule writes nothing on a person already out of sight, or on staff", () => {
    test.for([
      ["shadow-banned by a moderator"],
      ["shadow-banned by the round reads rule"],
      ["a moderator"],
    ] as const)("%s", async ([standing], { ctx, time }) => {
      const { app, lines } = await appOn(ctx.client, time.now);
      const moderator = await staffSession(ctx.client);
      const a = await signedInAccount(ctx.client);
      const photo = await othersPhoto(ctx.client, a);
      await handed(ctx.client, a.accountId, photo, spread(119));
      if (standing === "shadow-banned by a moderator") {
        await ctx.client.query(
          `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_by, created_at)
           SELECT identity_id, id, 'shadow_ban', 'scraping', 'Seen in the queue.', $2, $3
             FROM account WHERE id = $1`,
          [a.accountId, moderator.identityId, ago(HOUR)],
        );
      }
      if (standing === "shadow-banned by the round reads rule") {
        await ctx.client.query(
          `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_at,
                                 rule, rule_count, rule_first_at)
           SELECT identity_id, id, 'shadow_ban', 'scraping', 'Applied by the automatic rule.', $2,
                  'round_reads', 30, $3
             FROM account WHERE id = $1`,
          [a.accountId, ago(HOUR), ago(HOUR + MINUTE)],
        );
      }
      if (standing === "a moderator") {
        await ctx.client.query(
          `INSERT INTO moderator_roles (identity_id, role, granted_by)
           SELECT identity_id, 'moderator', 'test' FROM account WHERE id = $1`,
          [a.accountId],
        );
      }
      const before = (await sanctionsOf(ctx.client, a.accountId)).length;
      await fetched(app, a, photo);
      expect((await sanctionsOf(ctx.client, a.accountId)).length).toBe(before);
      const warned = lines().filter((line) => line.msg?.startsWith("automatic rule met by"));
      expect(warned.map((line) => line.rule)).toEqual(
        standing === "a moderator" ? ["photo_fetches"] : [],
      );
      expect(lines().some((line) => line.msg === "automatic rule check failed")).toBe(false);
    });
  });

  test("Two fetches at the threshold at the same moment shadow-ban the person once", async () => {
    await withTwoConnections("kuutti-86-photos", async (pool, first, second) => {
      const { logger } = await captureLogger();
      const deps = (db: Queryable) => ({ db, logger, now: () => T });
      const a = await signedInAccount(pool);
      const photo = await othersPhoto(pool, a);
      await handed(pool, a.accountId, photo, spread(120));
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      // The first check holds A's rows with its ban written; the second met the
      // rule without the lock too, and waits on them.
      await checkPhotoFetches(deps(first), a.accountId);
      const racing = watched(checkPhotoFetches(deps(second), a.accountId));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      await racing.outcome;
      await second.query("COMMIT");
      expect(await sanctionsOf(pool, a.accountId)).toEqual([byRule("photo_fetches", 120)]);
    });
  });

  test("a check below its threshold, or on somebody already hidden, never waits on the sanction lock", async () => {
    await withTwoConnections("kuutti-86-unlocked", async (pool, first, second) => {
      const { logger, lines } = await captureLogger();
      const deps = { db: second, logger, now: () => T };
      const below = await signedInAccount(pool);
      await handed(pool, below.accountId, await othersPhoto(pool, below), spread(118));
      const hidden = await signedInAccount(pool);
      await handed(pool, hidden.accountId, await othersPhoto(pool, hidden), spread(150));
      await pool.query(
        `INSERT INTO sanction (identity_id, account_id, kind, reason, note, created_at,
                               rule, rule_count, rule_first_at)
         SELECT identity_id, id, 'shadow_ban', 'scraping', 'Applied by the automatic rule.', $2,
                'photo_fetches', 120, $3
           FROM account WHERE id = $1`,
        [hidden.accountId, ago(MINUTE), ago(HOUR)],
      );
      const rounds = roundReadRule(deps);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      for (const who of [below, hidden]) {
        // Somebody holds the person's sanction lock, as a ban, an erasure or another check does.
        await first.query("BEGIN");
        await lockAccountForSanction(first, who.accountId);
        for (const work of [
          () => checkPhotoFetches(deps, who.accountId),
          () => rounds(who.accountId),
        ]) {
          await second.query("BEGIN");
          const racing = watched(work());
          expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(false);
          await racing.outcome;
          await second.query("COMMIT");
        }
        await first.query("COMMIT");
      }
      expect(await sanctionsOf(pool, below.accountId)).toEqual([]);
      expect((await sanctionsOf(pool, hidden.accountId)).length).toBe(1);
      expect(lines()).toEqual([]);
    });
  });

  test("A person a velocity rule shadow-banned gets the answers they got before", async ({
    ctx,
    app,
  }) => {
    const a = await signedInAccount(ctx.client);
    await roundWithOne(ctx.client, a);
    const round = await roundRead(app, a);
    const photo = round.entries?.[0]?.card.photos[0]?.id as string;
    await handed(ctx.client, a.accountId, photo, spread(119));
    const url = await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("photo_fetches", 120)]);
    expect(await fetched(app, a, photo)).toEqual(url);
    expect(await roundRead(app, a)).toEqual(round);
  });

  test("After a reversal only the fetches that follow count", async ({ ctx, app, time }) => {
    const moderator = await staffSession(ctx.client);
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(119));
    await fetched(app, a, photo);
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM sanction WHERE account_id = $1 AND rule = 'photo_fetches'",
      [a.accountId],
    );
    time.set(at(MINUTE));
    const reversed = await app.request(
      `/admin/sanctions/${rows[0]?.id}/review`,
      json(moderator.headers, { outcome: "lift", note: "A person going through photos twice." }),
    );
    expect(reversed.status).toBe(200);
    time.set(at(2 * MINUTE));
    await fetched(app, a, photo);
    expect((await sanctionsOf(ctx.client, a.accountId)).filter((s) => !s.lifted_at)).toEqual([]);
  });

  test("A velocity ban waits on the moderators' list with its rule, its count and its first fetch", async ({
    ctx,
    app,
  }) => {
    const moderator = await staffSession(ctx.client);
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    const earlier = spread(119);
    await handed(ctx.client, a.accountId, photo, earlier);
    await fetched(app, a, photo);
    const list = AutomaticBanQueue.parse(
      await (
        await app.request("/admin/sanctions/automatic", { headers: moderator.headers })
      ).json(),
    );
    expect(list.items).toEqual([
      expect.objectContaining({
        accountId: a.accountId,
        rule: "photo_fetches",
        count: 120,
        firstAt: earlier[0]?.toISOString(),
        createdAt: T.toISOString(),
      }),
    ]);
    expect(list.total).toBe(1);
  });

  test("a check that fails changes no answer, and says which check in its line", async ({
    ctx,
    time,
  }) => {
    const { app, lines } = await appOn(ctx.client, time.now);
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await ctx.client.query(
      "DELETE FROM matching_config WHERE key = 'auto_shadow_ban_photo_fetches'",
    );
    await fetched(app, a, photo);
    const failed = lines().find((line) => line.msg === "automatic rule check failed");
    expect(failed).toMatchObject({ check: "photo_fetch", code: "internal_error" });
    expect(JSON.stringify(failed)).not.toContain(a.accountId);
  });

  test("a threshold of zero switches the photo rule off", async ({ ctx, app }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_photo_fetches: 0 });
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(200));
    await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });
});

describe("values set in the panel", () => {
  test("a shorter photo window set in the panel leaves out what the default would count", async ({
    ctx,
    app,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_photo_fetches_minutes: 10 });
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(119, ago(30 * MINUTE)));
    await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a lower photo threshold set in the panel bans at it", async ({ ctx, app }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_photo_fetches: 5 });
    const a = await signedInAccount(ctx.client);
    const photo = await othersPhoto(ctx.client, a);
    await handed(ctx.client, a.accountId, photo, spread(4));
    await fetched(app, a, photo);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("photo_fetches", 5)]);
  });

  test("a lower round-reads threshold set in the panel bans at it", async ({ ctx, app, time }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads: 3 });
    const a = await signedInAccount(ctx.client);
    await readsAt(app, time, a, [T, at(SECOND), at(2 * SECOND)]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("round_reads", 3)]);
  });

  test("a longer round-reads window set in the panel counts what the default would forget", async ({
    ctx,
    app,
    time,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads_minutes: 2 });
    const a = await signedInAccount(ctx.client);
    // Thirty reads over ninety seconds: never thirty within one minute.
    await readsAt(
      app,
      time,
      a,
      Array.from({ length: 30 }, (_, i) => at(i * 3 * SECOND)),
    );
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("round_reads", 30)]);
  });

  test("a shorter cards window set in the panel leaves out what the default would count", async ({
    ctx,
    app,
  }) => {
    await withMatchingConfig(ctx.client, {
      auto_shadow_ban_cards_served: 45,
      auto_shadow_ban_cards_served_minutes: 10,
    });
    const a = await signedInAccount(ctx.client);
    await servedCards(ctx.client, a, 44, ago(30 * MINUTE));
    await roundWithOne(ctx.client, a);
    await roundRead(app, a);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });
});

describe("the round rules", () => {
  describe("Reads of the round within a minute shadow-ban the reader at the threshold", () => {
    test.for([
      [28, "not sanctioned"],
      [29, "shadow-banned by nobody for the reason scraping, by the rule round_reads counting 30"],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app, time }) => {
      const a = await signedInAccount(ctx.client);
      await roundWithOne(ctx.client, a);
      const [first] = await readsAt(
        app,
        time,
        a,
        Array.from({ length: earlier }, (_, i) => at(i * 2 * SECOND)),
      );
      const [last] = await readsAt(app, time, a, [at(58 * SECOND)]);
      expect(last).toEqual(first);
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual(
        earlier === 29 ? [byRule("round_reads", 30)] : [],
      );
    });
  });

  test("A read of the round as old as the window is forgotten", async ({ ctx, app, time }) => {
    const a = await signedInAccount(ctx.client);
    await roundWithOne(ctx.client, a);
    await readsAt(app, time, a, [T, ...Array.from({ length: 28 }, (_, i) => at((i + 1) * SECOND))]);
    await readsAt(app, time, a, [at(MINUTE)]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("the reads a rule counted are its record: the first read and the count", async ({
    ctx,
    app,
    time,
  }) => {
    const a = await signedInAccount(ctx.client);
    await roundWithOne(ctx.client, a);
    await readsAt(
      app,
      time,
      a,
      Array.from({ length: 30 }, (_, i) => at(i * SECOND)),
    );
    const { rows } = await ctx.client.query<{ rule_first_at: Date; created_at: Date }>(
      "SELECT rule_first_at, created_at FROM sanction WHERE account_id = $1",
      [a.accountId],
    );
    expect(rows).toEqual([{ rule_first_at: T, created_at: at(29 * SECOND) }]);
  });

  test("A read refused over the day's cards is not counted", async ({ ctx, app, time }) => {
    await withMatchingConfig(ctx.client, { exposure_cards_per_day: 0 });
    const a = await signedInAccount(ctx.client);
    await roundWithOne(ctx.client, a);
    for (let i = 0; i < 30; i++) {
      time.set(at(i * SECOND));
      const answer = await readRound(app, a);
      expect(answer.status).toBe(429);
      expect(ErrorResponse.parse(await answer.json()).error.code).toBe("card_budget_exceeded");
    }
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a read with no round yet is counted like any other", async ({ ctx, app, time }) => {
    const a = await signedInAccount(ctx.client);
    const answers = await readsAt(
      app,
      time,
      a,
      Array.from({ length: 30 }, (_, i) => at(i * SECOND)),
    );
    expect(answers.every((round) => round.entries === null)).toBe(true);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("round_reads", 30)]);
  });

  test("a restart forgets the round's reads", async ({ ctx, time }) => {
    const a = await signedInAccount(ctx.client);
    await roundWithOne(ctx.client, a);
    const before = await appOn(ctx.client, time.now);
    await readsAt(
      before.app,
      time,
      a,
      Array.from({ length: 29 }, (_, i) => at(i * SECOND)),
    );
    const after = await appOn(ctx.client, time.now);
    await readsAt(after.app, time, a, [at(30 * SECOND)]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a quiet reader's reads are dropped once a window has passed, and count for nothing after", async ({
    ctx,
    app,
    time,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads: 2 });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await readsAt(app, time, b, [T]);
    // A's read a window later sweeps B's out of memory; B's next is B's only one in the window.
    await readsAt(app, time, a, [at(MINUTE + SECOND)]);
    await readsAt(app, time, b, [at(MINUTE + 2 * SECOND)]);
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a round read's check that fails changes no answer, and says which check in its line", async ({
    ctx,
    time,
  }) => {
    const { app, lines } = await appOn(ctx.client, time.now);
    const a = await signedInAccount(ctx.client);
    await ctx.client.query(
      "DELETE FROM matching_config WHERE key = 'auto_shadow_ban_round_reads_minutes'",
    );
    await roundRead(app, a);
    expect(lines().find((line) => line.msg === "automatic rule check failed")).toMatchObject({
      check: "round_read",
      code: "internal_error",
    });
  });

  test("reads while the rule is off are not kept", async ({ ctx, app, time }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads: 0 });
    const a = await signedInAccount(ctx.client);
    await readsAt(
      app,
      time,
      a,
      Array.from({ length: 5 }, (_, i) => at(i * SECOND)),
    );
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads: 2 });
    await readsAt(app, time, a, [at(5 * SECOND)]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("a reader's times are swept once a window, whether or not more reads come", async ({
    ctx,
    app,
    time,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads: 2 });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await readsAt(app, time, b, [T]);
      await readsAt(app, time, a, [at(59 * SECOND)]);
      // Nobody reads for a while. The sweep a window after B's read drops it
      // and keeps A's, still inside the window, and sweeps again later.
      time.set(at(MINUTE + SECOND));
      vi.advanceTimersByTime(MINUTE);
      // A longer window would count B's read at T again, had it been kept.
      await withMatchingConfig(ctx.client, { auto_shadow_ban_round_reads_minutes: 5 });
      await readsAt(app, time, b, [at(MINUTE + 2 * SECOND)]);
      await readsAt(app, time, a, [at(MINUTE + 3 * SECOND)]);
    } finally {
      vi.useRealTimers();
    }
    expect(await sanctionsOf(ctx.client, b.accountId)).toEqual([]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("round_reads", 2)]);
  });

  test("Cards served counts for nothing while its threshold is zero", async ({ ctx, app }) => {
    const a = await signedInAccount(ctx.client);
    await servedCards(ctx.client, a, 44, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    await roundRead(app, a);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  describe("Cards served within the hour shadow-ban the viewer at the threshold, once switched on", () => {
    test.for([
      [43, "not sanctioned"],
      [44, "shadow-banned by nobody for the reason scraping, by the rule cards_served counting 45"],
    ] as const)("%i earlier: %s", async ([earlier], { ctx, app }) => {
      await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
      const a = await signedInAccount(ctx.client);
      await servedCards(ctx.client, a, earlier, ago(MINUTE));
      await roundWithOne(ctx.client, a);
      await roundRead(app, a);
      expect(await sanctionsOf(ctx.client, a.accountId)).toEqual(
        earlier === 44 ? [byRule("cards_served", 45)] : [],
      );
    });
  });

  test("only the viewer's own cards count", async ({ ctx, app }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    await servedCards(ctx.client, b, 44, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    await roundRead(app, a);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("cards served switched on but not met leaves the reads to decide", async ({
    ctx,
    app,
    time,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
    const a = await signedInAccount(ctx.client);
    await servedCards(ctx.client, a, 10, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    await readsAt(
      app,
      time,
      a,
      Array.from({ length: 30 }, (_, i) => at(i * SECOND)),
    );
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("round_reads", 30)]);
  });

  test("a cards ban records its first card, and after a reversal only what follows counts", async ({
    ctx,
    app,
    time,
  }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
    const moderator = await staffSession(ctx.client);
    const a = await signedInAccount(ctx.client);
    await servedCards(ctx.client, a, 44, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    await roundRead(app, a);
    const { rows } = await ctx.client.query<{ id: string; rule_first_at: Date }>(
      "SELECT id, rule_first_at FROM sanction WHERE account_id = $1 AND rule = 'cards_served'",
      [a.accountId],
    );
    // The first of the 44, a second apart and ending a second before a minute ago.
    expect(rows[0]?.rule_first_at).toEqual(ago(MINUTE + 44 * SECOND));
    time.set(at(MINUTE));
    const reversed = await app.request(
      `/admin/sanctions/${rows[0]?.id}/review`,
      json(moderator.headers, { outcome: "lift", note: "Two rounds read across midnight." }),
    );
    expect(reversed.status).toBe(200);
    time.set(at(2 * MINUTE));
    await roundRead(app, a);
    expect((await sanctionsOf(ctx.client, a.accountId)).filter((s) => !s.lifted_at)).toEqual([]);
  });

  test("a card served as long ago as the window does not count", async ({ ctx, app }) => {
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
    const a = await signedInAccount(ctx.client);
    const [old] = await people(ctx.client, null, 1);
    await cardShown(ctx.client, a.accountId, old as string, ago(60 * MINUTE));
    await servedCards(ctx.client, a, 43, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    await roundRead(app, a);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([]);
  });

  test("When cards served and the reads are both met, cards served is recorded", async ({
    ctx,
    app,
    time,
  }) => {
    const a = await signedInAccount(ctx.client);
    await servedCards(ctx.client, a, 44, ago(MINUTE));
    await roundWithOne(ctx.client, a);
    // The first read serves the round's card, the forty-fifth person's.
    await readsAt(
      app,
      time,
      a,
      Array.from({ length: 29 }, (_, i) => at(i * 2 * SECOND)),
    );
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 45 });
    await readsAt(app, time, a, [at(58 * SECOND)]);
    expect(await sanctionsOf(ctx.client, a.accountId)).toEqual([byRule("cards_served", 45)]);
  });
});
