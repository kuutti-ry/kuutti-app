import { randomUUID } from "node:crypto";
import { ConversationDetail, ConversationList } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { type App, createApp } from "../app.ts";
import { applySanction } from "../safety/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { photoMessage, conversationBetween as writtenBetween } from "../test/chat.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { archiveSilentConversations } from "./archive.ts";
import { conversationBetween, conversationsOnTurn, openConversation } from "./conversations.ts";

// features/chat/your-turn.feature (#502, ADR-062 §5, §7): whose turn a
// conversation is, as the list's rows, the detail, the list's count and the like
// path's own read all say it, one answer or the test fails; what leaves the
// count; a shadow ban, which shows nothing; what a second match does to the
// conversation before it; and which conversation a like can be part of. The
// refusal at the limit is features/matching/matches.feature's.

/** 12:00 in Finland, a Friday. */
const T = new Date("2026-10-16T09:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(T.getTime() + ms);

type Person = { accountId: string; headers: Record<string, string> };

async function person(ctx: TestContext): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

/** An app on a clock the test moves, so what is said in a test falls in the order it is written. */
async function appAt(ctx: TestContext) {
  const clock = { at: T };
  const { logger } = await captureLogger();
  const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => clock.at });
  return { app, clock };
}

const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});

async function say(app: App, who: Person, id: string, body = "Hei") {
  const answer = await app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });
  expect(answer.status).toBe(201);
}

async function shareContact(app: App, who: Person, id: string) {
  const kept = await app.request("/contacts/instagram", {
    method: "PUT",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ value: "turn_test" }),
  });
  expect(kept.status).toBe(200);
  const shared = await app.request(`/conversations/${id}/contacts/instagram`, {
    method: "POST",
    headers: who.headers,
  });
  expect(shared.status).toBe(200);
}

async function listOf(app: App, who: Person, query = ""): Promise<ConversationList> {
  const answer = await app.request(`/conversations${query}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationList.parse(await answer.json());
}

/** The count, as the list says it and as the like path asks it: one answer. */
async function counted(ctx: TestContext, app: App, who: Person): Promise<number> {
  const { yourTurn } = await listOf(app, who);
  expect(await conversationsOnTurn(ctx.client, who.accountId)).toBe(yourTurn.waiting);
  return yourTurn.waiting;
}

/** Whether the conversation is the person's turn, as its row and its detail say it: one answer. */
async function turnOf(app: App, who: Person, id: string): Promise<boolean> {
  const { open, archived } = await listOf(app, who);
  const row = [...open, ...archived].find((conversation) => conversation.id === id);
  if (!row) throw new Error("no such row");
  const answer = await app.request(`/conversations/${id}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  expect(ConversationDetail.parse(await answer.json()).yourTurn).toBe(row.yourTurn);
  return row.yourTurn;
}

/** The share and the message stored straight, at the moment a test needs. */
async function sharedAt(ctx: TestContext, id: string, side: "a" | "b", kind: string, when: Date) {
  await ctx.client.query(
    "INSERT INTO contact_share (conversation_id, side, kind, shared_at) VALUES ($1, $2, $3, $4)",
    [id, side, kind, when],
  );
}

describe("whose turn it is", () => {
  test("A fresh match is both people's turn", async ({ ctx }) => {
    const { app } = await appAt(ctx);
    const [a, b] = [await person(ctx), await person(ctx)];
    const id = await openConversation(ctx.client, {
      first: a.accountId,
      second: b.accountId,
      at: T,
    });
    for (const who of [a, b]) {
      expect(await turnOf(app, who, id)).toBe(true);
      expect(await counted(ctx, app, who)).toBe(1);
    }
  });

  describe("The last thing said hands the turn to the other person", () => {
    const says = {
      "writes a message": (app: App, _ctx: TestContext, who: Person, id: string) =>
        say(app, who, id),
      "sends a photo": async (_app: App, ctx: TestContext, who: Person, id: string, side: string) =>
        void (await photoMessage(ctx.client, {
          conversationId: id,
          accountId: who.accountId,
          side: side as "a" | "b",
        })),
      "shares a contact": (app: App, _ctx: TestContext, who: Person, id: string) =>
        shareContact(app, who, id),
    } as const;

    test.for(Object.keys(says) as (keyof typeof says)[])("%s", async (what, { ctx }) => {
      const { app, clock } = await appAt(ctx);
      const [a, b] = [await person(ctx), await person(ctx)];
      const id = await writtenBetween(ctx.client, a.accountId, b.accountId, { openedAt: at(-DAY) });
      await says[what](app, ctx, a, id, "a");
      expect([await turnOf(app, a, id), await turnOf(app, b, id)]).toEqual([false, true]);
      expect([await counted(ctx, app, a), await counted(ctx, app, b)]).toEqual([0, 1]);
      clock.at = at(MINUTE);
      await says[what](app, ctx, b, id, "b");
      expect([await turnOf(app, a, id), await turnOf(app, b, id)]).toEqual([true, false]);
      expect([await counted(ctx, app, a), await counted(ctx, app, b)]).toEqual([1, 0]);
    });
  });

  test("The newer of a message and a shared contact decides, and at the same moment the message", async ({
    ctx,
  }) => {
    const { app, clock } = await appAt(ctx);
    const [a, b] = [await person(ctx), await person(ctx)];
    const id = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: at(-DAY),
      messages: [{ from: "a", body: "Hei", at: T }],
    });
    await sharedAt(ctx, id, "b", "instagram", T);
    expect(await turnOf(app, b, id)).toBe(true);
    await sharedAt(ctx, id, "b", "telegram", at(1));
    expect([await turnOf(app, a, id), await turnOf(app, b, id)]).toEqual([true, false]);
    clock.at = at(MINUTE);
    await say(app, a, id);
    expect([await turnOf(app, a, id), await turnOf(app, b, id)]).toEqual([false, true]);
  });

  test("An ended or an archived conversation leaves the count, and a message brings an archived one back", async ({
    ctx,
  }) => {
    const { app, clock } = await appAt(ctx);
    const [a, b, c] = [await person(ctx), await person(ctx), await person(ctx)];
    const ended = await writtenBetween(ctx.client, a.accountId, b.accountId, { openedAt: T });
    const silent = await writtenBetween(ctx.client, a.accountId, c.accountId, {
      openedAt: at(-30 * DAY),
    });
    expect([await counted(ctx, app, a), await counted(ctx, app, b)]).toEqual([2, 1]);

    const unmatched = await app.request(`/conversations/${ended}/unmatch`, {
      method: "POST",
      headers: a.headers,
    });
    expect(unmatched.status).toBe(204);
    const { logger } = await captureLogger();
    expect(await archiveSilentConversations({ db: ctx.client, logger, now: () => clock.at })).toBe(
      1,
    );

    for (const who of [a, b, c]) expect(await counted(ctx, app, who)).toBe(0);
    expect([await turnOf(app, a, ended), await turnOf(app, b, ended)]).toEqual([false, false]);
    expect([await turnOf(app, a, silent), await turnOf(app, c, silent)]).toEqual([false, false]);

    await say(app, c, silent);
    expect((await listOf(app, a)).open.map((conversation) => conversation.id)).toEqual([silent]);
    expect([await turnOf(app, a, silent), await turnOf(app, c, silent)]).toEqual([true, false]);
    expect([await counted(ctx, app, a), await counted(ctx, app, c)]).toEqual([1, 0]);
  });

  test("A shadow ban shows nothing in the count, either way", async ({ ctx }) => {
    const { app, clock } = await appAt(ctx);
    const [a, b, c] = [await person(ctx), await person(ctx), await person(ctx)];
    // One says A's last word stands to B, the other that C's stands to A.
    const onB = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: at(-DAY),
      messages: [{ from: "a", body: "Hei", at: at(-3 * MINUTE) }],
    });
    const onA = await writtenBetween(ctx.client, a.accountId, c.accountId, {
      openedAt: at(-DAY),
      messages: [{ from: "b", body: "Hei", at: at(-3 * MINUTE) }],
    });
    const before = [await turnOf(app, b, onB), await turnOf(app, c, onA)];
    expect(before).toEqual([true, false]);
    expect(await counted(ctx, app, a)).toBe(1);

    const ban = await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "commercial_use",
      note: "Sends the same link to everybody.",
      actor: null,
      at: at(-2 * MINUTE),
    });
    await say(app, a, onB);
    await say(app, a, onA);
    clock.at = at(MINUTE);
    await shareContact(app, a, onB);
    await shareContact(app, a, onA);

    // A reads both as answered, as anybody who wrote last does.
    expect([await turnOf(app, a, onB), await turnOf(app, a, onA)]).toEqual([false, false]);
    expect(await counted(ctx, app, a)).toBe(0);
    // B and C read each as it stood: nothing new is on their turn, and nothing left it.
    expect([await turnOf(app, b, onB), await turnOf(app, c, onA)]).toEqual(before);
    expect([await counted(ctx, app, b), await counted(ctx, app, c)]).toEqual([1, 0]);

    // Lifted, as the panel's lift writes it: both read what A said.
    await ctx.client.query("UPDATE sanction SET lifted_at = $2 WHERE id = $1", [
      ban.id,
      at(2 * MINUTE),
    ]);
    expect([await turnOf(app, b, onB), await turnOf(app, c, onA)]).toEqual([true, true]);
    expect([await counted(ctx, app, b), await counted(ctx, app, c)]).toEqual([1, 1]);
  });

  test("A blocked conversation is on nobody's turn", async ({ ctx }) => {
    const { app } = await appAt(ctx);
    const [a, b] = [await person(ctx), await person(ctx)];
    const id = await writtenBetween(ctx.client, a.accountId, b.accountId, { openedAt: T });
    await cardShown(ctx.client, a.accountId, b.accountId);
    const blocked = await app.request("/blocks", {
      method: "POST",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ accountId: b.accountId }),
    });
    expect(blocked.status).toBe(204);
    expect([await counted(ctx, app, a), await counted(ctx, app, b)]).toEqual([0, 0]);
    expect(await turnOf(app, b, id)).toBe(false);
    expect((await listOf(app, a)).archived).toEqual([]);
  });

  test("The list says each conversation's turn and the count against the limit", async ({
    ctx,
  }) => {
    const { app } = await appAt(ctx);
    const [a, b, c, d] = [
      await person(ctx),
      await person(ctx),
      await person(ctx),
      await person(ctx),
    ];
    const opened = { openedAt: at(-DAY) };
    const waiting = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      ...opened,
      messages: [{ from: "b", body: "Hei" }],
    });
    const answered = await writtenBetween(ctx.client, a.accountId, c.accountId, {
      ...opened,
      messages: [{ from: "a", body: "Hei" }],
    });
    const fresh = await writtenBetween(ctx.client, d.accountId, a.accountId, opened);
    for (const query of ["", "?thumbs=false"]) {
      const list = await listOf(app, a, query);
      expect(Object.fromEntries(list.open.map((row) => [row.id, row.yourTurn]))).toEqual({
        [waiting]: true,
        [answered]: false,
        [fresh]: true,
      });
      expect(list.yourTurn).toEqual({ waiting: 2, limit: 8, warning: 6 });
    }
    await withMatchingConfig(ctx.client, { your_turn_limit: 3, your_turn_warning: 2 });
    expect((await listOf(app, a)).yourTurn).toEqual({ waiting: 2, limit: 3, warning: 2 });
  });

  test("Another person's conversations are never counted", async ({ ctx }) => {
    const { app } = await appAt(ctx);
    const [a, b, c] = [await person(ctx), await person(ctx), await person(ctx)];
    await writtenBetween(ctx.client, a.accountId, b.accountId, { openedAt: T });
    expect(await counted(ctx, app, c)).toBe(0);
    expect((await listOf(app, c)).open).toEqual([]);
    expect(await conversationsOnTurn(ctx.client, randomUUID())).toBe(0);
  });
});

describe("a second match (ADR-062 §7)", () => {
  test("A second match closes the archived conversation between the two and ends what was shared in it", async ({
    ctx,
  }) => {
    const { app } = await appAt(ctx);
    const [a, b, c] = [await person(ctx), await person(ctx), await person(ctx)];
    const old = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: at(-30 * DAY),
      archivedAt: at(-7 * DAY),
    });
    await sharedAt(ctx, old, "a", "instagram", at(-29 * DAY));
    const beside = await writtenBetween(ctx.client, a.accountId, c.accountId, {
      openedAt: at(-30 * DAY),
      archivedAt: at(-7 * DAY),
    });

    const again = await openConversation(ctx.client, {
      first: b.accountId,
      second: a.accountId,
      at: T,
    });

    expect(again).not.toBe(old);
    const { rows } = await ctx.client.query(
      `SELECT id, closed_at, closed_how, archived_at FROM conversation WHERE id = ANY($1::uuid[])
        ORDER BY opened_at, id`,
      [[old, beside, again]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: old,
          closed_at: T,
          closed_how: "unmatch",
          archived_at: at(-7 * DAY),
        },
        { id: beside, closed_at: null, closed_how: null, archived_at: at(-7 * DAY) },
        { id: again, closed_at: null, closed_how: null, archived_at: null },
      ]),
    );
    const shares = await ctx.client.query(
      "SELECT ended_at, ended_how FROM contact_share WHERE conversation_id = $1",
      [old],
    );
    expect(shares.rows).toEqual([{ ended_at: T, ended_how: "closed" }]);
    const sides = await ctx.client.query(
      "SELECT account_id, side FROM conversation_participant WHERE conversation_id = $1 ORDER BY side",
      [again],
    );
    expect(sides.rows).toEqual([
      { account_id: b.accountId, side: "a" },
      { account_id: a.accountId, side: "b" },
    ]);
    // A pair has one conversation they can write in, and it waits on both.
    for (const who of [a, b]) {
      expect((await listOf(app, who)).open.map((row) => row.id)).toEqual([again]);
      expect(await counted(ctx, app, who)).toBe(1);
    }
    expect(await turnOf(app, a, old)).toBe(false);
    // Its close tells nobody anything as an unmatch does: no research event of it.
    const events = await ctx.client.query(
      "SELECT 1 FROM events WHERE name = 'conversation_closed'",
    );
    expect(events.rows).toEqual([]);
  });

  test("a conversation that ended before stays as its close left it", async ({ ctx }) => {
    const [a, b] = [await person(ctx), await person(ctx)];
    const old = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: at(-30 * DAY),
    });
    await ctx.client.query(
      "UPDATE conversation SET closed_at = $2, closed_how = 'erasure', closed_by = 'a' WHERE id = $1",
      [old, at(-DAY)],
    );
    await sharedAt(ctx, old, "a", "instagram", at(-29 * DAY));
    await openConversation(ctx.client, { first: a.accountId, second: b.accountId, at: T });
    const { rows } = await ctx.client.query(
      "SELECT closed_at, closed_how, closed_by FROM conversation WHERE id = $1",
      [old],
    );
    expect(rows).toEqual([{ closed_at: at(-DAY), closed_how: "erasure", closed_by: "a" }]);
    // Nothing is closed, so nothing is ended that the close before left standing.
    const shares = await ctx.client.query(
      "SELECT ended_at FROM contact_share WHERE conversation_id = $1",
      [old],
    );
    expect(shares.rows).toEqual([{ ended_at: null }]);
  });
});

describe("Which conversation a like can be part of", () => {
  /** The start of the Finnish day of T, which `Matches.between` is asked from. */
  const TODAY = new Date("2026-10-15T21:00:00.000Z");
  const LONG_AGO = at(-30 * DAY);

  test.for([
    ["open, opened long ago", { openedAt: LONG_AGO }, true],
    ["opened today and since ended", { openedAt: at(-MINUTE), closedAt: T }, true],
    ["opened today and since archived", { openedAt: at(-MINUTE), archivedAt: T }, true],
    ["opened at the very start of today", { openedAt: TODAY, closedAt: T }, true],
    ["opened long ago and ended", { openedAt: LONG_AGO, closedAt: at(-DAY) }, false],
    ["opened long ago and archived", { openedAt: LONG_AGO, archivedAt: at(-DAY) }, false],
    [
      "opened a moment before today, and ended",
      { openedAt: new Date(TODAY.getTime() - 1), closedAt: T },
      false,
    ],
  ] as const)("%s", async ([, shape, found], { ctx }) => {
    const [a, b] = [await person(ctx), await person(ctx)];
    const id = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: shape.openedAt,
      ...("archivedAt" in shape ? { archivedAt: shape.archivedAt } : {}),
    });
    if ("closedAt" in shape) {
      await ctx.client.query(
        "UPDATE conversation SET closed_at = $2, closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
        [id, shape.closedAt],
      );
    }
    // The same whichever of the two asks.
    const expected = found ? id : null;
    expect(await conversationBetween(ctx.client, a.accountId, b.accountId, TODAY)).toBe(expected);
    expect(await conversationBetween(ctx.client, b.accountId, a.accountId, TODAY)).toBe(expected);
  });

  test("the newest, of a match that ended today and the one after it, and nobody else's", async ({
    ctx,
  }) => {
    const [a, b, c] = [await person(ctx), await person(ctx), await person(ctx)];
    const ended = await writtenBetween(ctx.client, a.accountId, b.accountId, { openedAt: TODAY });
    await ctx.client.query(
      "UPDATE conversation SET closed_at = $2, closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
      [ended, at(-2 * MINUTE)],
    );
    const standing = await writtenBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: at(-MINUTE),
    });
    expect(await conversationBetween(ctx.client, a.accountId, b.accountId, TODAY)).toBe(standing);
    expect(await conversationBetween(ctx.client, a.accountId, c.accountId, TODAY)).toBeNull();
    expect(await conversationBetween(ctx.client, c.accountId, b.accountId, TODAY)).toBeNull();
  });
});
