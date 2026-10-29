import type { Queryable } from "@kuutti/db";
import { ErrorResponse, RoundDecisionAnswer, RoundResponse } from "@kuutti/schema";
import { type App, createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { signInAs } from "../test/account.ts";
import { captureLogger, describe, expect, test, testConfig } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { exportRounds, saveRound } from "./rounds.ts";

// The fish (#378, ADR-039, features/matching/fish.feature): its budget in a
// rolling window and the wait a refusal names, given back the same day, a
// like for the day's likes and the match, a like on a card that answers one,
// the event, and what the sender and the export read. Its place in the other
// person's round is jobs/round-builder.test.ts.

/** 12:00 in Finland, one Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = finnishDay(T);

type Person = { accountId: string; headers: { authorization: string } };

const daysBefore = (days: number) => new Date(T.getTime() - days * DAY_MS);

async function appAt(db: Queryable, at: Date = T): Promise<App> {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db, now: () => at });
}

async function cast(db: Queryable, count: number): Promise<Person[]> {
  const ids = await people(db, null, count, { complete: true, consented: true });
  return Promise.all(ids.map((id) => signInAs(db, id)));
}

/** A round for `owner` `days` before today with these cards, each of the reason given or matching every filter. */
async function roundOf(
  db: Queryable,
  owner: Person,
  cards: (Person | { person: Person; reason: "liked_you" | "fish" })[],
  days = 0,
) {
  const at = daysBefore(days);
  const built = await saveRound(
    { db, logger: (await captureLogger()).logger, now: () => at },
    {
      accountId: owner.accountId,
      day: finnishDay(at),
      ordering: "count",
      entries: cards.map((card) =>
        "person" in card
          ? { candidateId: card.person.accountId, reason: card.reason }
          : { candidateId: card.accountId, reason: "matches_filters" as const },
      ),
    },
  );
  if (!built) throw new Error("round not built");
  return built.roundId;
}

/** `sender` sent `to` a fish, or a like, on a round of `days` before today. */
async function sentBefore(db: Queryable, sender: Person, to: Person, days: number, fish: boolean) {
  const roundId = await roundOf(db, sender, [to], days);
  await db.query(
    "UPDATE round_entries SET decision = 'like', decided_at = $2, fish = $3 WHERE round_id = $1",
    [roundId, daysBefore(days), fish],
  );
}

const choose = (app: App, who: Person, position: number, decision: string) =>
  app.request(`/rounds/${TODAY}/entries/${position}/decision`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });

async function codeOf(response: Response) {
  return ErrorResponse.parse(await response.json()).error.code;
}

async function entriesOf(db: Queryable, roundId: string) {
  return (
    await db.query<{ decision: string | null; fish: boolean }>(
      "SELECT decision, fish FROM round_entries WHERE round_id = $1 ORDER BY position",
      [roundId],
    )
  ).rows;
}

/** What today's round says of the caller's fish (#475). */
async function fishToSendOn(app: App, who: Person) {
  const read = await app.request("/rounds/today", { headers: who.headers });
  expect(read.status).toBe(200);
  return RoundResponse.parse(await read.json()).fishToSend;
}

/** What a decision's answer says of the caller's fish after it (#475). */
async function fishToSendAfter(answer: Response) {
  expect(answer.status).toBe(200);
  return RoundDecisionAnswer.parse(await answer.json()).fishToSend;
}

async function setConfig(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO matching_config (version, key, value, created_by)
     SELECT coalesce(max(version), 0) + 1, $1, $2::jsonb, 'test' FROM matching_config WHERE key = $1`,
    [key, JSON.stringify(value)],
  );
}

describe("the fish", () => {
  test("a fish is recorded as a like with its mark, and read back as a fish", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);

    expect(await entriesOf(ctx.client, roundId)).toEqual([{ decision: "like", fish: true }]);
    const read = RoundResponse.parse(
      await (await app.request("/rounds/today", { headers: a.headers })).json(),
    );
    expect(read.entries?.map((entry) => entry.decision)).toEqual(["fish"]);
    // The export reads it back too, in its own word.
    const [round] = await exportRounds(ctx.client, a.accountId, 10);
    expect(round?.entries.map((entry) => entry.decision)).toEqual(["fish"]);
  });

  test("A second fish the same day is refused until midnight, and nothing is written", async ({
    ctx,
  }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const roundId = await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);

    const refused = await choose(app, a, 2, "fish");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("fish_budget_exceeded");
    // Today's fish leaves the window of a day at the next midnight in Helsinki, twelve hours on.
    expect(Number(refused.headers.get("retry-after"))).toBe(12 * 3600);
    expect(await entriesOf(ctx.client, roundId)).toEqual([
      { decision: "like", fish: true },
      { decision: null, fish: false },
    ]);
  });

  test("Yesterday's fish has left the window, and today's goes", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await sentBefore(ctx.client, a, b, 1, true);
    await roundOf(ctx.client, a, [c]);
    expect((await choose(await appAt(ctx.client), a, 1, "fish")).status).toBe(200);
  });

  test("a window of seven days counts a fish of three days ago, and names the midnight it leaves", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "fish_window_days", 7);
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await sentBefore(ctx.client, a, b, 3, true);
    const roundId = await roundOf(ctx.client, a, [c]);
    const app = await appAt(ctx.client);

    expect(await fishToSendOn(app, a)).toBe(false);
    const refused = await choose(app, a, 1, "fish");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("fish_budget_exceeded");
    // The fish of three days ago leaves the window at the midnight that begins
    // the fourth day from now: 2026-10-20 00:00 in Helsinki, 21:00 UTC the day before.
    const back = new Date("2026-10-19T21:00:00.000Z");
    expect(Number(refused.headers.get("retry-after"))).toBe((back.getTime() - T.getTime()) / 1000);
    expect(await entriesOf(ctx.client, roundId)).toEqual([{ decision: null, fish: false }]);
  });

  test("a fish of seven days ago has left a window of seven, and the next goes", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "fish_window_days", 7);
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await sentBefore(ctx.client, a, b, 7, true);
    await roundOf(ctx.client, a, [c]);
    const app = await appAt(ctx.client);
    expect(await fishToSendOn(app, a)).toBe(true);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);
  });

  test("the refusal is said in the request's language, and with no budget at all it waits for the day", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "fish_budget", 0);
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    const refused = await (await appAt(ctx.client)).request(`/rounds/${TODAY}/entries/1/decision`, {
      method: "PUT",
      headers: { ...a.headers, "content-type": "application/json", "accept-language": "sv" },
      body: JSON.stringify({ decision: "fish" }),
    });
    expect(refused.status).toBe(429);
    expect(ErrorResponse.parse(await refused.json()).error.message).toBe(
      "Du kan inte skicka en fisk just nu. Du kan fortfarande gilla.",
    );
    expect(Number(refused.headers.get("retry-after"))).toBe(12 * 3600);
  });

  test("A fish changed to a like or a pass the same day is given back", async ({ ctx }) => {
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    const roundId = await roundOf(ctx.client, a, [b, c, d]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect((await choose(app, a, 2, "fish")).status).toBe(429);
    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "fish")).status).toBe(200);
    expect((await choose(app, a, 2, "pass")).status).toBe(200);
    expect((await choose(app, a, 3, "fish")).status).toBe(200);

    expect(await entriesOf(ctx.client, roundId)).toEqual([
      { decision: "like", fish: false },
      { decision: "pass", fish: false },
      { decision: "like", fish: true },
    ]);
  });

  test("the same fish again writes nothing and is never refused", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);
  });

  test("A fish counts against the day's like budget", async ({ ctx }) => {
    await setConfig(ctx.client, "like_budget_balanced", 1);
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);

    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    const refused = await choose(app, a, 2, "like");

    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("like_budget_exceeded");
  });

  test("a like made a fish was counted already, and spends a fish but no other like", async ({
    ctx,
  }) => {
    await setConfig(ctx.client, "like_budget_balanced", 1);
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const roundId = await roundOf(ctx.client, a, [b]);
    const app = await appAt(ctx.client);
    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 1, "fish")).status).toBe(200);
    expect(await entriesOf(ctx.client, roundId)).toEqual([{ decision: "like", fish: true }]);
  });

  test("A fish on a card of somebody whose like waits is a like", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await sentBefore(ctx.client, b, a, 1, false);
    const roundId = await roundOf(ctx.client, a, [{ person: b, reason: "liked_you" }, c]);
    const app = await appAt(ctx.client);

    const answer = await choose(app, a, 1, "fish");

    expect(answer.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await answer.json()).match).not.toBeNull();
    // No fish spent: the next goes.
    expect((await choose(app, a, 2, "fish")).status).toBe(200);
    expect(await entriesOf(ctx.client, roundId)).toEqual([
      { decision: "like", fish: false },
      { decision: "like", fish: true },
    ]);
  });

  test("a like back on a fish card is free, and a fish there is a like", async ({ ctx }) => {
    await setConfig(ctx.client, "like_budget_balanced", 1);
    const [a, b, c, d] = await cast(ctx.client, 4);
    if (!a || !b || !c || !d) throw new Error("cast not written");
    await sentBefore(ctx.client, b, a, 1, true);
    await sentBefore(ctx.client, c, a, 1, true);
    const roundId = await roundOf(ctx.client, a, [
      { person: b, reason: "fish" },
      { person: c, reason: "fish" },
      d,
    ]);
    const app = await appAt(ctx.client);

    // The day's one like on an ordinary card, then a like and a fish back on the fish cards.
    expect((await choose(app, a, 3, "like")).status).toBe(200);
    expect((await choose(app, a, 1, "like")).status).toBe(200);
    expect((await choose(app, a, 2, "fish")).status).toBe(200);

    expect(await entriesOf(ctx.client, roundId)).toEqual([
      { decision: "like", fish: false },
      { decision: "like", fish: false },
      { decision: "like", fish: false },
    ]);
  });

  test("a fish meeting the other's like is a match, as any like", async ({ ctx }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await sentBefore(ctx.client, b, a, 2, false);
    await roundOf(ctx.client, a, [b]);
    const answer = await choose(await appAt(ctx.client), a, 1, "fish");
    expect(RoundDecisionAnswer.parse(await answer.json()).match).not.toBeNull();
  });

  test("a fish is a like event that says it was a fish", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    const consent = await (await appAt(ctx.client, new Date(T.getTime() - 60_000))).request(
      "/consents",
      {
        method: "POST",
        headers: { ...a.headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "research",
          version: CURRENT_CONSENT_VERSIONS.research,
          locale: "fi",
        }),
      },
    );
    expect(consent.status).toBe(200);
    await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);
    await choose(app, a, 1, "fish");
    await choose(app, a, 2, "like");

    const { rows } = await ctx.client.query<{ props: { position: number; fish: boolean } }>(
      "SELECT props FROM events WHERE name = 'like' ORDER BY (props->>'position')::int",
    );
    expect(rows.map((row) => [row.props.position, row.props.fish])).toEqual([
      [1, true],
      [2, false],
    ]);
  });
});

describe("whether a fish can go today (#475)", () => {
  test("A round read after the day's fish offers no other fish today", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    await roundOf(ctx.client, a, [b, c]);
    const app = await appAt(ctx.client);
    expect(await fishToSendOn(app, a)).toBe(true);

    expect(await fishToSendAfter(await choose(app, a, 1, "fish"))).toBe(false);

    expect(await fishToSendOn(app, a)).toBe(false);
    // A like on the next card leaves it so, and the same fish again changes nothing.
    expect(await fishToSendAfter(await choose(app, a, 2, "like"))).toBe(false);
    expect(await fishToSendAfter(await choose(app, a, 1, "fish"))).toBe(false);
  });

  test.for([
    ["a like", "like"],
    ["a pass", "pass"],
  ] as const)(
    "a fish changed to %s gives it back, and the answer says so",
    async ([, decision], { ctx }) => {
      const [a, b] = await cast(ctx.client, 2);
      if (!a || !b) throw new Error("cast not written");
      await roundOf(ctx.client, a, [b]);
      const app = await appAt(ctx.client);
      expect(await fishToSendAfter(await choose(app, a, 1, "fish"))).toBe(false);

      expect(await fishToSendAfter(await choose(app, a, 1, decision))).toBe(true);
      expect(await fishToSendOn(app, a)).toBe(true);
    },
  );

  test("a fish on a liked-you card is a like and leaves the day's fish to send", async ({
    ctx,
  }) => {
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    await sentBefore(ctx.client, b, a, 1, false);
    await roundOf(ctx.client, a, [{ person: b, reason: "liked_you" }]);
    const app = await appAt(ctx.client);
    expect(await fishToSendAfter(await choose(app, a, 1, "fish"))).toBe(true);
  });

  test("with fish switched off none can go, whether or not a round is built", async ({ ctx }) => {
    await setConfig(ctx.client, "fish_budget", 0);
    const [a, b] = await cast(ctx.client, 2);
    if (!a || !b) throw new Error("cast not written");
    const app = await appAt(ctx.client);
    // No round yet, and matching not open: nothing builds one.
    const unbuilt = RoundResponse.parse(
      await (await app.request("/rounds/today", { headers: a.headers })).json(),
    );
    expect(unbuilt).toMatchObject({ entries: null, fishToSend: false });
    await roundOf(ctx.client, a, [b]);
    expect(await fishToSendOn(app, a)).toBe(false);
    expect(await fishToSendAfter(await choose(app, a, 1, "like"))).toBe(false);
  });

  test("says only the caller's own: a fish another sent them changes nothing", async ({ ctx }) => {
    const [a, b, c] = await cast(ctx.client, 3);
    if (!a || !b || !c) throw new Error("cast not written");
    // "B"'s fish of today waits on "A", in "A"'s round as a fish.
    await sentBefore(ctx.client, b, a, 0, true);
    await roundOf(ctx.client, a, [{ person: b, reason: "fish" }, c]);
    const app = await appAt(ctx.client);
    expect(await fishToSendOn(app, a)).toBe(true);
    expect(await fishToSendOn(app, b)).toBe(false);
  });
});
