import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  ChatMessage,
  ConversationDetail,
  ConversationList,
  ErrorResponse,
  MessagePage,
} from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import { ageInYears } from "../profile/index.ts";
import { applySanction } from "../safety/index.ts";
import { signInAs, staffSession, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween } from "../test/chat.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { type PeopleOptions, people } from "../test/people.ts";
import { archiveSilentConversations } from "./archive.ts";

// features/chat/conversations.feature (#348, ADR-031): the list, one
// conversation, its pages, the send with every refusal, the resend, the read
// mark, the block, the shadow ban, the ban, the limiter, the thumb, the
// events, and the text's absence from every log line.

// A marker of letters: a number can turn up in a log line's timestamp by chance.
const MARK = "qzxvkw";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Person = { accountId: string; headers: { authorization: string } };

/** A signed-in person with a complete profile under a name of their own. */
async function person(
  ctx: TestContext,
  name: string,
  options: PeopleOptions = {},
): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true, ...options });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

/** Several, one after another: one client takes one query at a time. */
async function peopleNamed(ctx: TestContext, names: string[]): Promise<Person[]> {
  const out: Person[] = [];
  for (const name of names) out.push(await person(ctx, name));
  return out;
}

const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
type App = ReturnType<typeof createApp>;
const send = (app: App, who: Person, id: string, body: string, clientId: string = randomUUID()) =>
  app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ clientId, body }),
  });
const markRead = (app: App, who: Person, id: string, upTo: unknown) =>
  app.request(`/conversations/${id}/read`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ upTo }),
  });
async function listOf(app: App, who: Person, query = ""): Promise<ConversationList> {
  const answer = await app.request(`/conversations${query}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationList.parse(await answer.json());
}
async function detailOf(app: App, who: Person, id: string): Promise<ConversationDetail> {
  const answer = await app.request(`/conversations/${id}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationDetail.parse(await answer.json());
}
async function pageOf(app: App, who: Person, id: string, query = ""): Promise<number[]> {
  const answer = await app.request(`/conversations/${id}/messages${query}`, {
    headers: who.headers,
  });
  expect(answer.status).toBe(200);
  return MessagePage.parse(await answer.json()).messages.map((m) => m.seq);
}
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;
const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
  Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
const messagesIn = (ctx: TestContext, id: string) =>
  count(ctx, "SELECT count(*) AS n FROM message WHERE conversation_id = $1", [id]);
const block = async (ctx: TestContext, blocker: Person, blocked: Person) => {
  await cardShown(ctx.client, blocker.accountId, blocked.accountId);
  const answer = await ctx.app.request("/blocks", {
    method: "POST",
    headers: jsonHeaders(blocker.headers),
    body: JSON.stringify({ accountId: blocked.accountId }),
  });
  expect(answer.status).toBe(204);
};
const giveResearchConsent = async (ctx: TestContext, who: Person) => {
  const answer = await ctx.app.request("/consents", {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({
      kind: "research",
      version: CURRENT_CONSENT_VERSIONS.research,
      locale: "fi",
    }),
  });
  expect(answer.status).toBe(200);
};
const silent = () => captureLogger().then(({ logger }) => logger);

/** An app with object storage and URL signing, so the list signs thumbs (#48). */
async function appWithMedia(ctx: TestContext, db: Queryable = ctx.client) {
  const { logger, lines } = await captureLogger();
  return {
    app: createApp({ config: testConfig(), logger, db, media: testMediaDeps().deps }),
    lines,
  };
}

/**
 * The test's transaction with another request's work slipped in once, just
 * before the first statement matching the pattern, as if a concurrent request
 * had committed at that point (identity/races.test.ts does the same).
 */
function interleaved(
  db: Queryable,
  before: RegExp,
  other: () => Promise<unknown>,
): Queryable & { ran: () => boolean } {
  let ran = false;
  return {
    ran: () => ran,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      if (!ran && before.test(text)) {
        ran = true;
        await other();
      }
      return db.query<R>(text, values);
    },
  };
}

describe("the list and one conversation", () => {
  test("The list shows each conversation with its counterpart, the last message and the unread count", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const long = `${"Moi! ".repeat(20)}${MARK}`;
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "b", body: "Hei Aino" },
        { from: "b", body: long },
      ],
    });
    expect((await markRead(ctx.app, a, id, 1)).status).toBe(204);
    const { app } = await appWithMedia(ctx);
    const answer = await app.request("/conversations", { headers: a.headers });
    const raw = await answer.text();
    const list = ConversationList.parse(JSON.parse(raw));
    expect(list.archived).toEqual([]);
    const [row] = list.open;
    expect(row).toMatchObject({
      id,
      state: "open",
      closedHow: null,
      counterpart: { deleted: false, name: "Bea", age: ageInYears(1990, 6, new Date()) },
      lastMessage: { kind: "text", side: "theirs", preview: [...long].slice(0, 80).join("") },
      unread: 1,
    });
    const main = await ctx.client.query<{ id: string }>(
      "SELECT id FROM photo WHERE account_id = $1 AND position = 0",
      [b.accountId],
    );
    expect(row?.counterpart).toMatchObject({ thumb: { photoId: main.rows[0]?.id } });
    expect(raw).not.toContain(b.accountId);
    // The preview is the first eighty characters, never the whole.
    expect(raw).not.toContain(MARK);
  });

  test("The list puts open conversations first and the archived and closed ones after, each newest first", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const [b, c, d, e] = await peopleNamed(ctx, ["Bea", "Cia", "Dan", "Eli"]);
    if (!b || !c || !d || !e) throw new Error("people");
    const now = Date.now();
    const withB = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(now - 5 * HOUR),
      messages: [{ from: "b", body: "Hei", at: new Date(now - HOUR / 2) }],
    });
    const withC = await conversationBetween(ctx.client, c.accountId, a.accountId, {
      openedAt: new Date(now - HOUR / 6),
    });
    const withD = await conversationBetween(ctx.client, a.accountId, d.accountId, {
      openedAt: new Date(now - 20 * DAY),
      messages: [{ from: "a", body: "Hei", at: new Date(now - 9 * DAY) }],
      archivedAt: new Date(now - DAY),
    });
    const withE = await conversationBetween(ctx.client, a.accountId, e.accountId, {
      openedAt: new Date(now - 2 * DAY),
      messages: [{ from: "b", body: "Hei", at: new Date(now - DAY) }],
    });
    await ctx.client.query(
      "UPDATE conversation SET closed_at = now(), closed_how = 'unmatch', closed_by = 'b' WHERE id = $1",
      [withE],
    );
    const list = await listOf(ctx.app, a);
    expect(list.open.map((s) => s.id)).toEqual([withC, withB]);
    expect(list.archived.map((s) => [s.id, s.state, s.closedHow])).toEqual([
      [withE, "closed", "unmatch"],
      [withD, "archived", null],
    ]);
  });

  test("One conversation gives the composer its limit and the other side's read mark", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "a", body: "Hei" },
        { from: "a", body: "Mitä kuuluu?" },
        { from: "a", body: "Ja sitten" },
      ],
    });
    expect((await markRead(ctx.app, b, id, 2)).status).toBe(204);
    const detail = await detailOf(ctx.app, a, id);
    expect(detail).toMatchObject({
      id,
      state: "open",
      limits: { maxLength: 2000 },
      counterpartReadUpTo: 2,
      counterpart: { deleted: false, name: "Bea", thumb: null },
    });
    // The other side's view: nothing of theirs is unread, and A has read nothing.
    expect((await detailOf(ctx.app, b, id)).counterpartReadUpTo).toBe(0);
  });
});

describe("the send", () => {
  test("A message is sent with the next sequence, and brings an archived conversation back", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(Date.now() - 30 * DAY),
      messages: [
        { from: "a", body: "Hei", at: new Date(Date.now() - 20 * DAY) },
        { from: "b", body: "Moi", at: new Date(Date.now() - 19 * DAY) },
      ],
      archivedAt: new Date(Date.now() - 10 * DAY),
    });
    expect((await detailOf(ctx.app, a, id)).state).toBe("archived");
    const before = Date.now();
    const answer = await send(ctx.app, a, id, "  Pitkästä aikaa  ");
    expect(answer.status).toBe(201);
    const message = ChatMessage.parse(await answer.json());
    expect(message).toMatchObject({ seq: 3, side: "mine", kind: "text", body: "Pitkästä aikaa" });
    expect(Date.parse(message.createdAt)).toBeGreaterThanOrEqual(before - 1000);
    const detail = await detailOf(ctx.app, a, id);
    expect(detail.state).toBe("open");
    expect(detail.lastMessage).toMatchObject({ preview: "Pitkästä aikaa", side: "mine" });
    const theirs = await listOf(ctx.app, b);
    expect(theirs.open[0]).toMatchObject({ id, unread: 2, lastMessage: { side: "theirs" } });
    const row = await ctx.client.query<{ next_seq: number; archived_at: Date | null }>(
      "SELECT next_seq, archived_at FROM conversation WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({ next_seq: 4, archived_at: null });
  });

  test("A resend with the same client id returns the stored message and writes nothing", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const clientId = randomUUID();
    const first = await send(ctx.app, a, id, "Nähdäänkö lauantaina?", clientId);
    expect(first.status).toBe(201);
    const stored = ChatMessage.parse(await first.json());
    // The answer was lost; the phone sends the same message again.
    const again = await send(ctx.app, a, id, "Nähdäänkö lauantaina?", clientId);
    expect(again.status).toBe(200);
    expect(ChatMessage.parse(await again.json())).toEqual(stored);
    expect(await messagesIn(ctx, id)).toBe(1);
    // An id the other side used is not B's to resend: refused, nothing written.
    const foreign = await send(ctx.app, b, id, "Joo", clientId);
    expect(foreign.status).toBe(400);
    expect(await errorCode(foreign)).toBe("validation_failed");
    expect(await messagesIn(ctx, id)).toBe(1);
  });

  test("Two sends at once take consecutive sequences without a gap", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    // B's send runs whole just before A's insert, after A read what it decides on.
    let theirs: Response | undefined;
    const db = interleaved(ctx.client, /WITH bumped AS/, async () => {
      theirs = await send(ctx.app, b, id, "Moi");
    });
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db });
    const mine = await send(app, a, id, "Mitä kuuluu?");
    expect(db.ran()).toBe(true);
    expect(theirs?.status).toBe(201);
    expect(mine.status).toBe(201);
    expect(ChatMessage.parse(await theirs?.json()).seq).toBe(2);
    expect(ChatMessage.parse(await mine.json()).seq).toBe(3);
    const seqs = await ctx.client.query<{ seq: number }>(
      "SELECT seq FROM message WHERE conversation_id = $1 ORDER BY seq",
      [id],
    );
    expect(seqs.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  describe("A send is refused in words and writes nothing", () => {
    test.for([
      ["empty after trimming", 400, "validation_failed"],
      ["over message_max_length after trimming", 400, "message_too_long"],
      ["carrying a phone number", 400, "contact_details"],
      ["in a conversation that closed", 409, "conversation_closed"],
      ["to somebody a block stands between", 409, "conversation_closed"],
      ["to somebody who deleted their account", 409, "conversation_closed"],
    ] as const)("%s", async ([kase, status, code], { ctx }) => {
      const a = await person(ctx, "Aino");
      const b = await person(ctx, "Bea");
      const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
      let body = "Hei, mitä kuuluu?";
      switch (kase) {
        case "empty after trimming":
          body = " \n\t ";
          break;
        case "over message_max_length after trimming":
          await withMatchingConfig(ctx.client, { message_max_length: 10 });
          // Ten characters pass, an emoji counted as one; eleven do not.
          expect((await send(ctx.app, a, id, "  Moi 😀 Bea!  ")).status).toBe(201);
          await ctx.client.query("DELETE FROM message WHERE conversation_id = $1", [id]);
          body = "Moi 😀 Beaa!";
          break;
        case "carrying a phone number":
          body = "Soita 040 123 4567";
          break;
        case "in a conversation that closed":
          await ctx.client.query(
            "UPDATE conversation SET closed_at = now(), closed_how = 'unmatch', closed_by = 'b' WHERE id = $1",
            [id],
          );
          break;
        case "to somebody a block stands between":
          await block(ctx, b, a);
          break;
        case "to somebody who deleted their account":
          await eraseAccount(
            { db: ctx.client, logger: await silent(), now: () => new Date() },
            b.accountId,
          );
          break;
      }
      const answer = await send(ctx.app, a, id, body);
      expect(answer.status).toBe(status);
      expect(await errorCode(answer)).toBe(code);
      expect(await messagesIn(ctx, id)).toBe(0);
    });
  });

  test("A block that lands while a message is in flight refuses it", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await cardShown(ctx.client, b.accountId, a.accountId);
    // B's block commits after A's send has locked the row and before it reads what it decides on.
    const db = interleaved(ctx.client, /AS hidden/, async () => {
      const blocked = await ctx.app.request("/blocks", {
        method: "POST",
        headers: jsonHeaders(b.headers),
        body: JSON.stringify({ accountId: a.accountId }),
      });
      expect(blocked.status).toBe(204);
    });
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db });
    const answer = await send(app, a, id, "Oletko siellä?");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("conversation_closed");
    expect(await messagesIn(ctx, id)).toBe(0);
  });

  test("The messages of a minute are counted per account, and a new number holds from the next request", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { messages_per_minute: 2 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await send(ctx.app, a, id, "Yksi")).status).toBe(201);
    expect((await send(ctx.app, a, id, "Kaksi")).status).toBe(201);
    const third = await send(ctx.app, a, id, "Kolme");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await errorCode(third)).toBe("message_budget_exceeded");
    // Reading is not sending: the page shares the path and is not counted.
    expect(await pageOf(ctx.app, a, id)).toEqual([2, 1]);
    // B's minute is B's own.
    expect((await send(ctx.app, b, id, "Moi")).status).toBe(201);
    // The refused one was counted too; a number above the count lets the next one through.
    await withMatchingConfig(ctx.client, { messages_per_minute: 4 });
    expect((await send(ctx.app, a, id, "Kolme")).status).toBe(201);
    const refused = ctx.logs().filter((l) => l.msg === "message refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ accountId: a.accountId, limiter: "messages_per_minute" });
    expect(JSON.stringify(refused)).not.toContain("account:");
  });
});

describe("the pages and the read mark", () => {
  test("The history pages back and the resume reads onward", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: ["Yksi", "Kaksi", "Kolme", "Neljä", "Viisi"].map((body, i) => ({
        from: i % 2 === 0 ? ("a" as const) : ("b" as const),
        body,
      })),
    });
    expect(await pageOf(ctx.app, a, id, "?limit=2")).toEqual([5, 4]);
    expect(await pageOf(ctx.app, a, id, "?before=4&limit=2")).toEqual([3, 2]);
    expect(await pageOf(ctx.app, a, id, "?after=2")).toEqual([3, 4, 5]);
    expect(await pageOf(ctx.app, a, id, "?before=1")).toEqual([]);
    expect(await pageOf(ctx.app, a, id, "?after=5")).toEqual([]);
    expect(await pageOf(ctx.app, a, id)).toEqual([5, 4, 3, 2, 1]);
    const page = MessagePage.parse(
      await (
        await ctx.app.request(`/conversations/${id}/messages?after=3`, { headers: b.headers })
      ).json(),
    );
    expect(page.messages.map((m) => [m.seq, m.side, m.body])).toEqual([
      [4, "mine", "Neljä"],
      [5, "theirs", "Viisi"],
    ]);
    for (const query of ["?before=4&after=1", "?limit=0", "?limit=101", "?before=-1", "?since=2"]) {
      const answer = await ctx.app.request(`/conversations/${id}/messages${query}`, {
        headers: a.headers,
      });
      expect(answer.status, query).toBe(400);
      expect(await errorCode(answer)).toBe("validation_failed");
    }
  });

  test("The read mark goes up, never down, and never past the newest message", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "b", body: "Yksi" },
        { from: "b", body: "Kaksi" },
        { from: "b", body: "Kolme" },
      ],
    });
    const mark = async () =>
      (
        await ctx.client.query<{ read_up_to: number }>(
          "SELECT read_up_to FROM conversation_participant WHERE account_id = $1 AND conversation_id = $2",
          [a.accountId, id],
        )
      ).rows[0]?.read_up_to;
    expect((await markRead(ctx.app, a, id, 2)).status).toBe(204);
    expect(await mark()).toBe(2);
    expect((await listOf(ctx.app, a)).open[0]?.unread).toBe(1);
    expect((await markRead(ctx.app, a, id, 1)).status).toBe(204);
    expect(await mark()).toBe(2);
    expect((await markRead(ctx.app, a, id, 10)).status).toBe(204);
    expect(await mark()).toBe(3);
    expect((await listOf(ctx.app, a)).open[0]?.unread).toBe(0);
    for (const upTo of [-1, 1.5, "2", null]) {
      const answer = await markRead(ctx.app, a, id, upTo);
      expect(answer.status, String(upTo)).toBe(400);
    }
    expect(await mark()).toBe(3);
  });
});

describe("who may reach a conversation", () => {
  test("A conversation the caller is not in answers 404 from every route", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    expect(await listOf(ctx.app, c)).toEqual({ open: [], archived: [] });
    for (const target of [id, randomUUID()]) {
      const answers = [
        await ctx.app.request(`/conversations/${target}`, { headers: c.headers }),
        await ctx.app.request(`/conversations/${target}/messages`, { headers: c.headers }),
        await send(ctx.app, c, target, "Hei vaan"),
        await markRead(ctx.app, c, target, 1),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(await errorCode(answer)).toBe("not_found");
      }
    }
    expect(await messagesIn(ctx, id)).toBe(1);
    const read = await ctx.client.query<{ read_up_to: number }>(
      "SELECT read_up_to FROM conversation_participant WHERE conversation_id = $1 ORDER BY side",
      [id],
    );
    expect(read.rows.map((r) => r.read_up_to)).toEqual([0, 0]);
    // A malformed id is the contract's.
    const malformed = await ctx.app.request("/conversations/not-a-uuid", { headers: c.headers });
    expect(malformed.status).toBe(400);
  });

  test("The chat routes refuse without a session", async ({ ctx }) => {
    const staff = await staffSession(ctx.client, "admin");
    const id = randomUUID();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/conversations"],
      ["GET", `/conversations/${id}`],
      ["GET", `/conversations/${id}/messages`],
      ["POST", `/conversations/${id}/messages`, { clientId: randomUUID(), body: "Hei" }],
      ["POST", `/conversations/${id}/read`, { upTo: 1 }],
    ];
    const nobody = "x".repeat(43);
    for (const [method, path, body] of routes) {
      for (const headers of [{}, { authorization: `Bearer ${nobody}` }, staff.headers] as Record<
        string,
        string
      >[]) {
        const answer = await ctx.app.request(path, {
          method,
          headers: jsonHeaders(headers),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(answer.status, `${method} ${path}`).toBe(401);
        expect(await errorCode(answer)).toBe("unauthenticated");
      }
    }
  });

  test("A block hides the conversation from its blocker and ends it for the other", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Hei" }],
    });
    await block(ctx, a, b);
    expect(await listOf(ctx.app, a)).toEqual({ open: [], archived: [] });
    for (const answer of [
      await ctx.app.request(`/conversations/${id}`, { headers: a.headers }),
      await ctx.app.request(`/conversations/${id}/messages`, { headers: a.headers }),
      await send(ctx.app, a, id, "Hei"),
      await markRead(ctx.app, a, id, 1),
    ]) {
      expect(answer.status).toBe(404);
    }
    const answer = await ctx.app.request("/conversations", { headers: b.headers });
    const raw = await answer.text();
    const theirs = ConversationList.parse(JSON.parse(raw));
    expect(theirs.open).toEqual([]);
    expect(theirs.archived).toEqual([
      expect.objectContaining({ id, state: "closed", closedHow: "unmatch" }),
    ]);
    expect(raw).not.toMatch(/block/i);
    const refused = await send(ctx.app, b, id, "Miksi?");
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("conversation_closed");
    // B still reads what was said.
    expect(await pageOf(ctx.app, b, id)).toEqual([1]);
  });

  test("A shadow-banned sender's messages are withheld from the counterpart until the ban is lifted", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // The app's clock, so the first message is before the ban and the second after it.
    let clock = new Date();
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => clock });
    expect((await send(app, a, id, "Ensimmäinen")).status).toBe(201);
    clock = new Date(clock.getTime() + 60_000);
    const ban = await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "commercial_use",
      note: "Sends the same link to everybody.",
      actor: null,
      at: clock,
    });
    clock = new Date(clock.getTime() + 60_000);
    // Nothing tells A: the send answers as always.
    expect((await send(app, a, id, `Toinen ${MARK}`)).status).toBe(201);
    expect(await pageOf(ctx.app, a, id)).toEqual([2, 1]);
    expect(await pageOf(ctx.app, b, id)).toEqual([1]);
    const theirs = await listOf(ctx.app, b);
    expect(theirs.open[0]).toMatchObject({ unread: 1, lastMessage: { preview: "Ensimmäinen" } });
    expect(JSON.stringify(theirs)).not.toContain(MARK);
    // Lifted, as the panel's lift writes it.
    await ctx.client.query("UPDATE sanction SET lifted_at = now() WHERE id = $1", [ban.id]);
    expect(await pageOf(ctx.app, b, id)).toEqual([2, 1]);
    expect((await listOf(ctx.app, b)).open[0]?.unread).toBe(2);
  });

  test("A ban closes the person's conversations, and a suspension closes none", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    // With the research consent, so an event would be written if a ban wrote one.
    await giveResearchConsent(ctx, b);
    const withB = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const withC = await conversationBetween(ctx.client, c.accountId, a.accountId);
    const sanction = (kind: "suspend" | "ban") =>
      applySanction(ctx.client, {
        accountId: a.accountId,
        kind,
        reason: "harassment",
        note: "Threatening messages.",
        ...(kind === "suspend"
          ? { endsOn: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10) }
          : {}),
        actor: null,
        at: new Date(),
      });
    const closedOf = async () =>
      (
        await ctx.client.query<{ id: string; closed_how: string | null; closed_by: string | null }>(
          "SELECT id, closed_how, closed_by FROM conversation WHERE id = ANY($1) ORDER BY id",
          [[withB, withC]],
        )
      ).rows;
    await sanction("suspend");
    expect((await closedOf()).every((r) => r.closed_how === null)).toBe(true);
    await sanction("ban");
    const closed = await closedOf();
    expect(closed.map((r) => r.closed_how)).toEqual(["sanction", "sanction"]);
    // The banned person's side: a in one, b in the other.
    expect(Object.fromEntries(closed.map((r) => [r.id, r.closed_by]))).toEqual({
      [withB]: "a",
      [withC]: "b",
    });
    for (const [who, id] of [
      [b, withB],
      [c, withC],
    ] as const) {
      expect((await listOf(ctx.app, who)).archived).toEqual([
        expect.objectContaining({ id, state: "closed", closedHow: "unmatch" }),
      ]);
      expect((await send(ctx.app, who, id, "Hei?")).status).toBe(409);
    }
    // No research event says that a ban ended them (ADR-024).
    expect(
      await count(ctx, "SELECT count(*) AS n FROM events WHERE name = 'conversation_closed'"),
    ).toBe(0);
  });

  test("a blocker never sees the conversation again, after a ban, a block and the other's erasure", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const at = new Date();
    await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "ban",
      reason: "harassment",
      note: "Threats.",
      actor: null,
      at,
    });
    // B blocks A afterwards, from a card shown earlier, and A's account is then erased.
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT y.identity_id, x.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
      [a.accountId, b.accountId],
    );
    expect(await listOf(ctx.app, b)).toEqual({ open: [], archived: [] });
    await eraseAccount({ db: ctx.client, logger: await silent(), now: () => at }, a.accountId);
    expect(await listOf(ctx.app, b)).toEqual({ open: [], archived: [] });
    const row = await ctx.client.query<{ closed_how: string; closed_by: string }>(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({ closed_how: "block", closed_by: "b" });
  });

  test("a send already past the guard writes nothing once a suspension lands", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const db = interleaved(ctx.client, /FOR SHARE OF a/, () =>
      applySanction(ctx.client, {
        accountId: a.accountId,
        kind: "suspend",
        reason: "harassment",
        note: "A week out.",
        endsOn: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10),
        actor: null,
        at: new Date(),
      }),
    );
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db });
    const answer = await send(app, a, id, "Hei");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await messagesIn(ctx, id)).toBe(0);
  });
});

describe("the night's archive", () => {
  test("The night archives a silent conversation and leaves one with a recent message", async ({
    ctx,
  }) => {
    const now = new Date();
    const [a, b, c, d, e] = await peopleNamed(ctx, ["Aino", "Bea", "Cia", "Dan", "Eli"]);
    if (!a || !b || !c || !d || !e) throw new Error("people");
    await giveResearchConsent(ctx, a);
    const silentOne = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(now.getTime() - 20 * DAY),
      messages: [{ from: "a", body: "Hei", at: new Date(now.getTime() - 8 * DAY) }],
    });
    const neverWritten = await conversationBetween(ctx.client, a.accountId, c.accountId, {
      openedAt: new Date(now.getTime() - 8 * DAY),
    });
    const recent = await conversationBetween(ctx.client, a.accountId, d.accountId, {
      openedAt: new Date(now.getTime() - 20 * DAY),
      messages: [{ from: "b", body: "Hei", at: new Date(now.getTime() - DAY) }],
    });
    const closed = await conversationBetween(ctx.client, a.accountId, e.accountId, {
      openedAt: new Date(now.getTime() - 40 * DAY),
    });
    await ctx.client.query(
      "UPDATE conversation SET closed_at = $2, closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
      [closed, new Date(now.getTime() - 30 * DAY)],
    );
    const events = () =>
      ctx.client.query<{ props: unknown }>(
        "SELECT props FROM events WHERE name = 'conversation_archived' ORDER BY props->>'days'",
      );
    expect((await events()).rows).toEqual([]);
    const archived = await archiveSilentConversations({
      db: ctx.client,
      logger: await silent(),
      now: () => now,
    });
    expect(archived).toBe(2);
    const rows = await ctx.client.query<{ id: string; archived_at: Date | null }>(
      "SELECT id, archived_at FROM conversation WHERE id = ANY($1)",
      [[silentOne, neverWritten, recent, closed]],
    );
    const archivedAt = Object.fromEntries(rows.rows.map((r) => [r.id, r.archived_at]));
    expect(archivedAt[silentOne]).toEqual(now);
    expect(archivedAt[neverWritten]).toEqual(now);
    expect(archivedAt[recent]).toBeNull();
    expect(archivedAt[closed]).toBeNull();
    // A's two archives; nobody else gave the consent.
    expect((await events()).rows.map((r) => r.props)).toEqual([
      { messages: "1-5", days: "14-29" },
      { messages: "0", days: "7-13" },
    ]);
    // A second night finds nothing more.
    expect(
      await archiveSilentConversations({ db: ctx.client, logger: await silent(), now: () => now }),
    ).toBe(0);
  });

  test("A break stops no clock", async ({ ctx }) => {
    const now = new Date();
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(now.getTime() - 8 * DAY),
    });
    await ctx.client.query(
      "UPDATE account SET state = 'paused', paused_from = 'active' WHERE id = $1",
      [a.accountId],
    );
    await archiveSilentConversations({ db: ctx.client, logger: await silent(), now: () => now });
    const row = await ctx.client.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM conversation WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.archived_at).toEqual(now);
  });
});

describe("the thumb", () => {
  test("The list's thumb is logged as a fetch and never counted as a card", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    await conversationBetween(ctx.client, a.accountId, b.accountId);
    const { app, lines } = await appWithMedia(ctx);
    const fetches = () =>
      count(
        ctx,
        "SELECT count(*) AS n FROM photo_access WHERE account_id = $1 AND variant = 'thumb'",
        [a.accountId],
      );
    const thumbOf = async (query = "") => {
      const list = await listOf(app, a, query);
      const [row] = [...list.open, ...list.archived];
      return row?.counterpart.deleted === false ? row.counterpart.thumb : undefined;
    };
    const main = await ctx.client.query<{ id: string }>(
      "SELECT id FROM photo WHERE account_id = $1 AND position = 0",
      [b.accountId],
    );
    const thumb = await thumbOf();
    expect(thumb).toMatchObject({ photoId: main.rows[0]?.id });
    expect(thumb?.url).toMatch(/^https:\/\//);
    expect(await fetches()).toBe(1);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM card_shown WHERE account_id = $1", [a.accountId]),
    ).toBe(0);
    expect(lines().some((l) => l.msg === "photo url issued" && l.variant === "thumb")).toBe(true);
    // Without thumbs, nothing is signed or spent.
    expect(await thumbOf("?thumbs=false")).toBeNull();
    expect(await fetches()).toBe(1);
    expect((await app.request("/conversations?thumbs=no", { headers: a.headers })).status).toBe(
      400,
    );

    // B on a break: no thumb; back: the thumb again.
    await ctx.client.query("UPDATE account SET state = 'paused' WHERE id = $1", [b.accountId]);
    expect(await thumbOf()).toBeNull();
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [b.accountId]);
    expect(await thumbOf()).not.toBeNull();
    // The day's thumbs spent: none, and the refusal leaves its line.
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 1, card: 300, full: 60 },
    });
    expect(await thumbOf()).toBeNull();
    expect(lines().some((l) => l.msg === "photo refused" && l.reason === "budget")).toBe(true);
    await withMatchingConfig(ctx.client, {
      photo_fetches_per_day: { thumb: 600, card: 300, full: 60 },
    });
    // B blocks A: the conversation ends for A, with no thumb.
    await block(ctx, b, a);
    expect(await thumbOf()).toBeNull();

    // C banned: the conversation closes, with no thumb.
    const other = await person(ctx, "Dan");
    await conversationBetween(ctx.client, other.accountId, c.accountId);
    await applySanction(ctx.client, {
      accountId: c.accountId,
      kind: "ban",
      reason: "harassment",
      note: "Threats.",
      actor: null,
      at: new Date(),
    });
    const list = await listOf(app, other);
    expect(list.archived[0]?.counterpart).toMatchObject({
      deleted: false,
      name: "Cia",
      thumb: null,
    });
    // Lifted, C is active again; the ended conversation still shows no photo (ADR-024 §6).
    await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [c.accountId]);
    expect((await listOf(app, other)).archived[0]?.counterpart).toMatchObject({ thumb: null });
  });
});

describe("what a message tells, and to whom", () => {
  test("Each send, archive and close is a research event with no text", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    await giveResearchConsent(ctx, a);
    await giveResearchConsent(ctx, b);
    const opened = new Date(Date.now() - 2 * DAY);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: opened,
    });
    expect((await send(ctx.app, a, id, `Hei ${MARK}`)).status).toBe(201);
    expect((await send(ctx.app, a, id, `${"Pitkä viesti. ".repeat(10)}${MARK}`)).status).toBe(201);
    await archiveSilentConversations({
      db: ctx.client,
      logger: await silent(),
      now: () => new Date(Date.now() + 9 * DAY),
    });
    await eraseAccount(
      { db: ctx.client, logger: await silent(), now: () => new Date() },
      b.accountId,
    );
    const events = await ctx.client.query<{ name: string; props: unknown; snapshot: unknown }>(
      `SELECT name, props, snapshot FROM events
       WHERE name IN ('message_sent', 'conversation_archived', 'conversation_closed')
       ORDER BY name, props->>'firstInConversation' DESC`,
    );
    expect(events.rows.map((r) => [r.name, r.props])).toEqual([
      ["conversation_archived", { messages: "1-5", days: "7-13" }],
      ["conversation_archived", { messages: "1-5", days: "7-13" }],
      ["conversation_closed", { how: "erasure", messages: "1-5" }],
      [
        "message_sent",
        {
          kind: "text",
          length: "1-20",
          firstInConversation: true,
          sinceOpened: "1d_7d",
          sincePrevious: null,
        },
      ],
      [
        "message_sent",
        {
          kind: "text",
          length: "81-280",
          firstInConversation: false,
          sinceOpened: "1d_7d",
          sincePrevious: "under_1m",
        },
      ],
    ]);
    expect(JSON.stringify(events.rows)).not.toContain(MARK);
  });

  test("no message text reaches a log line, an error detail or an error report", async ({
    ctx,
  }) => {
    const reports: unknown[] = [];
    const { logger, lines } = await captureLogger();
    await withMatchingConfig(ctx.client, { message_max_length: 40, messages_per_minute: 7 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // The insert fails once, unhandled, the way a database fault would.
    let failed = false;
    const db: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        if (!failed && /WITH bumped AS/.test(text)) {
          failed = true;
          throw new Error("Connection terminated unexpectedly");
        }
        return ctx.client.query<R>(text, values);
      },
    };
    const app = createApp({
      config: testConfig(),
      logger,
      db,
      report: (error, context) => reports.push({ error: String(error), context }),
    });
    const clientId = randomUUID();
    const statuses = [
      (await send(app, a, id, `Hei ${MARK}`)).status,
      (await send(app, a, id, `Hei ${MARK}`, clientId)).status,
      (await send(app, a, id, `Hei ${MARK}`, clientId)).status,
      (await send(app, a, id, `${MARK} ${"x".repeat(60)}`)).status,
      (await send(app, a, id, `${MARK} soita 040 123 4567`)).status,
      (await send(app, a, id, `${MARK} ${"y".repeat(20_000)}`)).status,
    ];
    await ctx.client.query(
      "UPDATE conversation SET closed_at = now(), closed_how = 'unmatch', closed_by = 'b' WHERE id = $1",
      [id],
    );
    statuses.push((await send(app, a, id, `Hei ${MARK}`)).status);
    statuses.push((await send(app, a, id, `Hei ${MARK}`)).status);
    expect(statuses).toEqual([500, 201, 200, 400, 400, 400, 409, 429]);
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(lines())).not.toContain(MARK);
    // The refusal names the kind it found, never the text.
    expect(lines().some((l) => (l.detail as { kind?: string } | undefined)?.kind === "phone")).toBe(
      true,
    );
    expect(JSON.stringify(reports)).not.toContain(MARK);
  });
});
