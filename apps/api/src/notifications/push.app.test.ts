import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { ChatMessage, RoundDecisionAnswer } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect } from "vitest";
import { type App, createApp } from "../app.ts";
import { createLive, type Live } from "../chat/index.ts";
import { eraseAccount } from "../identity/index.ts";
import { finnishDay } from "../lib/finnish-day.ts";
import { PushFailed } from "../lib/push.ts";
import { saveRound } from "../matching/index.ts";
import { applySanction } from "../safety/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween } from "../test/chat.ts";
import {
  captureLogger,
  type LogLine,
  type TestContext,
  test,
  testConfig,
} from "../test/harness.ts";
import { fixtureJpeg, testMediaDeps } from "../test/media.ts";
import { people } from "../test/people.ts";
import {
  expectNamesNothing,
  gate,
  heldSchedule,
  type MemoryPusher,
  memoryPusher,
  type Withheld,
} from "../test/push.ts";
import { createPush } from "./push.ts";

// The push through the routes (#102, ADR-055 §4, §5,
// features/notifications/push.feature): a message sent over HTTP tells its
// reader who has no socket, by the chat's own rule of who may read it, read
// after the send has answered; a like that makes a match tells the earlier
// liker. The app is the real one, handed a push over a memory pusher, a live
// registry the test puts sockets in, a held schedule for the receipts and a
// clock the test moves; a test waits for the push with `settled`.

/** 12:00 in Helsinki, a Friday in summer time (UTC+3). */
const T = new Date("2026-10-16T09:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** At T a push may wait ten hours for its phone: the quiet hours begin at 22:00. */
const TTL_AT_T = 10 * 60 * 60;

type Person = { accountId: string; name: string; headers: { authorization: string } };

/** Every push a test's app recorded, held to the payload rule once the test is done (ADR-055 §1). */
const recorded: Array<{
  pusher: MemoryPusher;
  settled: () => Promise<void>;
  withheld: () => Promise<Withheld>;
}> = [];
afterEach(async () => {
  for (const { pusher, settled, withheld } of recorded.splice(0)) {
    await settled();
    expectNamesNothing(pusher.sent(), await withheld());
  }
});

let tokens = 0;

/**
 * The app with a push of its own over a memory pusher, a live registry, a
 * held schedule, a clock and the photo pipeline; the people its pushes must
 * not name, their words, every account and session id of the test, and
 * every conversation.
 */
async function appWith(ctx: TestContext, options: { db?: Queryable } = {}) {
  const { logger, lines } = await captureLogger();
  const pusher = memoryPusher();
  const live: Live = createLive({ db: ctx.client, logger, socketsPerAccount: 3 });
  const clock = { at: T };
  const schedule = heldSchedule();
  const db = options.db ?? ctx.client;
  await withMatchingConfig(ctx.client, { message_photos_per_day: 3 });
  // The push app.ts would make, handed in as boot hands in its own, so the test can wait for it.
  const push = createPush({
    db,
    logger,
    now: () => clock.at,
    pusher,
    online: (accountId) => live.online(accountId),
    schedule: schedule.schedule,
  });
  const app = createApp({
    config: testConfig(),
    logger,
    db,
    now: () => clock.at,
    pusher,
    push,
    live,
    media: testMediaDeps().deps,
  });
  const names: string[] = [];
  const texts: string[] = [];
  const settled = () => push.settled();
  recorded.push({
    pusher,
    settled,
    withheld: async () => {
      const { rows } = await ctx.client.query<{ id: string }>(
        "SELECT id FROM account UNION ALL SELECT id FROM session",
      );
      const conversations = await ctx.client.query<{ id: string }>("SELECT id FROM conversation");
      return {
        names,
        texts,
        ids: rows.map((row) => row.id),
        conversations: conversations.rows.map((row) => row.id),
      };
    },
  });

  /** A signed-in person with a complete profile and a name of their own. */
  async function person(name: string): Promise<Person> {
    const [accountId] = await people(ctx.client, null, 1, { complete: true, consented: true });
    if (!accountId) throw new Error("no person");
    await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
      accountId,
      name,
    ]);
    names.push(name);
    return { accountId, name, headers: (await signInAs(ctx.client, accountId)).headers };
  }

  /**
   * The caller's phone registers its token through the route, in its
   * language; another device of theirs signs in first, as a session is a device.
   */
  async function register(who: Person, language = "en", device: "this" | "another" = "this") {
    tokens += 1;
    const token = `ExponentPushToken[app-${process.pid}-${tokens}]`;
    const headers =
      device === "this" ? who.headers : (await signInAs(ctx.client, who.accountId)).headers;
    const answer = await app.request("/push-token", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json", "accept-language": language },
      body: JSON.stringify({ token, platform: "ios" }),
    });
    expect(answer.status).toBe(204);
    return token;
  }

  /** A message sent through the route, answered; the push it starts may still be running. */
  const post = (who: Person, id: string, body: string, clientId: string = randomUUID()) => {
    texts.push(body);
    return app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId, body }),
    });
  };

  /** A message sent, and the push it started settled. */
  const send = async (who: Person, id: string, body: string, clientId: string = randomUUID()) => {
    const answer = await post(who, id, body, clientId);
    await settled();
    return answer;
  };

  /** A phone of `who` with the app in front: a live socket in the registry. */
  function inTheApp(who: Person) {
    const socket = {
      accountId: who.accountId,
      sessionId: randomUUID(),
      hidden: false,
      send: () => {},
      close: () => {},
    };
    live.presence.add(socket);
    return () => live.presence.remove(socket);
  }

  return {
    app,
    pusher,
    live,
    clock,
    schedule,
    settled,
    logs: lines,
    person,
    register,
    post,
    send,
    inTheApp,
    texts,
  };
}

/** A database that does `land` once, just before the first statement `when` picks: a request that commits there. */
function landingBefore(
  db: Queryable,
  when: (text: string, values?: unknown[]) => boolean,
  land: () => Promise<unknown>,
): Queryable & { landed: () => boolean } {
  let started = false;
  // Landed means `land` finished: an expectation that failed inside it, in
  // the push's own background, would otherwise be only a logged failure.
  let landed = false;
  return {
    landed: () => landed,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      if (!started && when(text, values)) {
        started = true;
        await land();
        landed = true;
      }
      return db.query<R>(text, values);
    },
  };
}

/** The push's first read after a send has committed: its interval. */
const thePushReads = (_: string, values?: unknown[]) =>
  values?.[0] === "message_push_min_interval_minutes";

const lineOf = (lines: LogLine[], msg: string) => lines.filter((line) => line.msg === msg);

describe("a message's push through the routes (ADR-055 §4)", () => {
  test("A message to somebody in the app sends no push", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const token = await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const leave = s.inTheApp(b);
    expect((await s.send(a, id, "Näetkö tämän heti?")).status).toBe(201);
    expect(s.pusher.sent()).toEqual([]);
    // Out of the app, the next message pushes: the socket's message took nothing from the interval.
    leave();
    s.clock.at = new Date(T.getTime() + MINUTE);
    expect((await s.send(a, id, "Entä nyt?")).status).toBe(201);
    expect(s.pusher.sent().map((m) => m.to)).toEqual([token]);
  });

  test("A message to somebody away pushes once however many follow within the interval", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const token = await s.register(b, "fi");
    await s.register(a);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    for (const [minutes, body] of [
      [0, "Hei!"],
      [1, "Mitä kuuluu?"],
      [9, "Oletko kotona?"],
    ] as const) {
      s.clock.at = new Date(T.getTime() + minutes * MINUTE);
      expect((await s.send(a, id, body)).status).toBe(201);
    }
    expect(s.pusher.sent()).toStrictEqual([
      {
        to: token,
        body: "Sinulle on uusi viesti",
        data: { kind: "message" },
        collapseId: "message",
        tag: "message",
        channelId: "default",
        priority: "high",
        sound: "default",
        ttl: TTL_AT_T,
      },
    ]);
    s.clock.at = new Date(T.getTime() + 10 * MINUTE);
    expect((await s.send(a, id, "Soitan illalla.")).status).toBe(201);
    expect(s.pusher.sent().map((m) => m.to)).toEqual([token, token]);
  });

  test("a resend of a message already stored pushes nothing more", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const clientId = randomUUID();
    expect((await s.send(a, id, "Vain kerran", clientId)).status).toBe(201);
    // After the interval, so only the resend's rule can hold it back.
    s.clock.at = new Date(T.getTime() + 11 * MINUTE);
    expect((await s.send(a, id, "Vain kerran", clientId)).status).toBe(200);
    expect(s.pusher.sent()).toHaveLength(1);
  });

  test("a photo in a message pushes as a message does, its caption nowhere in it", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const token = await s.register(b, "sv");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const form = new FormData();
    const bytes = await fixtureJpeg();
    form.append(
      "photo",
      new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "image/jpeg" }),
      "photo.jpg",
    );
    form.append("clientId", randomUUID());
    form.append("caption", "Järvellä Ilmattaren kanssa");
    s.texts.push("Järvellä Ilmattaren kanssa");
    const answer = await s.app.request(`/conversations/${id}/photos`, {
      method: "POST",
      headers: a.headers,
      body: form,
    });
    expect(answer.status).toBe(201);
    expect(ChatMessage.parse(await answer.json()).kind).toBe("photo");
    await s.settled();
    expect(s.pusher.sent().map((m) => [m.to, m.body, m.data])).toEqual([
      [token, "Du har ett nytt meddelande", { kind: "message" }],
    ]);
  });

  test("A push says that there is a message, never its text, its sender or an account", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const fi = await s.register(b, "fi");
    const en = await s.register(b, "en", "another");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const text = "Ilmatar täällä, tavataanko Kauppatorilla kello viisi?";
    expect((await s.send(a, id, text)).status).toBe(201);
    const sent = s.pusher.sent();
    // Both of B's devices are told, each in its own language. They register at
    // the app's one moment, so which is told first is the database's to choose;
    // the order by registration is push.test.ts's to hold.
    expect(new Map(sent.map(({ to, ...payload }) => [to, payload]))).toEqual(
      new Map([
        [
          fi,
          expect.objectContaining({ body: "Sinulle on uusi viesti", data: { kind: "message" } }),
        ],
        [
          en,
          expect.objectContaining({ body: "You have a new message", data: { kind: "message" } }),
        ],
      ]),
    );
    const { rows } = await ctx.client.query<{ id: string }>(
      "SELECT id FROM session WHERE account_id = ANY($1::uuid[])",
      [[a.accountId, b.accountId]],
    );
    // What Expo, Apple and Google get past the address: the app's words and the kind alone.
    expect(
      expectNamesNothing(sent, {
        texts: [text, "Kauppatori"],
        names: [a.name, b.name],
        ids: [a.accountId, b.accountId, ...rows.map((row) => row.id)],
        conversations: [id],
      }),
    ).toBe(2);
    // Nor does any log line carry the text or a token.
    const raw = JSON.stringify(s.logs());
    for (const secret of [text, fi, en]) expect(raw).not.toContain(secret);
  });

  test("Nothing is pushed across a block or a close", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const c = await s.person("Joukahainen");
    const d = await s.person("Aino");
    await s.register(a);
    await s.register(b);
    await s.register(c);
    await s.register(d);
    const block = async (blocker: Person, blocked: Person) => {
      await cardShown(ctx.client, blocker.accountId, blocked.accountId);
      const answer = await ctx.app.request("/blocks", {
        method: "POST",
        headers: { ...blocker.headers, "content-type": "application/json" },
        body: JSON.stringify({ accountId: blocked.accountId }),
      });
      expect(answer.status).toBe(204);
    };
    // B blocked A; C was blocked by A; D unmatched A: none of them may be written to.
    const ab = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const ac = await conversationBetween(ctx.client, a.accountId, c.accountId);
    const ad = await conversationBetween(ctx.client, a.accountId, d.accountId);
    await block(b, a);
    await block(a, c);
    const unmatched = await s.app.request(`/conversations/${ad}/unmatch`, {
      method: "POST",
      headers: d.headers,
    });
    expect(unmatched.status).toBe(204);
    for (const [id, other] of [
      [ab, b],
      [ac, c],
      [ad, d],
    ] as const) {
      expect((await s.send(a, id, "Kuuletko?")).status).not.toBe(201);
      expect((await s.send(other, id, "Entä sinä?")).status).not.toBe(201);
    }
    expect(s.pusher.sent()).toEqual([]);
  });

  test("a block or a close that lands between the send and the push's read pushes nobody", async ({
    ctx,
  }) => {
    for (const ending of ["the reader blocks", "the sender blocks", "an unmatch"] as const) {
      const people_ = await appWith(ctx);
      const a = await people_.person("Ilmatar");
      const b = await people_.person("Väinämöinen");
      await people_.register(b);
      const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
      const [blocker, blocked] = ending === "the reader blocks" ? [b, a] : [a, b];
      const racing = landingBefore(ctx.client, thePushReads, async () => {
        if (ending === "an unmatch") {
          const answer = await ctx.app.request(`/conversations/${id}/unmatch`, {
            method: "POST",
            headers: b.headers,
          });
          expect(answer.status).toBe(204);
          return;
        }
        await cardShown(ctx.client, blocker.accountId, blocked.accountId);
        const answer = await ctx.app.request("/blocks", {
          method: "POST",
          headers: { ...blocker.headers, "content-type": "application/json" },
          body: JSON.stringify({ accountId: blocked.accountId }),
        });
        expect(answer.status).toBe(204);
      });
      const s = await appWith(ctx, { db: racing });
      // The same people, through the racing app's own sessions.
      expect((await s.send(a, id, "Ehditkö lukea?")).status, ending).toBe(201);
      expect(racing.landed(), ending).toBe(true);
      expect(s.pusher.sent(), ending).toEqual([]);
    }
  });

  test("A shadow-banned sender's message pushes nobody", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const toA = await s.register(a);
    await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "harassment",
      note: "Kept writing after a no.",
      actor: null,
      at: new Date(T.getTime() - DAY),
    });
    // A sees the message sent; B is never told of it.
    expect((await s.send(a, id, "Miksi et vastaa?")).status).toBe(201);
    expect(s.pusher.sent()).toEqual([]);
    // The shadow-banned person notices nothing: B's message to them pushes as any would.
    expect((await s.send(b, id, "Hei!")).status).toBe(201);
    expect(s.pusher.sent().map((m) => m.to)).toEqual([toA]);
  });

  test("an erased reader is pushed nothing, and an erasure that lands between the send and the push's read neither", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const c = await s.person("Joukahainen");
    await s.register(b);
    await s.register(c);
    const ab = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const ac = await conversationBetween(ctx.client, a.accountId, c.accountId);
    const { logger } = await captureLogger();
    await eraseAccount({ db: ctx.client, logger, now: () => T }, b.accountId);
    expect((await s.send(a, ab, "Oletko vielä täällä?")).status).not.toBe(201);
    // C erased after A's message committed and before the push read who may read it.
    const racing = landingBefore(ctx.client, thePushReads, () =>
      eraseAccount({ db: ctx.client, logger, now: () => T }, c.accountId),
    );
    const late = await appWith(ctx, { db: racing });
    expect((await late.send(a, ac, "Ehditkö?")).status).toBe(201);
    expect(racing.landed()).toBe(true);
    expect([...s.pusher.sent(), ...late.pusher.sent()]).toEqual([]);
  });

  test("an app given no clock pushes by the wall clock", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const token = await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // No quiet hours, so whatever hour the wall clock says, the push goes.
    await withMatchingConfig(ctx.client, { push_quiet_from_hour: 5, push_quiet_to_hour: 5 });
    const { logger } = await captureLogger();
    const pusher = memoryPusher();
    const reached = gate();
    pusher.reached = reached.open;
    // No push handed in either: the app makes its own over the pusher.
    const app = createApp({ config: testConfig(), logger, db: ctx.client, pusher });
    const answer = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId: randomUUID(), body: "Kello on mitä on." }),
    });
    expect(answer.status).toBe(201);
    // The app's own push cannot be waited for: its send to Expo is what is seen.
    await reached.promise;
    expect(pusher.sent().map((m) => m.to)).toEqual([token]);
  });

  test("the send answers as it would however the push fails", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    s.pusher.failure = new PushFailed("TOO_MANY_REQUESTS", 429);
    const first = await s.send(a, id, "Yksi");
    expect(first.status).toBe(201);
    expect(ChatMessage.parse(await first.json())).toMatchObject({ seq: 1, side: "mine" });
    s.pusher.failure = new Error("the pusher is broken");
    s.clock.at = new Date(T.getTime() + MINUTE);
    expect((await s.send(a, id, "Kaksi")).status).toBe(201);
    // A parameter gone: the push fails before it sends, and the message still goes.
    await ctx.client.query("DELETE FROM matching_config WHERE key = 'push_quiet_from_hour'");
    s.pusher.failure = undefined;
    s.clock.at = new Date(T.getTime() + 2 * MINUTE);
    expect((await s.send(a, id, "Kolme")).status).toBe(201);
    const { rows } = await ctx.client.query("SELECT seq FROM message WHERE conversation_id = $1", [
      id,
    ]);
    expect(rows).toHaveLength(3);
    expect(lineOf(s.logs(), "push not sent")).toHaveLength(2);
    expect(lineOf(s.logs(), "push failed")).toHaveLength(1);
  });

  test("the send answers before Expo does, and the push goes once Expo answers", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const token = await s.register(b);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const expo = gate();
    const reached = gate();
    s.pusher.gate = expo.promise;
    s.pusher.reached = reached.open;
    // Expo holds the push: the answer comes back all the same, with the message.
    const answer = await s.post(a, id, "Ehditkö jo?");
    expect(answer.status).toBe(201);
    expect(ChatMessage.parse(await answer.json())).toMatchObject({ seq: 1, side: "mine" });
    await reached.promise;
    expect(s.pusher.sent().map((m) => m.to)).toEqual([token]);
    // Not taken yet: nothing waits for a receipt.
    expect(s.schedule.tasks).toEqual([]);
    expo.open();
    await s.settled();
    expect(s.schedule.tasks).toHaveLength(1);
    expect(s.pusher.batches).toHaveLength(1);
  });
});

describe("a match's push through the routes (ADR-055 §5)", () => {
  const TODAY = finnishDay(T);

  async function roundOf(ctx: TestContext, owner: Person, cards: Person[], days = 0) {
    const at = new Date(T.getTime() - days * DAY);
    const built = await saveRound(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => at },
      {
        accountId: owner.accountId,
        day: finnishDay(at),
        ordering: "count",
        entries: cards.map((card) => ({ candidateId: card.accountId, reason: "matches_filters" })),
      },
    );
    if (!built) throw new Error("round not built");
    return built.roundId;
  }

  /** A decision through the route, answered; the push it starts may still be running. */
  const decideBy = (app: App, who: Person, position: number, decision: string) =>
    app.request(`/rounds/${TODAY}/entries/${position}/decision`, {
      method: "PUT",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });

  /** B liked A yesterday, and today A's round shows B. */
  async function likedYesterday(ctx: TestContext, a: Person, b: Person) {
    const yesterday = await roundOf(ctx, b, [a], 1);
    await ctx.client.query(
      "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
      [yesterday, new Date(T.getTime() - DAY)],
    );
    await roundOf(ctx, a, [b]);
  }

  test("A match tells the one who liked first, in the app or not", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const toA = await s.register(a);
    const toB = await s.register(b, "fi");
    // B liked A yesterday; today A's round shows B, and A likes back.
    await likedYesterday(ctx, a, b);
    // B is in the app: no frame tells of a match, so the push goes all the same.
    s.inTheApp(b);
    const answer = await decideBy(s.app, a, 1, "like");
    expect(answer.status).toBe(200);
    const match = RoundDecisionAnswer.parse(await answer.json()).match;
    if (!match) throw new Error("no match");
    await s.settled();
    // That there is a match, and nothing of which or whose.
    expect(s.pusher.sent()).toStrictEqual([
      {
        to: toB,
        body: "Sinulle on uusi mätsi",
        data: { kind: "match" },
        collapseId: "match",
        tag: "match",
        channelId: "default",
        priority: "high",
        sound: "default",
        ttl: TTL_AT_T,
      },
    ]);
    expect(JSON.stringify(s.pusher.sent())).not.toContain(match.conversationId);
    expect(s.pusher.sent().map((m) => m.to)).not.toContain(toA);
    // The same like again makes nothing new, and tells nobody again.
    expect((await decideBy(s.app, a, 1, "like")).status).toBe(200);
    await s.settled();
    expect(s.pusher.sent()).toHaveLength(1);
  });

  test("a like that meets no like, or a pass, tells nobody", async ({ ctx }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const c = await s.person("Joukahainen");
    await s.register(b);
    await s.register(c);
    const yesterday = await roundOf(ctx, c, [a], 1);
    await ctx.client.query(
      "UPDATE round_entries SET decision = 'like', decided_at = $2 WHERE round_id = $1",
      [yesterday, new Date(T.getTime() - DAY)],
    );
    await roundOf(ctx, a, [b, c]);
    expect((await decideBy(s.app, a, 1, "like")).status).toBe(200);
    expect((await decideBy(s.app, a, 2, "pass")).status).toBe(200);
    await s.settled();
    expect(s.pusher.sent()).toEqual([]);
  });

  test("the like that makes a match answers before Expo does, and the push goes once Expo answers", async ({
    ctx,
  }) => {
    const s = await appWith(ctx);
    const a = await s.person("Ilmatar");
    const b = await s.person("Väinämöinen");
    const toB = await s.register(b);
    await likedYesterday(ctx, a, b);
    const expo = gate();
    const reached = gate();
    s.pusher.gate = expo.promise;
    s.pusher.reached = reached.open;
    // Expo holds the push: the answer comes back all the same, with the match.
    const answer = await decideBy(s.app, a, 1, "like");
    expect(answer.status).toBe(200);
    expect(RoundDecisionAnswer.parse(await answer.json()).match).not.toBeNull();
    await reached.promise;
    expect(s.pusher.sent().map((m) => m.to)).toEqual([toB]);
    expect(s.schedule.tasks).toEqual([]);
    expo.open();
    await s.settled();
    expect(s.schedule.tasks).toHaveLength(1);
    expect(s.pusher.batches).toHaveLength(1);
  });
});
