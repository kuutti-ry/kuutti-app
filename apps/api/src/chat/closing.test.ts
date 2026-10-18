import { randomUUID } from "node:crypto";
import { ConversationDetail, ConversationList, ErrorResponse, MessagePage } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import { signInAs } from "../test/account.ts";
import { conversationBetween, interleaved } from "../test/chat.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { people } from "../test/people.ts";

// features/chat/closing.feature (#351): the unmatch, which ends a
// conversation for both and blocks nobody; the ended conversation as both
// read it, naming nobody before and after either person's erasure (ADR-031
// Open 10); the shares a close ends; the one research event; and who may ask.

type Person = { accountId: string; headers: Record<string, string> };
type App = ReturnType<typeof createApp>;

async function person(ctx: TestContext, name: string): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const unmatch = (app: App, who: { headers: Record<string, string> }, id: string) =>
  app.request(`/conversations/${id}/unmatch`, { method: "POST", headers: who.headers });
const blockFrom = (app: App, who: Person, id: string) =>
  app.request(`/conversations/${id}/block`, { method: "POST", headers: who.headers });
const send = (app: App, who: Person, id: string, body: string) =>
  app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;
const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
  Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
async function listOf(app: App, who: Person): Promise<ConversationList> {
  const answer = await app.request("/conversations", { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationList.parse(await answer.json());
}
async function detailOf(app: App, who: Person, id: string): Promise<ConversationDetail> {
  const answer = await app.request(`/conversations/${id}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationDetail.parse(await answer.json());
}
async function pageOf(app: App, who: Person, id: string): Promise<MessagePage> {
  const answer = await app.request(`/conversations/${id}/messages`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return MessagePage.parse(await answer.json());
}

describe("ending a conversation", () => {
  test("An unmatch closes the conversation for both and blocks nobody", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    expect((await unmatch(ctx.app, a, id)).status).toBe(204);
    expect((await unmatch(ctx.app, a, id)).status).toBe(204);
    for (const who of [a, b]) {
      const list = await listOf(ctx.app, who);
      expect(list.open).toEqual([]);
      expect(list.archived).toEqual([
        expect.objectContaining({ id, state: "closed", closedHow: "unmatch", counterpart: null }),
      ]);
      const refused = await send(ctx.app, who, id, "Hei?");
      expect(refused.status).toBe(409);
      expect(await errorCode(refused)).toBe("conversation_closed");
      // The words stay for both.
      expect((await pageOf(ctx.app, who, id)).messages.map((m) => m.seq)).toEqual([1]);
    }
    expect(await count(ctx, "SELECT count(*) AS n FROM block")).toBe(0);
    const closed = await ctx.client.query(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [id],
    );
    expect(closed.rows).toEqual([{ closed_how: "unmatch", closed_by: "a" }]);
  });

  test("Both may still report an unmatched conversation within the window", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    expect((await detailOf(ctx.app, a, id)).reportable).toBe(true);
    expect((await unmatch(ctx.app, a, id)).status).toBe(204);
    expect((await detailOf(ctx.app, a, id)).reportable).toBe(true);
    expect((await detailOf(ctx.app, b, id)).reportable).toBe(true);
    const reported = await ctx.app.request(`/conversations/${id}/report`, {
      method: "POST",
      headers: jsonHeaders(b.headers),
      body: JSON.stringify({ reason: "misrepresentation" }),
    });
    expect(reported.status).toBe(204);
    expect(
      await count(ctx, "SELECT count(*) AS n FROM report WHERE conversation_id = $1", [id]),
    ).toBe(1);
    // The report blocked: B no longer has it, and A still reads it ended.
    expect(await listOf(ctx.app, b)).toEqual({ open: [], archived: [] });
    expect((await detailOf(ctx.app, a, id)).state).toBe("closed");
  });

  test("An ended conversation reads the same before and after the other person's erasure", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "a", body: "Hei" },
        { from: "b", body: "Moi" },
      ],
    });
    expect((await blockFrom(ctx.app, b, id)).status).toBe(204);
    const before = { list: await listOf(ctx.app, a), page: await pageOf(ctx.app, a, id) };
    expect(before.list.archived).toEqual([
      expect.objectContaining({ id, state: "closed", closedHow: "unmatch", counterpart: null }),
    ]);
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    expect(await listOf(ctx.app, a)).toEqual(before.list);
    expect(await pageOf(ctx.app, a, id)).toEqual(before.page);
    const detail = await detailOf(ctx.app, a, id);
    expect(detail).toMatchObject({ state: "closed", closedHow: "unmatch", counterpart: null });
  });

  test("What either shared ends with an unmatch or a block", async ({ ctx }) => {
    const [a, b, c, d] = [
      await person(ctx, "Aino"),
      await person(ctx, "Bea"),
      await person(ctx, "Cia"),
      await person(ctx, "Dan"),
    ];
    if (!a || !b || !c || !d) throw new Error("no people");
    const ended = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const blocked = await conversationBetween(ctx.client, c.accountId, d.accountId);
    for (const [who, id] of [
      [a, ended],
      [c, blocked],
    ] as const) {
      const kept = await ctx.app.request("/contacts/telegram", {
        method: "PUT",
        headers: jsonHeaders(who.headers),
        body: JSON.stringify({ value: "piiprobe_4711" }),
      });
      expect(kept.status).toBe(200);
      const shared = await ctx.app.request(`/conversations/${id}/contacts/telegram`, {
        method: "POST",
        headers: who.headers,
      });
      expect(shared.status).toBe(200);
    }
    expect((await unmatch(ctx.app, a, ended)).status).toBe(204);
    expect((await blockFrom(ctx.app, c, blocked)).status).toBe(204);
    const shares = await ctx.client.query(
      "SELECT conversation_id, ended_how FROM contact_share WHERE conversation_id = ANY($1) ORDER BY conversation_id = $2 DESC",
      [[ended, blocked], ended],
    );
    expect(shares.rows).toEqual([
      { conversation_id: ended, ended_how: "closed" },
      { conversation_id: blocked, ended_how: "closed" },
    ]);
    // What was shared is no longer shown to the other.
    expect((await detailOf(ctx.app, b, ended)).contacts.theirs).toEqual([]);
  });

  test("An unmatch is a research event for the other person, and a block is none", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    for (const who of [a, b]) {
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
    }
    const first = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "a", body: "Hei" },
        { from: "b", body: "Moi" },
      ],
    });
    const second = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await unmatch(ctx.app, a, first)).status).toBe(204);
    expect((await unmatch(ctx.app, a, first)).status).toBe(204);
    expect((await blockFrom(ctx.app, a, second)).status).toBe(204);
    // A block set before a block wrote its close (#351): the unmatch writes it
    // as the block's, the blocker's side, and no event, as a block writes none.
    const c = await person(ctx, "Cia");
    const third = await conversationBetween(ctx.client, a.accountId, c.accountId);
    await ctx.client.query(
      `INSERT INTO block (blocker_identity_id, blocked_identity_id)
       SELECT x.identity_id, y.identity_id FROM account x, account y WHERE x.id = $1 AND y.id = $2`,
      [c.accountId, a.accountId],
    );
    expect((await unmatch(ctx.app, a, third)).status).toBe(204);
    const closed = await ctx.client.query(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [third],
    );
    expect(closed.rows).toEqual([{ closed_how: "block", closed_by: "b" }]);
    const events = await ctx.client.query<{ props: unknown; research_id: string }>(
      "SELECT props, research_id FROM events WHERE name = 'conversation_closed'",
    );
    expect(events.rows.map((r) => r.props)).toEqual([{ how: "unmatch", messages: "1-5" }]);
    const owner = await ctx.client.query<{ account_id: string }>(
      "SELECT account_id FROM research_subject WHERE research_id = $1",
      [events.rows[0]?.research_id],
    );
    expect(owner.rows).toEqual([{ account_id: b.accountId }]);
  });

  test("Only the conversation's two people can end it", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    for (const answer of [await unmatch(ctx.app, c, id), await unmatch(ctx.app, a, randomUUID())]) {
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
    }
    expect(
      await count(ctx, "SELECT count(*) AS n FROM conversation WHERE closed_at IS NOT NULL"),
    ).toBe(0);
    expect((await unmatch(ctx.app, a, "not-a-uuid")).status).toBe(400);
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      expect((await unmatch(ctx.app, { headers }, id)).status).toBe(401);
    }
    // B blocked A: the conversation is gone for B, so B cannot end it either.
    expect((await blockFrom(ctx.app, b, id)).status).toBe(204);
    expect((await unmatch(ctx.app, b, id)).status).toBe(404);
    // A suspended between the guard and the unmatch's hold: refused as nobody, nothing written.
    const racing = interleaved(ctx.client, /FOR SHARE OF a/, () =>
      ctx.client.query("UPDATE account SET state = 'suspended' WHERE id = $1", [a.accountId]),
    );
    const other = await conversationBetween(ctx.client, a.accountId, c.accountId);
    const app = createApp({
      config: testConfig(),
      logger: (await captureLogger()).logger,
      db: racing,
    });
    expect((await unmatch(app, a, other)).status).toBe(404);
    expect(racing.ran()).toBe(true);
    expect(
      await count(
        ctx,
        "SELECT count(*) AS n FROM conversation WHERE id = $1 AND closed_at IS NULL",
        [other],
      ),
    ).toBe(1);
  });
});
