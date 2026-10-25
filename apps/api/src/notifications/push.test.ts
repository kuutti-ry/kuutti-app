import { randomUUID } from "node:crypto";
import type { PushData } from "@kuutti/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageReaders } from "../chat/index.ts";
import { MIXED_PROJECTS, PushFailed, type PushMessage } from "../lib/push.ts";
import { withMatchingConfig } from "../test/account.ts";
import { conversationBetween } from "../test/chat.ts";
import { captureLogger, type LogLine, type TestContext, test } from "../test/harness.ts";
import { people } from "../test/people.ts";
import {
  deviceOf,
  expectNamesNothing,
  gate,
  heldSchedule,
  type MemoryPusher,
  memoryPusher,
  payloadBreaches,
  tokensLeft,
  type Withheld,
} from "../test/push.ts";
import { recorder } from "../test/recorder.ts";
import {
  createPush,
  inQuietHours,
  MESSAGE_PUSH_INTERVAL_KEY,
  type Push,
  QUIET_FROM_KEY,
  QUIET_TO_KEY,
  RECEIPT_DELAY_MS,
  REQUEST_SPACING_MS,
} from "./push.ts";

// The push's decisions (#102, ADR-055 §1, §4-§8): whom a message, a match
// and the day's round tell, in which words, when not, how long a push may
// wait for its phone, and what a ticket or a receipt does to a token. On the
// real database in the harness's rolled-back transaction, a memory pusher
// for Expo, a held schedule for the receipts' timer, a recorded pause between
// requests, and a clock the test moves. A message's and a match's push run
// after their caller, so a scene waits for them with `settled`. Every push a
// scene records is held to the payload rule (§1) after its test.

/** 12:00 in Helsinki, a Friday in summer time (UTC+3). */
const T = new Date("2026-10-16T09:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Helsinki's wall clock on T's day, summer time: `hh:mm:ss` there. */
const helsinki = (time: string) => new Date(`2026-10-16T${time}+03:00`);
/** At T a push may wait ten hours for its phone: the quiet hours begin at 22:00. */
const TTL_AT_T = 10 * 60 * 60;

const LINES = {
  message: {
    en: "You have a new message",
    fi: "Sinulle on uusi viesti",
    sv: "Du har ett nytt meddelande",
  },
  match: { en: "You have a new match", fi: "Sinulle on uusi mätsi", sv: "Du har en ny matchning" },
  round: {
    en: "Today's round is ready",
    fi: "Päivän kierros on valmis",
    sv: "Dagens omgång är klar",
  },
} as const;

/** What each scene recorded, checked against the payload rule once its test is done. */
const recorded: Array<{ pusher: MemoryPusher; withheld: () => Withheld }> = [];
let held = 0;
afterEach(() => {
  for (const { pusher, withheld } of recorded.splice(0)) {
    held += expectNamesNothing(pusher.sent(), withheld());
  }
});

/**
 * Two people with names of their own in a conversation, a pusher, a held
 * schedule, a recorded pause, a clock and who is online; `send` writes a
 * message as the chat does, hands it to the push with the chat's own readers
 * and waits for the push to settle. `control` lets a test see who is asked
 * whether they are online and hold a pause.
 */
async function scene(ctx: TestContext, options: { pusher?: false } = {}) {
  const [first, second] = await people(ctx.client, null, 2, { complete: true });
  if (!first || !second) throw new Error("no people");
  const a = first;
  const b = second;
  const names = ["Ilmatar", "Väinämöinen"];
  await ctx.client.query(
    "UPDATE profile SET display_name = CASE account_id WHEN $1::uuid THEN $3 ELSE $4 END WHERE account_id IN ($1, $2)",
    [a, b, names[0], names[1]],
  );
  const conversationId = await conversationBetween(ctx.client, a, b, {
    openedAt: new Date(T.getTime() - HOUR),
  });
  const { logger, lines } = await captureLogger();
  const pusher = memoryPusher();
  const schedule = heldSchedule();
  const clock = { at: T };
  const online = new Set<string>();
  const texts: string[] = [];
  const ids = [a, b];
  const conversations = [conversationId];
  /** Each pause asked for, and how many requests had gone when it was. */
  const pauses: Array<{ ms: number; after: number }> = [];
  const control: { asked?: (accountId: string) => void; pause?: () => Promise<void> } = {};
  const push: Push = createPush({
    db: ctx.client,
    logger,
    now: () => clock.at,
    ...(options.pusher === false ? {} : { pusher }),
    online: (accountId) => {
      control.asked?.(accountId);
      return online.has(accountId);
    },
    schedule: schedule.schedule,
    pause: async (ms) => {
      pauses.push({ ms, after: pusher.batches.length });
      await control.pause?.();
    },
  });
  const withheld = (): Withheld => ({ texts, names, ids, conversations });
  recorded.push({ pusher, withheld });

  /** A message written as the chat writes it, then handed to the push. */
  async function send(from: "a" | "b", body: string, conversation = conversationId) {
    texts.push(body);
    const sent = await ctx.client.query<{ seq: number }>(
      `WITH bumped AS (
         UPDATE conversation SET next_seq = next_seq + 1, last_message_at = $4
         WHERE id = $1 RETURNING next_seq - 1 AS seq)
       INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
       SELECT $1, bumped.seq, $2, $3, 'text', $5, $4 FROM bumped
       RETURNING seq`,
      [conversation, from, randomUUID(), clock.at, body],
    );
    const seq = sent.rows[0]?.seq;
    if (seq === undefined) throw new Error("message not written");
    const senderAccountId = from === "a" ? a : b;
    push.message({
      conversationId: conversation,
      readers: () =>
        messageReaders(ctx.client, { conversationId: conversation, seq, senderAccountId }),
    });
    await push.settled();
  }

  /** A device of `accountId`, registered at `minute` minutes before T, its session among what a push must not name. */
  async function device(accountId: string, locale = "en", minute = 0, extra = {}) {
    const written = await deviceOf(ctx.client, accountId, {
      locale,
      at: new Date(T.getTime() - (60 - minute) * MINUTE),
      ...extra,
    });
    ids.push(written.sessionId);
    return written;
  }

  return {
    a,
    b,
    conversationId,
    names,
    pusher,
    schedule,
    clock,
    online,
    push,
    logs: lines,
    send,
    device,
    ids,
    conversations,
    pauses,
    control,
  };
}

/** A switch of `kind` for `accountId`, written as the Settings route writes it. */
async function switchOff(ctx: TestContext, accountId: string, kind: string, enabled = false) {
  await ctx.client.query(
    `INSERT INTO notification_preference (account_id, kind, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [accountId, kind, enabled],
  );
}

const lineOf = (lines: LogLine[], msg: string) => lines.filter((line) => line.msg === msg);

/** No log line names a device, by its token or the token's inside. */
function expectNoToken(lines: LogLine[], tokens: string[]) {
  const raw = JSON.stringify(lines);
  for (const token of tokens) {
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice("ExponentPushToken[".length, -1));
  }
}

/** A message's push as it goes: its kind alone, a later one replacing it, waiting `ttl` seconds at most. */
const messagePush = (to: string, body: string, ttl = TTL_AT_T): PushMessage => ({
  to,
  body,
  data: { kind: "message" },
  collapseId: "message",
  tag: "message",
  channelId: "default",
  priority: "high",
  sound: "default",
  ttl,
});

describe("the quiet hours (ADR-055 §7)", () => {
  it.each([
    // From late to early, across midnight: 22 to 8.
    [22, 8, 21, false],
    [22, 8, 22, true],
    [22, 8, 23, true],
    [22, 8, 0, true],
    [22, 8, 7, true],
    [22, 8, 8, false],
    [22, 8, 12, false],
    // Within a day: 1 to 5.
    [1, 5, 0, false],
    [1, 5, 1, true],
    [1, 5, 4, true],
    [1, 5, 5, false],
    [1, 5, 23, false],
    // An hour's width at either end of the day.
    [23, 0, 22, false],
    [23, 0, 23, true],
    [23, 0, 0, false],
    [0, 1, 0, true],
    [0, 1, 1, false],
    // Equal hours mean none.
    [9, 9, 8, false],
    [9, 9, 9, false],
    [9, 9, 10, false],
    [0, 0, 0, false],
    [0, 0, 23, false],
  ])("from %i to %i, %i o'clock is quiet: %s", (from, to, hour, quiet) => {
    expect(inQuietHours(hour, from, to)).toBe(quiet);
  });
});

describe("a message's push (ADR-055 §4)", () => {
  test("goes to its reader alone, once a device, worded in each device's language, with nothing else", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const fi = await s.device(s.b, "fi", 1);
    const sv = await s.device(s.b, "sv", 2, { platform: "android" });
    const en = await s.device(s.b, "en", 3);
    await s.device(s.a, "fi", 4);

    await s.send("a", "Moi! Lähdetkö kahville?");

    expect(s.pusher.batches).toHaveLength(1);
    expect(s.pusher.sent()).toStrictEqual([
      messagePush(fi.token, LINES.message.fi),
      messagePush(sv.token, LINES.message.sv),
      messagePush(en.token, LINES.message.en),
    ]);
    for (const message of s.pusher.sent()) {
      for (const absent of ["title", "badge", "subtitle"])
        expect(message).not.toHaveProperty(absent);
      // Its kind alone: never the conversation, whose id both phones would share.
      expect(message.data).toStrictEqual({ kind: "message" });
    }
    // The receipts are read once, fifteen minutes later.
    expect(s.schedule.tasks.map((task) => task.ms)).toEqual([RECEIPT_DELAY_MS]);
    expect(RECEIPT_DELAY_MS).toBe(15 * MINUTE);
  });

  test("returns at once and runs after its caller, and settled waits for it and for a push started while it waits", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    // Nothing in flight: settled resolves at once.
    await s.push.settled();
    const expo = gate();
    const reached = gate();
    s.pusher.gate = expo.promise;
    s.pusher.reached = reached.open;
    let read = false;
    const returned = s.push.message({
      conversationId: s.conversationId,
      readers: async () => {
        read = true;
        return [s.b];
      },
    });
    // It returned before anything was read or sent.
    expect(returned).toBeUndefined();
    expect(read).toBe(false);
    expect(s.pusher.batches).toEqual([]);
    // It goes on by itself, as far as Expo, which has not answered.
    await reached.promise;
    expect(read).toBe(true);
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
    const waiting = s.push.settled();
    // A match started while settled waits, its reads still ahead of it: waited for too.
    s.push.match({ accountId: s.b });
    expo.open();
    await waiting;
    expect(s.pusher.batches.map((batch) => batch.map((m) => m.data.kind))).toEqual([
      ["message"],
      ["match"],
    ]);
    // Both were taken, and wait for their receipts.
    expect(s.schedule.tasks).toHaveLength(2);
  });

  test("sends nothing to a reader with a live socket, and pushes once they have none", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    s.online.add(s.b);
    await s.send("a", "Oletko siellä?");
    expect(s.pusher.sent()).toEqual([]);
    // In the app, nothing was taken from the interval: the next message, once away, pushes.
    s.online.delete(s.b);
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "No, kerro sitten.");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("sends nothing to a reader whose message switch is off, whatever their other switches", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    await switchOff(ctx, s.b, "message");
    await s.send("a", "Hei!");
    expect(s.pusher.sent()).toEqual([]);
    // On again, with every other kind off: the message's switch alone decides.
    await switchOff(ctx, s.b, "message", true);
    for (const kind of ["round", "match", "moderation"]) await switchOff(ctx, s.b, kind);
    await s.send("a", "Hei taas!");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("sends nothing in the quiet hours, keeps nothing for later, and the first message after them pushes", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    for (const at of ["22:00:00", "23:30:00", "03:00:00", "07:59:59"]) {
      s.clock.at = at.startsWith("0") ? new Date(helsinki(at).getTime() + 24 * HOUR) : helsinki(at);
      await s.send("a", `Myöhään ${at}`);
    }
    expect(s.pusher.sent()).toEqual([]);
    // 08:00 the next morning, within ten minutes of nothing that went: it pushes, once.
    s.clock.at = new Date(helsinki("08:00:00").getTime() + 24 * HOUR);
    await s.send("a", "Huomenta!");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("pushes a conversation once within the interval, again once it has passed, and each conversation and reader on its own", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const toB = await s.device(s.b);
    const toA = await s.device(s.a);
    await s.send("a", "Yksi");
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Kaksi");
    s.clock.at = new Date(T.getTime() + 10 * MINUTE - 1);
    await s.send("a", "Kolme");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([toB.token]);
    // Ten minutes after the push that went: the interval has passed.
    s.clock.at = new Date(T.getTime() + 10 * MINUTE);
    await s.send("a", "Neljä");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([toB.token, toB.token]);
    // It counts from that push, not from the first.
    s.clock.at = new Date(T.getTime() + 15 * MINUTE);
    await s.send("a", "Viisi");
    expect(s.pusher.sent()).toHaveLength(2);
    // The other reader's interval is theirs: B's reply pushes A.
    await s.send("b", "Kuusi");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([toB.token, toB.token, toA.token]);
    // Another conversation of B's is its own: it pushes within the first's interval.
    const [c] = await people(ctx.client, null, 1, { complete: true });
    if (!c) throw new Error("no person");
    s.ids.push(c);
    const other = await conversationBetween(ctx.client, c, s.b, { openedAt: T });
    s.conversations.push(other);
    await s.send("a", "Seitsemän", other);
    expect(s.pusher.sent()).toHaveLength(4);
    expect(s.pusher.sent().at(-1)).toStrictEqual(
      messagePush(toB.token, LINES.message.en, TTL_AT_T - 15 * 60),
    );
  });

  test("reads the interval from matching_config", async ({ ctx }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    await withMatchingConfig(ctx.client, { [MESSAGE_PUSH_INTERVAL_KEY]: 1 });
    await s.send("a", "Yksi");
    s.clock.at = new Date(T.getTime() + MINUTE - 1);
    await s.send("a", "Kaksi");
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Kolme");
    expect(s.pusher.sent()).toHaveLength(2);
    // None at all: every message pushes.
    await withMatchingConfig(ctx.client, { [MESSAGE_PUSH_INTERVAL_KEY]: 0 });
    await s.send("a", "Neljä");
    await s.send("a", "Viisi");
    expect(s.pusher.sent()).toHaveLength(4);
  });

  test("two messages at once push once, whichever reads its readers first", async ({ ctx }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    // Both wait on their readers; both go on at the same moment.
    const opened = gate();
    const readers = async () => {
      await opened.promise;
      return [s.b];
    };
    s.push.message({ conversationId: s.conversationId, readers });
    s.push.message({ conversationId: s.conversationId, readers });
    opened.open();
    await s.push.settled();
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);

    // The first still waiting on Expo when the second is decided: a reader is
    // decided on the moment they are asked whether they are online.
    s.clock.at = new Date(T.getTime() + 10 * MINUTE);
    const expo = gate();
    const reached = gate();
    s.pusher.gate = expo.promise;
    s.pusher.reached = reached.open;
    s.push.message({ conversationId: s.conversationId, readers: async () => [s.b] });
    await reached.promise;
    expect(s.pusher.batches).toHaveLength(2);
    const decided = gate();
    s.control.asked = decided.open;
    s.push.message({ conversationId: s.conversationId, readers: async () => [s.b] });
    await decided.promise;
    expo.open();
    await s.push.settled();
    expect(s.pusher.batches).toHaveLength(2);
  });

  test("goes to the live devices alone: not a revoked session's, not an expired one's, never another account's", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const [c] = await people(ctx.client, null, 1, { complete: true });
    if (!c) throw new Error("no person");
    s.ids.push(c);
    const first = await s.device(s.b, "en", 1);
    const second = await s.device(s.b, "fi", 2);
    // Revoked as the identity slice revokes: the trigger takes its token.
    const signedOut = await s.device(s.b, "en", 3);
    await ctx.client.query("UPDATE session SET revoked_at = $2 WHERE id = $1", [
      signedOut.sessionId,
      T,
    ]);
    // A revoked session that still has a token, which no statement leaves: the sender's own filter.
    const revoked = await s.device(s.b, "en", 4, { revokedAt: new Date(T.getTime() - MINUTE) });
    // Expired, waiting for the night's prune; and one expiring at this very moment.
    const expired = await s.device(s.b, "en", 5, { expiresAt: new Date(T.getTime() - SECOND) });
    const expiring = await s.device(s.b, "en", 6, { expiresAt: T });
    const theirs = await s.device(c, "en", 7);

    await s.send("a", "Kenelle tämä menee?");

    expect(s.pusher.sent().map((m) => [m.to, m.body])).toEqual([
      [first.token, LINES.message.en],
      [second.token, LINES.message.fi],
    ]);
    expect(await tokensLeft(ctx.client, [s.b, c])).toEqual([
      first.token,
      second.token,
      revoked.token,
      expired.token,
      expiring.token,
      theirs.token,
    ]);
  });

  test("a ticket that says the device is gone deletes its token alone; another refusal keeps it and is logged by its code", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const gone = await s.device(s.b, "en", 1);
    const refused = await s.device(s.b, "en", 2);
    const unnamed = await s.device(s.b, "en", 3);
    const kept = await s.device(s.b, "en", 4);
    s.pusher.ticket = (message) =>
      message.to === gone.token
        ? { status: "error", error: "DeviceNotRegistered" }
        : message.to === refused.token
          ? { status: "error", error: "MessageRateExceeded" }
          : message.to === unnamed.token
            ? { status: "error", error: null }
            : { status: "ok", id: "ticket-kept" };

    await s.send("a", "Menikö perille?");

    expect(s.pusher.sent()).toHaveLength(4);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([refused.token, unnamed.token, kept.token]);
    const lines = s.logs();
    expect(lineOf(lines, "push token gone")).toEqual([
      expect.objectContaining({ accountId: s.b, push: "message" }),
    ]);
    expect(
      lineOf(lines, "push refused").map((line) => [line.accountId, line.push, line.error]),
    ).toEqual([
      [s.b, "message", "MessageRateExceeded"],
      [s.b, "message", null],
    ]);
    expectNoToken(lines, [gone.token, refused.token, unnamed.token, kept.token]);
    // Only what Expo took waits for its receipt.
    expect(s.schedule.tasks).toHaveLength(1);
    await s.schedule.runAll();
    expect(s.pusher.asked).toEqual([["ticket-kept"]]);
  });

  test("a push every device refused waits for no receipt and takes nothing from the interval", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const first = await s.device(s.b, "en", 1);
    const second = await s.device(s.b, "en", 2);
    s.pusher.ticket = () => ({ status: "error", error: "MessageRateExceeded" });
    await s.send("a", "Yksi");
    expect(s.schedule.tasks).toEqual([]);
    // Nothing went: a minute later the next message pushes again.
    s.pusher.ticket = () => ({ status: "ok", id: "ticket-later" });
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Kaksi");
    expect(s.pusher.batches.map((batch) => batch.map((m) => m.to))).toEqual([
      [first.token, second.token],
      [first.token, second.token],
    ]);
    expect(s.schedule.tasks).toHaveLength(1);
  });

  test("the receipts, read once later, delete a device Apple or Google no longer knows and keep the rest", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const unnamed = await s.device(s.b, "en", 1);
    const gone = await s.device(s.b, "en", 2);
    const fine = await s.device(s.b, "en", 3);
    const pending = await s.device(s.b, "en", 4);
    const tooBig = await s.device(s.b, "en", 5);
    const ticketOf = new Map<string, string>();
    s.pusher.ticket = (message) => {
      const id = `ticket-${ticketOf.size + 1}`;
      ticketOf.set(id, message.to);
      return { status: "ok", id };
    };
    s.pusher.receipt = (id) => {
      const to = ticketOf.get(id);
      if (to === unnamed.token) return { status: "error", error: null };
      if (to === gone.token) return { status: "error", error: "DeviceNotRegistered" };
      if (to === tooBig.token) return { status: "error", error: "MessageTooBig" };
      if (to === pending.token) return undefined;
      return { status: "ok" };
    };

    await s.send("a", "Kuittaa!");
    // Nothing is read until the timer runs.
    expect(s.pusher.asked).toEqual([]);
    expect(await tokensLeft(ctx.client, [s.b])).toHaveLength(5);

    expect(await s.schedule.runAll()).toBe(1);
    expect(s.pusher.asked).toEqual([["ticket-1", "ticket-2", "ticket-3", "ticket-4", "ticket-5"]]);
    // A refusal with no code, first, stops nothing after it.
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([
      unnamed.token,
      fine.token,
      pending.token,
      tooBig.token,
    ]);
    const lines = s.logs();
    expect(lineOf(lines, "push token gone")).toHaveLength(1);
    expect(lineOf(lines, "push refused").map((line) => line.error)).toEqual([
      null,
      "MessageTooBig",
    ]);
    expect(lineOf(lines, "push receipts not read")).toEqual([]);
    expectNoToken(lines, [unnamed.token, gone.token, fine.token, pending.token, tooBig.token]);
  });

  test("without a schedule handed in, the receipts are read on the process's own timer, fifteen minutes on", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    const { logger } = await captureLogger();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const push = createPush({
        db: ctx.client,
        logger,
        now: () => T,
        pusher: s.pusher,
        online: () => false,
      });
      push.message({ conversationId: s.conversationId, readers: async () => [s.b] });
      await push.settled();
      expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
      await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MS - 1);
      expect(s.pusher.asked).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.pusher.asked).toEqual([["ticket-1"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a receipt deletes its token only while it is still the account's that was pushed", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const moved = await s.device(s.b);
    s.pusher.receipt = () => ({ status: "error", error: "DeviceNotRegistered" });
    await s.send("a", "Kenen laite?");
    // Meanwhile the phone was signed in as somebody else, who registered the same token.
    const [c] = await people(ctx.client, null, 1, { complete: true });
    if (!c) throw new Error("no person");
    s.ids.push(c);
    const theirs = await deviceOf(ctx.client, c);
    s.ids.push(theirs.sessionId);
    await ctx.client.query("DELETE FROM push_token WHERE id = $1", [theirs.tokenId]);
    await ctx.client.query("UPDATE push_token SET account_id = $2, session_id = $3 WHERE id = $1", [
      moved.tokenId,
      c,
      theirs.sessionId,
    ]);
    await s.schedule.runAll();
    expect(await tokensLeft(ctx.client, [c])).toEqual([moved.token]);
  });

  test("a receipts read that fails is logged by its kind and code, throws nothing and keeps every token", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    s.pusher.receipt = () => ({ status: "error", error: "DeviceNotRegistered" });
    s.pusher.receiptFailure = new PushFailed("TOO_MANY_REQUESTS", 429);
    await s.send("a", "Yksi");
    await expect(s.schedule.runAll()).resolves.toBe(1);
    s.clock.at = new Date(T.getTime() + 10 * MINUTE);
    s.pusher.receiptFailure = new TypeError(`fetch failed for ${device.token}`);
    await s.send("a", "Kaksi");
    await expect(s.schedule.runAll()).resolves.toBe(1);
    expect(s.pusher.asked).toHaveLength(2);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([device.token]);
    const lines = lineOf(s.logs(), "push receipts not read");
    expect(lines.map((line) => [line.push, line.reason, line.status])).toEqual([
      ["message", "TOO_MANY_REQUESTS", 429],
      ["message", "TypeError", undefined],
    ]);
    expectNoToken(s.logs(), [device.token]);
  });

  test("a send Expo refuses is logged as not sent, changes nothing, and gives the interval back", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    s.pusher.failure = new PushFailed("TOO_MANY_REQUESTS", 429);
    await expect(s.send("a", "Yksi")).resolves.toBeUndefined();
    s.pusher.failure = new TypeError(`connect ECONNREFUSED for ${device.token}`);
    await expect(s.send("a", "Kaksi")).resolves.toBeUndefined();
    // Something that is no error at all, as a library may reject with.
    s.pusher.failure = device.token as unknown as Error;
    await expect(s.send("a", "Kolme")).resolves.toBeUndefined();
    expect(s.schedule.tasks).toEqual([]);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([device.token]);
    expect(
      lineOf(s.logs(), "push not sent").map((line) => [line.push, line.reason, line.status]),
    ).toEqual([
      ["message", "TOO_MANY_REQUESTS", 429],
      ["message", "TypeError", undefined],
      ["message", "unknown", undefined],
    ]);
    // Nothing went, so the next message within the interval pushes.
    s.pusher.failure = undefined;
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Neljä");
    expect(s.pusher.batches).toHaveLength(4);
    expect(s.schedule.tasks).toHaveLength(1);
    expectNoToken(s.logs(), [device.token]);
  });

  test("a parameter missing is logged as a failure, throws nothing and sends nothing", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [
      MESSAGE_PUSH_INTERVAL_KEY,
    ]);
    await expect(s.send("a", "Yksi")).resolves.toBeUndefined();
    expect(s.pusher.sent()).toEqual([]);
    expect(lineOf(s.logs(), "push failed")).toEqual([
      expect.objectContaining({ push: "message", reason: "AppError", level: 50 }),
    ]);
  });

  test("a failure after the interval was taken gives it back, so the next message pushes", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    // The quiet hours' row is read after the interval is taken.
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [QUIET_FROM_KEY]);
    await s.send("a", "Yksi");
    expect(lineOf(s.logs(), "push failed")).toHaveLength(1);
    expect(s.pusher.sent()).toEqual([]);
    await withMatchingConfig(ctx.client, { [QUIET_FROM_KEY]: 22 });
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Kaksi");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("a quiet hour that is no hour of the day is a failure, logged by its key, and sends nothing", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    const cases: Array<[string, number]> = [
      [QUIET_FROM_KEY, 24],
      [QUIET_TO_KEY, -1],
      [QUIET_FROM_KEY, 2.5],
    ];
    for (const [i, [key, value]] of cases.entries()) {
      await withMatchingConfig(ctx.client, {
        [QUIET_FROM_KEY]: 22,
        [QUIET_TO_KEY]: 8,
        [key]: value,
      });
      s.clock.at = new Date(T.getTime() + i * MINUTE);
      await s.send("a", `Viesti ${i}`);
    }
    expect(s.pusher.sent()).toEqual([]);
    const failed = lineOf(s.logs(), "push failed");
    expect(failed.map((line) => [line.push, line.reason, line.level])).toEqual(
      cases.map(() => ["message", "AppError", 50]),
    );
    expect(failed.map((line) => (line.err as { detail?: unknown }).detail)).toEqual(
      cases.map(([key]) => ({ key })),
    );
    // Hours again: the interval was given back each time, so the next message pushes.
    await withMatchingConfig(ctx.client, { [QUIET_FROM_KEY]: 22, [QUIET_TO_KEY]: 8 });
    s.clock.at = new Date(T.getTime() + cases.length * MINUTE);
    await s.send("a", "Nyt");
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
  });

  test("where nothing is sent, nothing is read: not the readers, not a parameter, not a token", async ({
    ctx,
  }) => {
    const { logger } = await captureLogger();
    const { db, statements } = recorder(ctx.client);
    const push = createPush({ db, logger, now: () => T, online: () => false });
    let read = false;
    push.message({
      conversationId: randomUUID(),
      readers: async () => {
        read = true;
        return [randomUUID()];
      },
    });
    push.match({ accountId: randomUUID() });
    await push.settled();
    expect(await push.round([randomUUID()])).toBe(0);
    expect(read).toBe(false);
    expect(statements).toEqual([]);
  });

  test("a message nobody may read pushes nobody, and asks nothing more", async ({ ctx }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    const { db, statements } = recorder(ctx.client);
    const push = createPush({
      db,
      logger: (await captureLogger()).logger,
      now: () => T,
      pusher: s.pusher,
      online: () => false,
    });
    push.message({ conversationId: s.conversationId, readers: async () => [] });
    await push.settled();
    expect(s.pusher.sent()).toEqual([]);
    // The interval's row alone: no quiet hours, switch or token for nobody.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("matching_config");
  });
});

describe("a match's push (ADR-055 §5)", () => {
  test("goes to the account it names alone, in the app or not, worded in its device's language", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const fi = await s.device(s.b, "fi", 1);
    const en = await s.device(s.b, "en", 2);
    await s.device(s.a, "en", 3);
    s.online.add(s.a);
    s.online.add(s.b);
    expect(s.push.match({ accountId: s.b })).toBeUndefined();
    await s.push.settled();
    const data: PushData = { kind: "match" };
    expect(s.pusher.sent()).toStrictEqual(
      [
        [fi.token, LINES.match.fi],
        [en.token, LINES.match.en],
      ].map(([to, body]) => ({
        to,
        body,
        data,
        collapseId: "match",
        tag: "match",
        channelId: "default",
        priority: "high",
        sound: "default",
        ttl: TTL_AT_T,
      })),
    );
    expect(s.schedule.tasks).toHaveLength(1);
  });

  test("sends nothing where the match switch is off or in the quiet hours, and nothing ever throws", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    const match = async () => {
      s.push.match({ accountId: s.b });
      await s.push.settled();
    };
    await switchOff(ctx, s.b, "match");
    await match();
    await switchOff(ctx, s.b, "match", true);
    s.clock.at = helsinki("22:00:00");
    await match();
    expect(s.pusher.sent()).toEqual([]);
    // The message's switch is not the match's.
    s.clock.at = T;
    await switchOff(ctx, s.b, "message");
    await match();
    expect(s.pusher.sent().map((m) => m.to)).toEqual([device.token]);
    // A missing parameter, or a quiet hour that is no hour, is logged, never thrown.
    await withMatchingConfig(ctx.client, { [QUIET_FROM_KEY]: 24 });
    expect(() => s.push.match({ accountId: s.b })).not.toThrow();
    await s.push.settled();
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [QUIET_TO_KEY]);
    expect(() => s.push.match({ accountId: s.b })).not.toThrow();
    await s.push.settled();
    expect(lineOf(s.logs(), "push failed")).toEqual([
      expect.objectContaining({ push: "match", reason: "AppError" }),
      expect.objectContaining({ push: "match", reason: "AppError" }),
    ]);
    expect(s.pusher.sent()).toHaveLength(1);
  });
});

describe("the round's push (ADR-055 §6)", () => {
  test("goes to each account named, worded in each device's language, until the quiet hours begin", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const a = await s.device(s.a, "sv", 1);
    const fi = await s.device(s.b, "fi", 2);
    const en = await s.device(s.b, "en", 3);
    // The round reads no socket: whom its job names is told.
    s.online.add(s.a);
    expect(await s.push.round([s.a, s.b])).toBe(3);
    const sent = s.pusher.sent();
    // By account, then by when each device registered; the accounts' order is their ids'.
    expect(new Set(sent.map((m) => `${m.to} ${m.body}`))).toEqual(
      new Set([
        `${a.token} ${LINES.round.sv}`,
        `${fi.token} ${LINES.round.fi}`,
        `${en.token} ${LINES.round.en}`,
      ]),
    );
    expect(sent.filter((m) => m.to !== a.token).map((m) => m.to)).toEqual([fi.token, en.token]);
    for (const message of sent) {
      expect({ ...message, to: "", body: "" }).toStrictEqual({
        to: "",
        body: "",
        data: { kind: "round" },
        collapseId: "round",
        tag: "round",
        channelId: "default",
        priority: "normal",
        sound: "default",
        ttl: TTL_AT_T,
      });
    }
  });

  test("leaves out an account whose round switch is off, answers what Expo took, and nothing in the quiet hours", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const a = await s.device(s.a, "en", 1);
    const gone = await s.device(s.b, "en", 2);
    const kept = await s.device(s.b, "en", 3);
    await switchOff(ctx, s.a, "round");
    s.pusher.ticket = (message) =>
      message.to === gone.token
        ? { status: "error", error: "DeviceNotRegistered" }
        : { status: "ok", id: "ticket-round" };
    expect(await s.push.round([s.a, s.b])).toBe(1);
    expect(s.pusher.sent().map((m) => m.to)).toEqual([gone.token, kept.token]);
    expect(await tokensLeft(ctx.client, [s.a, s.b])).toEqual([a.token, kept.token]);
    // Nobody, or the quiet hours: nothing is sent.
    expect(await s.push.round([])).toBe(0);
    s.clock.at = helsinki("23:00:00");
    expect(await s.push.round([s.b])).toBe(0);
    expect(s.pusher.batches).toHaveLength(1);
  });

  test("a hundred pushes go in a request, and one refused loses only its own: the tickets before it are read", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    for (let i = 0; i < 150; i += 1) await s.device(s.b, "en", i % 60);
    // The first request's last push is refused as a device gone; Expo refuses the second request whole.
    let ticketed = 0;
    s.pusher.ticket = (message) => {
      ticketed += 1;
      return ticketed === 100
        ? { status: "error", error: "DeviceNotRegistered" }
        : { status: "ok", id: `ticket-${message.to}` };
    };
    s.pusher.reached = () => {
      s.pusher.failure =
        s.pusher.batches.length === 2 ? new PushFailed("TOO_MANY_REQUESTS", 429) : undefined;
    };
    expect(await s.push.round([s.b])).toBe(99);
    expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100, 50]);
    // Spaced to Expo's rate: one pause, between the two requests.
    expect(s.pauses).toEqual([{ ms: REQUEST_SPACING_MS, after: 1 }]);
    expect(lineOf(s.logs(), "push not sent")).toEqual([
      expect.objectContaining({
        push: "round",
        reason: "TOO_MANY_REQUESTS",
        status: 429,
        pushes: 50,
      }),
    ]);
    // The refused device of the first request went, the second's fifty are kept.
    const { rows } = await ctx.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM push_token WHERE account_id = $1",
      [s.b],
    );
    expect(rows[0]?.n).toBe(149);
    // Only what Expo took waits for its receipt.
    expect(s.schedule.tasks).toHaveLength(1);
    await s.schedule.runAll();
    expect(s.pusher.asked.flat()).toHaveLength(99);
  });

  test("a round's failure is its job's to log: a missing parameter rejects, a refused send answers none", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    s.pusher.failure = new PushFailed("TOO_MANY_REQUESTS", 429);
    expect(await s.push.round([s.b])).toBe(0);
    expect(lineOf(s.logs(), "push not sent")).toEqual([
      expect.objectContaining({ push: "round", reason: "TOO_MANY_REQUESTS", status: 429 }),
    ]);
    // A quiet hour that is no hour of the day, then none at all: the run fails, naming it.
    await withMatchingConfig(ctx.client, { [QUIET_TO_KEY]: 24 });
    await expect(s.push.round([s.b])).rejects.toThrow(
      "matching_config push_quiet_to_hour is not an hour",
    );
    await ctx.client.query("DELETE FROM matching_config WHERE key = $1", [QUIET_FROM_KEY]);
    await expect(s.push.round([s.b])).rejects.toThrow(/push_quiet_from_hour/);
    expect(s.pusher.batches).toHaveLength(1);
    expect(lineOf(s.logs(), "push failed")).toEqual([]);
  });

  test("spaces its requests to Expo's rate: a pause between two requests, never before the first", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    // A hundred devices are one request, with no pause.
    for (let i = 0; i < 100; i += 1) await s.device(s.a, "en", i % 60);
    expect(await s.push.round([s.a])).toBe(100);
    expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100]);
    expect(s.pauses).toEqual([]);
    // Two hundred and one are three, with a pause before each after the first,
    // and a request waits for its pause.
    for (let i = 0; i < 201; i += 1) await s.device(s.b, "en", i % 60);
    const holding = gate();
    const reached = gate();
    s.control.pause = async () => {
      s.control.pause = undefined;
      reached.open();
      await holding.promise;
    };
    const round = s.push.round([s.b]);
    await reached.promise;
    expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100, 100]);
    holding.open();
    expect(await round).toBe(201);
    expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100, 100, 100, 1]);
    expect(s.pauses).toEqual([
      { ms: REQUEST_SPACING_MS, after: 2 },
      { ms: REQUEST_SPACING_MS, after: 3 },
    ]);
    expect(REQUEST_SPACING_MS).toBe(200);
  });

  test("without a pause handed in, waits on the process's own timer between requests", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    for (let i = 0; i < 101; i += 1) await s.device(s.b, "en", i % 60);
    const { logger } = await captureLogger();
    const first = gate();
    s.pusher.reached = first.open;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const push = createPush({
        db: ctx.client,
        logger,
        now: () => T,
        pusher: s.pusher,
        online: () => false,
        schedule: s.schedule.schedule,
      });
      const round = push.round([s.b]);
      await first.promise;
      await vi.advanceTimersByTimeAsync(REQUEST_SPACING_MS - 1);
      expect(s.pusher.batches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await round).toBe(101);
      expect(s.pusher.batches.map((batch) => batch.length)).toEqual([100, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a request refused for tokens of more than one Expo project (ADR-055 §8)", () => {
  test("keeps the project most tokens are of, forgets the others' tokens, and sends the rest once more", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const devices: Array<{ token: string }> = [];
    for (let i = 0; i < 6; i += 1) devices.push(await s.device(s.b, "en", i));
    const [t1, t2, t3, t4, t5, t6] = devices.map((device) => device.token);
    if (!t1 || !t2 || !t3 || !t4 || !t5 || !t6) throw new Error("no devices");
    // Three projects: ours has three of the tokens, the other two the rest.
    const strays = [t2, t4, t6];
    const mixed = new PushFailed(MIXED_PROJECTS, 400, [[t2], [t1, t3, t5], [t4, t6]]);
    s.pusher.reached = () => {
      const batch = s.pusher.batches.at(-1) ?? [];
      s.pusher.failure = batch.some((m) => strays.includes(m.to)) ? mixed : undefined;
    };
    expect(await s.push.round([s.b])).toBe(3);
    expect(s.pusher.batches.map((batch) => batch.map((m) => m.to))).toEqual([
      [t1, t2, t3, t4, t5, t6],
      [t1, t3, t5],
    ]);
    // The others' tokens are gone; ours are kept, and wait for their receipts.
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([t1, t3, t5]);
    expect(s.schedule.tasks).toHaveLength(1);
    await s.schedule.runAll();
    expect(s.pusher.asked.flat()).toHaveLength(3);
    const lines = s.logs();
    expect(lineOf(lines, "push tokens of another project gone")).toEqual([
      expect.objectContaining({ push: "round", strays: 3, level: 40 }),
    ]);
    expect(lineOf(lines, "push not sent")).toEqual([]);
    expectNoToken(lines, [t1, t2, t3, t4, t5, t6]);
    // The next push goes in one request.
    s.clock.at = new Date(T.getTime() + MINUTE);
    await s.send("a", "Taas");
    expect(s.pusher.batches.at(-1)?.map((m) => m.to)).toEqual([t1, t3, t5]);
  });

  test("one where every token is of one project after all is the request's refusal: logged as not sent, nothing forgotten", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const first = await s.device(s.b, "en", 1);
    const second = await s.device(s.b, "en", 2);
    s.pusher.failure = new PushFailed(MIXED_PROJECTS, 400, [[first.token, second.token]]);
    expect(await s.push.round([s.b])).toBe(0);
    expect(s.pusher.batches).toHaveLength(1);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([first.token, second.token]);
    const lines = s.logs();
    expect(lineOf(lines, "push not sent")).toEqual([
      expect.objectContaining({ push: "round", reason: MIXED_PROJECTS, status: 400, pushes: 2 }),
    ]);
    expect(lineOf(lines, "push tokens of another project gone")).toEqual([]);
    // Without the projects it names, the refusal is any other: nothing forgotten either.
    s.pusher.failure = new PushFailed(MIXED_PROJECTS, 400);
    expect(await s.push.round([s.b])).toBe(0);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([first.token, second.token]);
    expect(lineOf(s.logs(), "push not sent")).toHaveLength(2);
    expectNoToken(s.logs(), [first.token, second.token]);
  });

  test("forgets only the tokens Expo named in another project: one it named nowhere is kept and sent again", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const ours = await s.device(s.b, "en", 1);
    const stray = await s.device(s.b, "en", 2);
    const unnamed = await s.device(s.b, "en", 3);
    // Expo names two projects, and not the third token at all.
    const mixed = new PushFailed(MIXED_PROJECTS, 400, [
      [ours.token, "ExponentPushToken[elsewhere]"],
      [stray.token],
    ]);
    s.pusher.reached = () => {
      const batch = s.pusher.batches.at(-1) ?? [];
      s.pusher.failure = batch.some((m) => m.to === stray.token) ? mixed : undefined;
    };
    expect(await s.push.round([s.b])).toBe(2);
    expect(
      s.pusher.batches
        .at(-1)
        ?.map((m) => m.to)
        .sort(),
    ).toEqual([ours.token, unnamed.token].sort());
    expect((await tokensLeft(ctx.client, [s.b])).sort()).toEqual(
      [ours.token, unnamed.token].sort(),
    );
    expect(lineOf(s.logs(), "push tokens of another project gone")).toEqual([
      expect.objectContaining({ strays: 1 }),
    ]);
  });

  test("groups that name none of the request's tokens forget nothing: the refusal is logged as not sent", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const first = await s.device(s.b, "en", 1);
    const second = await s.device(s.b, "en", 2);
    s.pusher.failure = new PushFailed(MIXED_PROJECTS, 400, [
      ["ExponentPushToken[one]"],
      ["ExponentPushToken[two]"],
    ]);
    expect(await s.push.round([s.b])).toBe(0);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([first.token, second.token]);
    expect(lineOf(s.logs(), "push not sent")).toEqual([
      expect.objectContaining({ reason: MIXED_PROJECTS, pushes: 2 }),
    ]);
    expect(lineOf(s.logs(), "push tokens of another project gone")).toEqual([]);
  });

  test("a resend that is refused too loses its own pushes, and the others' tokens stay forgotten", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    const ours = await s.device(s.b, "en", 1);
    const theirs = await s.device(s.b, "en", 2);
    const alsoOurs = await s.device(s.b, "en", 3);
    s.pusher.reached = () => {
      s.pusher.failure =
        s.pusher.batches.length === 1
          ? new PushFailed(MIXED_PROJECTS, 400, [[ours.token, alsoOurs.token], [theirs.token]])
          : new PushFailed("TOO_MANY_REQUESTS", 429);
    };
    s.push.match({ accountId: s.b });
    await s.push.settled();
    expect(s.pusher.batches).toHaveLength(2);
    expect(await tokensLeft(ctx.client, [s.b])).toEqual([ours.token, alsoOurs.token]);
    expect(lineOf(s.logs(), "push not sent")).toEqual([
      expect.objectContaining({ push: "match", reason: "TOO_MANY_REQUESTS", status: 429 }),
    ]);
    expect(lineOf(s.logs(), "push failed")).toEqual([]);
    expect(s.schedule.tasks).toEqual([]);
  });
});

describe("the quiet hours and the switches, for every kind", () => {
  test("Nothing is pushed in the quiet hours", async ({ ctx }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    const everyKind = async () => {
      await s.send("a", `Viesti ${s.clock.at.toISOString()}`);
      s.push.match({ accountId: s.b });
      await s.push.settled();
      await s.push.round([s.b]);
    };
    // 22:00, 03:00 and 07:59:59 in Helsinki, each after the interval had passed.
    for (const at of [helsinki("22:00:00"), helsinki("03:00:00"), helsinki("07:59:59")]) {
      s.clock.at = new Date(at.getTime() + 24 * HOUR);
      await everyKind();
    }
    expect(s.pusher.sent()).toEqual([]);
    // 21:59:59 and 08:00 are not quiet: every kind pushes.
    s.clock.at = helsinki("21:59:59");
    await everyKind();
    expect(s.pusher.sent().map((m) => m.data.kind)).toEqual(["message", "match", "round"]);
    s.clock.at = new Date(helsinki("08:00:00").getTime() + 2 * 24 * HOUR);
    await everyKind();
    expect(s.pusher.sent().map((m) => m.to)).toEqual(Array(6).fill(device.token));
  });

  test("Quiet hours from and to the same hour are none", async ({ ctx }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    await withMatchingConfig(ctx.client, { [QUIET_FROM_KEY]: 3, [QUIET_TO_KEY]: 3 });
    s.clock.at = helsinki("03:30:00");
    await s.send("a", "Yöllä");
    expect(s.pusher.sent()).toHaveLength(1);
  });

  test("A kind switched off is never pushed", async ({ ctx }) => {
    const s = await scene(ctx);
    const device = await s.device(s.b);
    const everyKind = async (minute: number) => {
      s.clock.at = new Date(T.getTime() + minute * 10 * MINUTE);
      await s.send("a", `Viesti ${minute}`);
      s.push.match({ accountId: s.b });
      await s.push.settled();
      await s.push.round([s.b]);
    };
    const kinds: Array<PushData["kind"]> = ["message", "match", "round"];
    for (const [i, off] of kinds.entries()) {
      for (const kind of kinds) await switchOff(ctx, s.b, kind, kind !== off);
      const before = s.pusher.sent().length;
      await everyKind(i);
      expect(
        s.pusher
          .sent()
          .slice(before)
          .map((m) => m.data.kind),
        off,
      ).toEqual(kinds.filter((kind) => kind !== off));
    }
    // Every push went to the one device, and none of a kind switched off.
    expect(s.pusher.sent()).toHaveLength(6);
    expect(new Set(s.pusher.sent().map((m) => m.to))).toEqual(new Set([device.token]));
  });
});

describe("how long a push waits for its phone (ADR-055 §7)", () => {
  test("until the quiet hours begin or the Finnish day ends, whichever is sooner, for every kind, across a change of clocks", async ({
    ctx,
  }) => {
    const s = await scene(ctx);
    await s.device(s.b);
    // Every message pushes, so the times can follow each other closely.
    await withMatchingConfig(ctx.client, { [MESSAGE_PUSH_INTERVAL_KEY]: 0 });
    const cases: Array<[string, [number, number], number]> = [
      // 12:00 in summer time, quiet from 22: ten hours, though midnight is twelve away.
      ["2026-10-16T09:00:00.000Z", [22, 8], 10 * 3600],
      // 21:59:59: a second.
      ["2026-10-16T18:59:59.000Z", [22, 8], 1],
      // 23:00, quiet from 01:00: midnight comes first, an hour away.
      ["2026-10-16T20:00:00.000Z", [1, 5], 3600],
      // 00:30, quiet from 01:00: half an hour, though the day has 23 and a half left.
      ["2026-10-16T21:30:00.000Z", [1, 5], 1800],
      // Equal hours are no quiet hours: midnight alone, twelve hours from noon.
      ["2026-10-17T09:00:00.000Z", [7, 7], 12 * 3600],
      // 00:30 on 25 October, the day summer time ends: its 25 hours, less the half hour gone.
      ["2026-10-24T21:30:00.000Z", [7, 7], 24 * 3600 + 1800],
      // 02:00 that day, quiet from 05:00: four hours, the clocks going back between.
      ["2026-10-24T23:00:00.000Z", [5, 6], 4 * 3600],
      // 12:00 in winter time.
      ["2026-12-01T10:00:00.000Z", [22, 8], 10 * 3600],
      // 00:30 on 28 March 2027, the day summer time begins: its 23 hours, less the half hour.
      ["2027-03-27T22:30:00.000Z", [7, 7], 22 * 3600 + 1800],
      // 01:00 that day, quiet from 22: twenty hours, the clocks going forward between.
      ["2027-03-27T23:00:00.000Z", [22, 0], 20 * 3600],
    ];
    for (const [at, [from, to], ttl] of cases) {
      await withMatchingConfig(ctx.client, { [QUIET_FROM_KEY]: from, [QUIET_TO_KEY]: to });
      s.clock.at = new Date(at);
      const before = s.pusher.sent().length;
      await s.send("a", `Viesti ${at}`);
      s.push.match({ accountId: s.b });
      await s.push.settled();
      await s.push.round([s.b]);
      expect(
        s.pusher
          .sent()
          .slice(before)
          .map((m) => [m.data.kind, m.ttl]),
        at,
      ).toEqual([
        ["message", ttl],
        ["match", ttl],
        ["round", ttl],
      ]);
    }
  });
});

describe("the payload rule (ADR-055 §1)", () => {
  const conversationId = "0b8f6a52-2c4d-4e1f-9a3b-7c5d6e8f9a0b";
  const accountId = "5d2e8c1a-7b3f-4a6e-9d0c-1e2f3a4b5c6d";
  const sessionId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const clean = messagePush("ExponentPushToken[payload-rule]", LINES.message.fi);
  const withheld: Withheld = {
    texts: ["Moi, nähdäänkö huomenna?"],
    names: ["Ilmatar"],
    ids: [accountId, sessionId],
    conversations: [conversationId],
  };

  it("passes a push that says only that there is something", () => {
    expect(payloadBreaches(clean, withheld)).toEqual([]);
    for (const kind of ["message", "match", "round"] as const) {
      for (const body of Object.values(LINES[kind])) {
        expect(payloadBreaches({ ...clean, body }, withheld)).toEqual([]);
      }
    }
    for (const kind of ["match", "round"] as const) {
      const other: PushMessage = { ...clean, data: { kind }, collapseId: kind, tag: kind, ttl: 60 };
      expect(payloadBreaches(other, withheld)).toEqual([]);
    }
  });

  it.each<[string, PushMessage, string]>([
    ["a message's text in the line", { ...clean, body: "Moi, nähdäänkö huomenna?" }, "text"],
    [
      "a message's text in the data",
      {
        ...clean,
        data: { ...clean.data, preview: "moi, NÄHDÄÄNKÖ huomenna?" } as unknown as PushData,
      },
      "text",
    ],
    ["a name in the line", { ...clean, body: "ILMATAR sent you a message" }, "name"],
    ["a name as a title", { ...clean, title: "Ilmatar" } as PushMessage, "name"],
    [
      "an account's id in the data",
      { ...clean, data: { ...clean.data, from: accountId } as unknown as PushData },
      "id",
    ],
    [
      "an account's id where a conversation was once named",
      { ...clean, data: { kind: "match", conversationId: accountId } as unknown as PushData },
      "id",
    ],
    [
      "the conversation's id in the data",
      { ...clean, data: { kind: "message", conversationId } as unknown as PushData },
      "conversation",
    ],
    [
      "the conversation's id as the collapse id and Android's tag",
      { ...clean, collapseId: conversationId, tag: conversationId.toUpperCase() },
      "conversation",
    ],
    ["a session's id as the collapse id", { ...clean, collapseId: sessionId }, "id"],
    ["a session's id as Android's tag", { ...clean, tag: sessionId.toUpperCase() }, "id"],
    [
      "an id the rule was not told of",
      { ...clean, data: { ...clean.data, photoId: randomUUID() } as unknown as PushData },
      "uuid",
    ],
  ])("fails a push with %s", (_, message, what) => {
    const breaches = payloadBreaches(message, withheld);
    expect(breaches.length).toBeGreaterThan(0);
    expect(
      breaches.some((breach) => breach.startsWith(`${what}:`)),
      breaches.join(),
    ).toBe(true);
  });

  it("reads past the address alone: the token is where the push goes, not what it says", () => {
    expect(payloadBreaches({ ...clean, to: `ExponentPushToken[${accountId}]` }, withheld)).toEqual(
      [],
    );
  });

  it("every push this file's scenes recorded held to it, with their people's real texts, names and ids", () => {
    // The scenes above ran first, in the order written; afterEach held each one's pushes to the rule.
    expect(held).toBeGreaterThan(40);
  });
});
