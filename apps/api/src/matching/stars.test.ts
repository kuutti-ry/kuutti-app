import type { Queryable } from "@kuutti/db";
import {
  ErrorResponse,
  RoundDecisionAnswer,
  RoundResponse,
  STARS_CEILING,
  StarAnswer,
  StarList,
} from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount, exportAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { ensureEventPartitions } from "../research/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import {
  captureLogger,
  describe,
  englishT,
  expect,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { openPond, people, pondNamed } from "../test/people.ts";
import { FITTING } from "../test/queue.ts";
import { pidOf, waitsFor, watched, withTwoConnections } from "../test/races.ts";
import { logged, shownAt } from "../test/rounds.ts";

// The stars (#575, ADR-064, features/matching/stars.feature): a star on a card, the
// queue leaving a starred person out, the list and whoever it leaves out, a card
// opened from it, a like or a pass taking the star off, the caller's own stars
// only, erasure of both sides and the export. Everybody here is in an open pond of
// their own, and fits everybody else there.

/** Noon in Helsinki on a Tuesday. */
const NOON = new Date("2026-10-20T09:00:00.000Z");
const TODAY = finnishDay(NOON);
const DAY_MS = 24 * 3600 * 1000;
const YESTERDAY_NOON = new Date(NOON.getTime() - DAY_MS);
const YESTERDAY = finnishDay(YESTERDAY_NOON);

type Person = { accountId: string; headers: { authorization: string } };

/** A clock a second later at each reading, from NOON. */
function ticking(): () => Date {
  let t = NOON.getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

async function appOn(db: Queryable, now: () => Date = ticking()): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now });
}

let ponds = 0;

/** `count` people who fit each other, in a pond of their own that is open, each signed in. */
async function cast(db: Queryable, count: number): Promise<Person[]> {
  ponds += 1;
  const pond = await pondNamed(db, `test-stars-${ponds}-${Math.floor(NOON.getTime() / 1000)}`);
  await openPond(db, pond);
  const ids = await people(db, pond, count, FITTING);
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** What every test needs at least: `count` people and an app. */
async function scene(ctx: TestContext, count: number): Promise<{ app: App; who: Person[] }> {
  return { app: await appOn(ctx.client), who: await cast(ctx.client, count) };
}

const person = (who: readonly Person[], index: number): Person => {
  const found = who[index];
  if (!found) throw new Error("cast not written");
  return found;
};

const putStar = (app: App, who: Person, day: string, position: number) =>
  app.request(`/rounds/${day}/entries/${position}/star`, { method: "PUT", headers: who.headers });

async function star(app: App, who: Person, position: number, day = TODAY): Promise<StarAnswer> {
  const answer = await putStar(app, who, day, position);
  expect(answer.status).toBe(200);
  return StarAnswer.parse(await answer.json());
}

const clear = (app: App, who: Person, id: string) =>
  app.request(`/stars/${id}`, { method: "DELETE", headers: who.headers });

const open = (app: App, who: Person, id: string) =>
  app.request(`/stars/${id}/open`, { method: "POST", headers: who.headers });

async function opened(app: App, who: Person, id: string): Promise<RoundResponse> {
  const answer = await open(app, who, id);
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

async function listOf(app: App, who: Person) {
  const answer = await app.request("/stars", { headers: who.headers });
  expect(answer.status).toBe(200);
  return StarList.parse(await answer.json()).items;
}

async function readToday(app: App, who: Person): Promise<RoundResponse> {
  const answer = await app.request("/rounds/today", { headers: who.headers });
  expect(answer.status).toBe(200);
  return RoundResponse.parse(await answer.json());
}

const decide = (app: App, who: Person, day: string, position: number, decision: string) =>
  app.request(`/rounds/${day}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

async function errorCode(answer: Response): Promise<string> {
  return ErrorResponse.parse(await answer.json()).error.code;
}

/** Whose cards `who` is shown, in order. */
const cardsOf = (round: RoundResponse) => (round.entries ?? []).map((e) => e.card.accountId);

/** The stars `who` holds, by the ones they are on. */
async function starsOf(db: Queryable, who: Person): Promise<string[]> {
  const { rows } = await db.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM star WHERE account_id = $1 ORDER BY candidate_id",
    [who.accountId],
  );
  return rows.map((row) => row.candidate_id);
}

/** `owner` was shown `candidate`'s card yesterday, left it undecided and left a star on it; the star's id. */
async function starredYesterday(db: Queryable, owner: Person, candidate: Person): Promise<string> {
  await shownAt(db, YESTERDAY_NOON, owner.accountId, candidate.accountId, null);
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO star (account_id, candidate_id, created_at) VALUES ($1, $2, $3) RETURNING id",
    [owner.accountId, candidate.accountId, YESTERDAY_NOON],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("star not written");
  return id;
}

/** `who`'s like or fish of `on`, of yesterday, waits on them. */
const likedYesterday = (db: Queryable, who: Person, on: Person, fish = false) =>
  shownAt(db, YESTERDAY_NOON, who.accountId, on.accountId, "like", { fish });

const setAges = (db: Queryable, who: Person, ages: { min: number; max: number }) =>
  db.query(
    "UPDATE preferences SET value = $2::jsonb WHERE account_id = $1 AND field = 'age_window'",
    [who.accountId, JSON.stringify(ages)],
  );

const setSeeks = (db: Queryable, who: Person, seeks: string[]) =>
  db.query("UPDATE preferences SET value = $2::jsonb WHERE account_id = $1 AND field = 'seeks'", [
    who.accountId,
    JSON.stringify(seeks),
  ]);

const setState = (db: Queryable, who: Person, state: string) =>
  db.query("UPDATE account SET state = $2::account_state WHERE id = $1", [who.accountId, state]);

const setPhotos = (db: Queryable, who: Person, state: string) =>
  db.query("UPDATE photo SET state = $2::photo_state WHERE account_id = $1", [
    who.accountId,
    state,
  ]);

async function block(db: Queryable, blocker: Person, blocked: Person) {
  await db.query(
    `INSERT INTO block (blocker_identity_id, blocked_identity_id)
     SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
    [blocker.accountId, blocked.accountId],
  );
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

describe("a star on a card", () => {
  test("A star spends nothing and leaves the card undecided", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    await withMatchingConfig(ctx.client, { like_budget_balanced: 0 });

    const { id } = await star(app, a, 1);

    const next = await readToday(app, a);
    expect(cardsOf(next)).toEqual([c.accountId]);
    expect(next.likesLeft).toBe(0);
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
    expect(id).toEqual(expect.any(String));
    const { rows } = await ctx.client.query<{ decision: string | null }>(
      "SELECT e.decision FROM round_entries e JOIN rounds r ON r.id = e.round_id WHERE r.account_id = $1 AND e.candidate_id = $2",
      [a.accountId, b.accountId],
    );
    expect(rows).toEqual([{ decision: null }]);
    // Nothing was spent: the same day's likes, when there are some, are all there.
    await withMatchingConfig(ctx.client, { like_budget_balanced: 3 });
    expect((await readToday(app, a)).likesLeft).toBe(3);
  });

  test("Nobody is told of a star, and it is in no event", async ({ ctx }) => {
    await ensureEventPartitions(ctx.client, NOON);
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await joinStudy(app, a);
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    const before = await readToday(app, b);
    const events = async () =>
      (await ctx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM events")).rows[0]?.n;
    const eventsBefore = await events();

    await star(app, a, 1);

    const after = await readToday(app, b);
    expect(after).toEqual(before);
    expect(after.entries?.every((entry) => entry.star === null)).toBe(true);
    expect(await events()).toBe(eventsBefore);
  });

  test("A star counts for nothing in the inbox stop", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 4);
    const [a, b, c, liker] = [person(who, 0), person(who, 1), person(who, 2), person(who, 3)];
    await withMatchingConfig(ctx.client, { inbox_stop: 2 });
    await likedYesterday(ctx.client, liker, b);
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);

    await star(app, a, 1);

    expect(cardsOf(await readToday(app, c))).toContain(b.accountId);
  });

  test("A star again answers the same star", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);

    const first = await star(app, a, 1);
    const again = await star(app, a, 1);

    expect(again).toEqual({ id: first.id, first: false });
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
  });

  test("The first star says it is the only one", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);

    expect((await star(app, a, 1)).first).toBe(true);
    expect((await star(app, a, 2)).first).toBe(false);
  });

  test("A card of a day that has ended takes no star", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, YESTERDAY, [b.accountId]);

    const answer = await putStar(app, a, YESTERDAY, 1);

    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("round_expired");
    expect(await starsOf(ctx.client, a)).toEqual([]);
  });

  test("A day not begun has no card to star", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 1);
    const answer = await putStar(app, person(who, 0), "2026-10-21", 1);
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("not_found");
  });

  test("Another person's card is out of reach", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);

    const answer = await putStar(app, c, TODAY, 1);

    expect(answer.status).toBe(404);
    expect(await starsOf(ctx.client, c)).toEqual([]);
    expect(await starsOf(ctx.client, a)).toEqual([]);
  });

  test("A card that can no longer be shown takes no star", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    await block(ctx.client, a, b);
    await setState(ctx.client, c, "suspended");

    for (const position of [1, 2]) {
      const answer = await putStar(app, a, TODAY, position);
      expect(answer.status).toBe(404);
    }
    expect(await starsOf(ctx.client, a)).toEqual([]);
  });

  test("A card holding a like or a pass takes no star", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    expect((await decide(app, a, TODAY, 1, "like")).status).toBe(200);
    expect((await decide(app, a, TODAY, 2, "pass")).status).toBe(200);

    for (const position of [1, 2]) {
      const answer = await putStar(app, a, TODAY, position);
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
    }
    expect(await starsOf(ctx.client, a)).toEqual([]);
  });

  test("A place out of bounds is refused before anything is read", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 1);
    const a = person(who, 0);
    for (const position of ["0", "-1", "32768", "x"]) {
      const answer = await app.request(`/rounds/${TODAY}/entries/${position}/star`, {
        method: "PUT",
        headers: a.headers,
      });
      expect(answer.status, position).toBe(400);
    }
    const badDay = await app.request("/rounds/yesterday/entries/1/star", {
      method: "PUT",
      headers: a.headers,
    });
    expect(badDay.status).toBe(400);
  });
});

describe("the cap", () => {
  test("At the most stars a person may hold, one more is refused", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 4);
    const [a, b, c, d] = [person(who, 0), person(who, 1), person(who, 2), person(who, 3)];
    await withMatchingConfig(ctx.client, { stars_max: 2 });
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId, d.accountId]);
    await star(app, a, 1);
    await star(app, a, 2);

    const answer = await putStar(app, a, TODAY, 3);

    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("stars_full");
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId, c.accountId].sort());
  });

  test("One star under the most a person may hold still goes", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await withMatchingConfig(ctx.client, { stars_max: 2 });
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    await star(app, a, 1);

    await star(app, a, 2);

    expect((await starsOf(ctx.client, a)).length).toBe(2);
  });

  test("The cap of zero is off, and the contract's ceiling stands", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await withMatchingConfig(ctx.client, { stars_max: 0 });
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    // All but one of the ceiling, on people the list leaves out: no profile, so quick to write.
    const pond = await pondNamed(ctx.client, "test-stars-ceiling");
    const others = await people(ctx.client, pond, STARS_CEILING - 1);
    await ctx.client.query(
      "INSERT INTO star (account_id, candidate_id) SELECT $1, unnest($2::uuid[])",
      [a.accountId, others],
    );

    // Off: nothing stops the star that reaches the ceiling.
    await star(app, a, 1);
    const answer = await putStar(app, a, TODAY, 2);

    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("stars_full");
    expect((await starsOf(ctx.client, a)).length).toBe(STARS_CEILING);
  });

  test("Somebody left out of the list does not count towards the cap", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 4);
    const [a, b, c, d] = [person(who, 0), person(who, 1), person(who, 2), person(who, 3)];
    await withMatchingConfig(ctx.client, { stars_max: 2 });
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId, d.accountId]);
    await star(app, a, 1);
    await star(app, a, 2);
    await setAges(ctx.client, c, { min: 18, max: 19 });

    await star(app, a, 3);

    expect((await starsOf(ctx.client, a)).length).toBe(3);
  });

  test("Two devices at the cap: the second star waits for the first, and is refused", async () => {
    await withTwoConnections("kuutti-575-cap", async (pool, first, second) => {
      const who = await cast(pool, 3);
      const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
      await withMatchingConfig(pool, { stars_max: 1 });
      await logged(pool, a.accountId, TODAY, [b.accountId, c.accountId]);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstApp = await appOn(first);
      const secondApp = await appOn(second);
      await star(firstApp, a, 1);
      const racing = watched(putStar(secondApp, a, TODAY, 2));
      expect(await waitsFor(pool, secondPid, firstPid, racing.settled)).toBe(true);
      await first.query("COMMIT");
      const answer = await racing.outcome;
      await second.query("COMMIT");
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(409);
      expect(await starsOf(pool, a)).toEqual([b.accountId]);
    });
  });
});

describe("the queue and a star", () => {
  test("A starred person is not offered again as a card", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await starredYesterday(ctx.client, a, b);

    const round = await readToday(app, a);

    expect(cardsOf(round)).toEqual([c.accountId]);
    expect((await decide(app, a, TODAY, round.entries?.[0]?.position ?? 0, "skip")).status).toBe(
      200,
    );
    expect(cardsOf(await readToday(app, a))).toEqual([]);
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
  });

  test("A card starred today leaves the queue at the next read", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    expect(cardsOf(await readToday(app, a))).toEqual([b.accountId]);

    await star(app, a, 1);

    expect(cardsOf(await readToday(app, a))).toEqual([]);
  });

  test("Clearing a star puts them back in the queue", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);

    expect((await clear(app, a, id)).status).toBe(204);

    const round = await readToday(app, a);
    expect(cardsOf(round)).toEqual([b.accountId]);
    expect(round.entries?.[0]?.reason).toBe("seen_before");
    expect(round.entries?.[0]?.star).toBeNull();
  });

  test("A star changes nothing for a like that waits", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    await likedYesterday(ctx.client, b, a);

    const round = await readToday(app, a);

    expect(cardsOf(round)).toEqual([b.accountId]);
    expect(round.entries?.[0]?.reason).toBe("liked_you");
    expect(round.entries?.[0]?.star).toBe(id);
  });

  test("A read says the star on a card that holds one, and null on another", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [
      { candidateId: b.accountId, reason: "liked_you" },
      c.accountId,
    ]);
    const { id } = await star(app, a, 1);

    const round = await readToday(app, a);

    expect(round.entries?.map((entry) => entry.star)).toEqual([id, null]);
  });

  describe("A like or a pass takes the star off, and a skip does not", () => {
    test.for([
      { choice: "like", on: false },
      { choice: "fish", on: false },
      { choice: "pass", on: false },
      { choice: "skip", on: true },
    ])("$choice", async ({ choice, on }, { ctx }) => {
      const { app, who } = await scene(ctx, 2);
      const [a, b] = [person(who, 0), person(who, 1)];
      await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
      await star(app, a, 1);

      expect((await decide(app, a, TODAY, 1, choice)).status).toBe(200);

      expect(await starsOf(ctx.client, a)).toEqual(on ? [b.accountId] : []);
    });
  });

  test("A like refused leaves the star on", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    await star(app, a, 1);
    await withMatchingConfig(ctx.client, { like_budget_balanced: 0 });

    const answer = await decide(app, a, TODAY, 1, "like");

    expect(answer.status).toBe(429);
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
  });

  test("A like taken back does not bring the star back", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    await star(app, a, 1);
    expect((await decide(app, a, TODAY, 1, "like")).status).toBe(200);

    expect((await decide(app, a, TODAY, 1, "skip")).status).toBe(200);

    expect(await starsOf(ctx.client, a)).toEqual([]);
    // Once it holds no like, the card takes a star again.
    await star(app, a, 1);
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
  });
});

describe("the list", () => {
  test("The list holds the people starred, the latest first, with their name, age and a photo shown", async ({
    ctx,
  }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId, c.accountId]);
    const photoOfB = await cardShown(ctx.client, a.accountId, b.accountId, NOON);
    const photoOfC = await cardShown(ctx.client, a.accountId, c.accountId, NOON);
    const starOnB = await star(app, a, 1);
    const starOnC = await star(app, a, 2);

    const list = await listOf(app, a);

    expect(list).toEqual([
      {
        id: starOnC.id,
        name: "Aino",
        age: 36,
        photo: { id: photoOfC, blurhash: expect.any(String) },
      },
      {
        id: starOnB.id,
        name: "Aino",
        age: 36,
        photo: { id: photoOfB, blurhash: expect.any(String) },
      },
    ]);
    // The star's id and nobody's account.
    expect(JSON.stringify(list)).not.toContain(b.accountId);
    expect(JSON.stringify(list)).not.toContain(c.accountId);
  });

  test("The list offers no photo the person was never shown", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    const { id } = await star(app, a, 1);

    expect(await listOf(app, a)).toEqual([{ id, name: "Aino", age: 36, photo: null }]);
  });

  test("An empty list is a list, and it holds nobody else's stars", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    await star(app, a, 1);

    expect(await listOf(app, c)).toEqual([]);
    expect(await listOf(app, b)).toEqual([]);
  });

  describe("The list leaves out whoever may not be shown, and takes them back", () => {
    const AGES = { min: 25, max: 40 };
    const NOT_THESE = { min: 18, max: 19 };
    type Change = (db: Queryable, a: Person, b: Person) => Promise<unknown>;
    const rows: { what: string; on: Change; off: Change }[] = [
      {
        what: "A narrowed their ages past B",
        on: (db, a) => setAges(db, a, NOT_THESE),
        off: (db, a) => setAges(db, a, AGES),
      },
      {
        what: "B narrowed their ages past A",
        on: (db, _a, b) => setAges(db, b, NOT_THESE),
        off: (db, _a, b) => setAges(db, b, AGES),
      },
      {
        what: "B stopped seeking A's gender",
        on: (db, _a, b) => setSeeks(db, b, ["woman"]),
        off: (db, _a, b) => setSeeks(db, b, ["non_binary"]),
      },
      {
        what: "A stopped seeking B's gender",
        on: (db, a) => setSeeks(db, a, ["woman"]),
        off: (db, a) => setSeeks(db, a, ["non_binary"]),
      },
      {
        what: "B paused",
        on: (db, _a, b) => setState(db, b, "paused"),
        off: (db, _a, b) => setState(db, b, "active"),
      },
      {
        what: "A paused",
        on: (db, a) => setState(db, a, "paused"),
        off: (db, a) => setState(db, a, "active"),
      },
      {
        what: "B was shadow-banned",
        on: (db, _a, b) => setState(db, b, "shadow_banned"),
        off: (db, _a, b) => setState(db, b, "active"),
      },
      {
        what: "B was suspended",
        on: (db, _a, b) => setState(db, b, "suspended"),
        off: (db, _a, b) => setState(db, b, "active"),
      },
      {
        what: "B took down the photos that completed them",
        on: (db, _a, b) => setPhotos(db, b, "rejected"),
        off: (db, _a, b) => setPhotos(db, b, "approved"),
      },
    ];
    test.for(rows)("$what", async ({ on, off }, { ctx }) => {
      const { app, who } = await scene(ctx, 2);
      const [a, b] = [person(who, 0), person(who, 1)];
      await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
      const { id } = await star(app, a, 1);

      await on(ctx.client, a, b);

      expect(await listOf(app, a)).toEqual([]);
      const refused = await open(app, a, id);
      expect(refused.status).toBe(404);
      // The star stands meanwhile, with no clock on it.
      expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);

      await off(ctx.client, a, b);

      expect((await listOf(app, a)).map((item) => item.id)).toEqual([id]);
      expect((await open(app, a, id)).status).toBe(200);
    });
  });

  test("Somebody who blocks stays out of the list for good, either way", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const hers = await starredYesterday(ctx.client, a, b);
    const his = await starredYesterday(ctx.client, b, a);
    expect(await listOf(app, a)).toHaveLength(1);
    expect(await listOf(app, b)).toHaveLength(1);

    await block(ctx.client, a, b);

    expect(await listOf(app, a)).toEqual([]);
    expect(await listOf(app, b)).toEqual([]);
    expect((await open(app, a, hers)).status).toBe(404);
    expect((await open(app, b, his)).status).toBe(404);
  });

  test("Somebody past the inbox stop is left out, and back once below it", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, liker] = [person(who, 0), person(who, 1), person(who, 2)];
    await withMatchingConfig(ctx.client, { inbox_stop: 1 });
    await likedYesterday(ctx.client, liker, b);
    const id = await starredYesterday(ctx.client, a, b);

    expect(await listOf(app, a)).toEqual([]);
    expect((await open(app, a, id)).status).toBe(404);

    // B goes through the like, and the pile falls below the stop.
    await shownAt(ctx.client, NOON, b.accountId, liker.accountId, "pass");

    expect((await listOf(app, a)).map((item) => item.id)).toEqual([id]);
    expect((await open(app, a, id)).status).toBe(200);
  });

  test("An inbox stop of zero is off, and leaves nobody out", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, liker] = [person(who, 0), person(who, 1), person(who, 2)];
    await withMatchingConfig(ctx.client, { inbox_stop: 0 });
    await likedYesterday(ctx.client, liker, b);
    const id = await starredYesterday(ctx.client, a, b);

    expect((await listOf(app, a)).map((item) => item.id)).toEqual([id]);
  });

  test("The list of somebody with no open matching is empty", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    const pond = async (open: boolean) =>
      ctx.client.query(
        "UPDATE ponds SET matching_open = $2 WHERE id = (SELECT pond_id FROM account WHERE id = $1)",
        [a.accountId, open],
      );

    await pond(false);
    expect(await listOf(app, a)).toEqual([]);
    expect((await open(app, a, id)).status).toBe(404);
    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);

    await pond(true);
    expect((await listOf(app, a)).map((item) => item.id)).toEqual([id]);
  });
});

describe("a card opened from the list", () => {
  test("Opening a star writes the card into today's log, labelled seen before", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);

    const answer = await opened(app, a, id);

    expect(answer.day).toBe(TODAY);
    const [entry] = answer.entries ?? [];
    expect(answer.entries).toHaveLength(1);
    expect(entry).toMatchObject({
      reason: "seen_before",
      decision: null,
      star: id,
      distance: "nearby",
    });
    expect(entry?.card.accountId).toBe(b.accountId);
    const { rows } = await ctx.client.query<{ opened_at: Date | null; candidate_id: string }>(
      `SELECT r.opened_at, e.candidate_id FROM rounds r JOIN round_entries e ON e.round_id = r.id
        WHERE r.account_id = $1 AND r.day = $2`,
      [a.accountId, TODAY],
    );
    expect(rows.map((row) => row.candidate_id)).toEqual([b.accountId]);
    expect(rows[0]?.opened_at).toBeInstanceOf(Date);
    // Served as a card is: the shown record, which a photo's URL stands on (ADR-008 §3).
    const shown = await ctx.client.query(
      `SELECT 1 FROM card_shown s JOIN photo p ON p.id = s.photo_id
        WHERE s.account_id = $1 AND p.account_id = $2`,
      [a.accountId, b.accountId],
    );
    expect(shown.rowCount).toBeGreaterThan(0);
    // Addressed as any card is.
    const seen = await app.request(`/rounds/${TODAY}/entries/${entry?.position}/seen`, {
      method: "POST",
      headers: a.headers,
    });
    expect(seen.status).toBe(204);
  });

  test("Opening a star again the same day gives the same place", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);

    const once = await opened(app, a, id);
    const twice = await opened(app, a, id);

    expect(twice.entries?.[0]?.position).toBe(once.entries?.[0]?.position);
    const { rows } = await ctx.client.query(
      `SELECT 1 FROM rounds r JOIN round_entries e ON e.round_id = r.id
        WHERE r.account_id = $1 AND r.day = $2 AND e.candidate_id = $3`,
      [a.accountId, TODAY, b.accountId],
    );
    expect(rows).toHaveLength(1);
  });

  test("A card starred today opens at the place it has, as it stands", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await logged(ctx.client, a.accountId, TODAY, [b.accountId]);
    const { id } = await star(app, a, 1);
    expect((await decide(app, a, TODAY, 1, "skip")).status).toBe(200);

    const answer = await opened(app, a, id);

    expect(answer.entries).toHaveLength(1);
    expect(answer.entries?.[0]).toMatchObject({
      position: 1,
      reason: "matches_filters",
      decision: "skip",
      star: id,
    });
  });

  test("A like from the list spends a like and takes the star off", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    const { entries, likesLeft } = await opened(app, a, id);

    const answer = await decide(app, a, TODAY, entries?.[0]?.position ?? 0, "like");

    expect(answer.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await answer.json()).likesLeft).toBe(likesLeft - 1);
    expect(await listOf(app, a)).toEqual([]);
    expect(await starsOf(ctx.client, a)).toEqual([]);
  });

  test("A like waiting makes a match from the list, as in the queue", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    await likedYesterday(ctx.client, b, a);

    const { entries } = await opened(app, a, id);

    expect(entries?.[0]?.reason).toBe("liked_you");
    const answer = await decide(app, a, TODAY, entries?.[0]?.position ?? 0, "like");
    expect(answer.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await answer.json()).match).not.toBeNull();
  });

  test("A fish waiting says so from the list too", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    await likedYesterday(ctx.client, b, a, true);

    expect((await opened(app, a, id)).entries?.[0]?.reason).toBe("fish");
  });

  test("A shadow-banned person's list never says a like waits", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    await likedYesterday(ctx.client, b, a);
    await setState(ctx.client, a, "shadow_banned");

    const { entries } = await opened(app, a, id);

    expect(entries?.[0]?.reason).toBe("seen_before");
    const answer = await decide(app, a, TODAY, entries?.[0]?.position ?? 0, "like");
    expect(answer.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await answer.json()).match).toBeNull();
  });

  test("A star stays while its card is opened and left, and the queue does not offer it", async ({
    ctx,
  }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);
    await opened(app, a, id);

    expect(cardsOf(await readToday(app, a))).toEqual([]);
    expect((await listOf(app, a)).map((item) => item.id)).toEqual([id]);
  });

  test("Opening a star counts as a read of cards for the alarm", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await withMatchingConfig(ctx.client, { auto_shadow_ban_cards_served: 1 });
    const id = await starredYesterday(ctx.client, a, b);

    await opened(app, a, id);

    const { rows } = await ctx.client.query<{ state: string }>(
      "SELECT state FROM account WHERE id = $1",
      [a.accountId],
    );
    expect(rows).toEqual([{ state: "shadow_banned" }]);
  });
});

describe("whose star", () => {
  test("Somebody else's star can be neither opened nor cleared", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 3);
    const [a, b, c] = [person(who, 0), person(who, 1), person(who, 2)];
    const id = await starredYesterday(ctx.client, a, b);

    expect((await open(app, c, id)).status).toBe(404);
    expect((await clear(app, c, id)).status).toBe(404);

    expect(await starsOf(ctx.client, a)).toEqual([b.accountId]);
    const log = await ctx.client.query("SELECT 1 FROM rounds WHERE account_id = $1", [c.accountId]);
    expect(log.rowCount).toBe(0);
  });

  test("A star cleared twice answers not_found the second time", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    const id = await starredYesterday(ctx.client, a, b);

    expect((await clear(app, a, id)).status).toBe(204);

    const again = await clear(app, a, id);
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe("not_found");
  });

  test("A star's id that is no id is refused", async ({ ctx }) => {
    const { app, who } = await scene(ctx, 1);
    const a = person(who, 0);
    expect((await clear(app, a, "not-a-uuid")).status).toBe(400);
    expect((await open(app, a, "not-a-uuid")).status).toBe(400);
  });

  test("Every route of the stars asks for a session", async ({ ctx }) => {
    const app = await appOn(ctx.client);
    const id = "00000000-0000-4000-8000-000000000000";
    const answers = await Promise.all([
      app.request("/stars"),
      app.request(`/rounds/${TODAY}/entries/1/star`, { method: "PUT" }),
      app.request(`/stars/${id}/open`, { method: "POST" }),
      app.request(`/stars/${id}`, { method: "DELETE" }),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(await errorCode(answer)).toBe("unauthenticated");
    }
  });
});

describe("erasure and the export", () => {
  describe("Erasure of either person takes the star", () => {
    test.for([{ erased: "A" }, { erased: "B" }])("$erased", async ({ erased }, { ctx }) => {
      const { who } = await scene(ctx, 2);
      const [a, b] = [person(who, 0), person(who, 1)];
      await starredYesterday(ctx.client, a, b);
      const { logger } = await captureLogger();

      const summary = await eraseAccount(
        { db: ctx.client, logger, now: () => NOON },
        erased === "A" ? a.accountId : b.accountId,
      );

      expect(summary.stars).toBe(1);
      expect(await starsOf(ctx.client, a)).toEqual([]);
    });
  });

  test("The export says when, and never whom", async ({ ctx }) => {
    const { who } = await scene(ctx, 2);
    const [a, b] = [person(who, 0), person(who, 1)];
    await starredYesterday(ctx.client, a, b);
    const { logger } = await captureLogger();
    const deps = { db: ctx.client, logger, now: () => NOON, version: "test" };

    const { document } = await exportAccount(deps, a.accountId, englishT);
    const theirs = await exportAccount(deps, b.accountId, englishT);

    expect(document.stars.about).toMatch(/is not written here/);
    expect(document.stars.items).toEqual([{ at: YESTERDAY_NOON.toISOString() }]);
    expect(JSON.stringify(document.stars)).not.toContain(b.accountId);
    expect(theirs.document.stars.items).toEqual([]);
  });
});
