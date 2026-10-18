import { randomUUID } from "node:crypto";
import { ConversationDetail, ConversationList, ErrorResponse, MessagePage } from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { applySanction } from "../safety/index.ts";
import { signInAs } from "../test/account.ts";
import { conversationBetween } from "../test/chat.ts";
import { openExport } from "../test/export.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { people } from "../test/people.ts";

// features/identity/erasure.feature, the chat's rows (#348, ADR-007 §4,
// ADR-031 §5): erasure cuts the person's link and keeps the words for the
// counterpart (TD-7); the export carries the person's own words and the
// counterpart's as a time and a length, never whom. The contacts (#103,
// ADR-031 §11): erasure deletes the stored pieces and keeps the shares,
// ended, as the record; the export carries the person's own of both.

// A marker of letters: a number can turn up in a timestamp by chance.
const MARK = "qzxvkw";

async function person(ctx: TestContext, name: string) {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

const send = (
  app: ReturnType<typeof createApp>,
  who: { headers: Record<string, string> },
  id: string,
  body: string,
) =>
  app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });

const keep = (
  app: ReturnType<typeof createApp>,
  who: { headers: Record<string, string> },
  kind: string,
  value: string,
) =>
  app.request(`/contacts/${kind}`, {
    method: "PUT",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
const share = (
  app: ReturnType<typeof createApp>,
  who: { headers: Record<string, string> },
  id: string,
  kind: string,
) => app.request(`/conversations/${id}/contacts/${kind}`, { method: "POST", headers: who.headers });

describe("the chat in an erasure and an export", () => {
  test('Erasure leaves the counterpart "Deleted user" and the messages, and closes the conversation', async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    let clock = new Date();
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => clock });
    expect((await send(app, a, id, "Hei Bea")).status).toBe(201);
    expect((await send(app, b, id, "Moi Aino")).status).toBe(201);
    clock = new Date(clock.getTime() + 60_000);
    await applySanction(ctx.client, {
      accountId: a.accountId,
      kind: "shadow_ban",
      reason: "commercial_use",
      note: "Sends the same link to everybody.",
      actor: null,
      at: clock,
    });
    clock = new Date(clock.getTime() + 60_000);
    expect((await send(app, a, id, `Withheld ${MARK}`)).status).toBe(201);

    await eraseAccount({ db: ctx.client, logger, now: () => clock }, a.accountId);

    const page = MessagePage.parse(
      await (await ctx.app.request(`/conversations/${id}/messages`, { headers: b.headers })).json(),
    );
    expect(page.messages.map((m) => [m.seq, m.side, m.body])).toEqual([
      [2, "mine", "Moi Aino"],
      [1, "theirs", "Hei Bea"],
    ]);
    const list = ConversationList.parse(
      await (await ctx.app.request("/conversations", { headers: b.headers })).json(),
    );
    expect(list.archived).toEqual([
      expect.objectContaining({
        id,
        state: "closed",
        closedHow: "erasure",
        counterpart: { deleted: true },
      }),
    ]);
    const refused = await send(ctx.app, b, id, "Oletko siellä?");
    expect(refused.status).toBe(409);
    expect(ErrorResponse.parse(await refused.json()).error.code).toBe("conversation_closed");
    const participants = await ctx.client.query<{ side: string; account_id: string | null }>(
      "SELECT side, account_id FROM conversation_participant WHERE conversation_id = $1 ORDER BY side",
      [id],
    );
    expect(participants.rows).toEqual([
      { side: "a", account_id: null },
      { side: "b", account_id: b.accountId },
    ]);
    const bodies = await ctx.client.query<{ body: string }>(
      "SELECT body FROM message WHERE conversation_id = $1 ORDER BY seq",
      [id],
    );
    expect(bodies.rows.map((r) => r.body)).toEqual(["Hei Bea", "Moi Aino"]);
    const conversation = await ctx.client.query<{ closed_how: string; closed_by: string }>(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [id],
    );
    expect(conversation.rows[0]).toEqual({ closed_how: "erasure", closed_by: "a" });
  });

  test("The export carries the person's own messages and the counterpart's as a time and a length", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(Date.now() - 86_400_000),
    });
    expect((await send(ctx.app, a, id, "Hei Bea")).status).toBe(201);
    const theirs = `Moi Aino 😀 ${MARK}`;
    expect((await send(ctx.app, b, id, theirs)).status).toBe(201);
    expect((await send(ctx.app, a, id, "Kahvilla?")).status).toBe(201);
    const { document, raw } = await openExport(
      await ctx.app.request("/account/export", { headers: a.headers }),
    );
    expect(document.conversations).toEqual([
      {
        openedAt: expect.any(String),
        state: "open",
        closedHow: null,
        mine: [
          { at: expect.any(String), kind: "text", body: "Hei Bea", photo: null },
          { at: expect.any(String), kind: "text", body: "Kahvilla?", photo: null },
        ],
        shares: [],
        theirs: [{ at: expect.any(String), kind: "text", length: [...theirs].length }],
      },
    ]);
    // Read as the zip carries it, before the contract drops a key it does not name.
    expect(raw).not.toContain(b.accountId);
    // B's words never leave the database for A's copy.
    expect(raw).not.toContain(MARK);
    expect(Object.keys(JSON.parse(raw).conversations[0].theirs[0])).toEqual([
      "at",
      "kind",
      "length",
    ]);
  });

  test("Erasure deletes the person's contacts and ends their shares, keeping the record without a value", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect((await keep(ctx.app, a, "phone", "040 123 4567")).status).toBe(200);
    expect((await keep(ctx.app, a, "instagram", MARK)).status).toBe(200);
    expect((await keep(ctx.app, b, "telegram", "bea_b_b")).status).toBe(200);
    expect((await share(ctx.app, a, id, "phone")).status).toBe(200);
    expect((await share(ctx.app, b, id, "telegram")).status).toBe(200);
    const { logger } = await captureLogger();
    const summary = await eraseAccount(
      { db: ctx.client, logger, now: () => new Date() },
      a.accountId,
    );
    expect(summary.contacts).toBe(2);
    const stored = await ctx.client.query<{ account_id: string; kind: string }>(
      "SELECT account_id, kind FROM contact WHERE account_id = ANY($1) ORDER BY kind",
      [[a.accountId, b.accountId]],
    );
    expect(stored.rows).toEqual([{ account_id: b.accountId, kind: "telegram" }]);
    const shares = await ctx.client.query<Record<string, unknown>>(
      "SELECT * FROM contact_share WHERE conversation_id = $1 ORDER BY side",
      [id],
    );
    expect(shares.rows.map((r) => [r.side, r.kind, r.ended_how, r.ended_at !== null])).toEqual([
      ["a", "phone", "closed", true],
      ["b", "telegram", "closed", true],
    ]);
    // The record holds no value: the columns are its own, none of them a contact.
    expect(Object.keys(shares.rows[0] ?? {}).sort()).toEqual([
      "conversation_id",
      "ended_at",
      "ended_how",
      "id",
      "kind",
      "shared_at",
      "side",
    ]);
    expect(JSON.stringify(shares.rows)).not.toContain("358401234567");
    // B reads nothing of A's, and keeps their own, shared nowhere now.
    const view = ConversationDetail.parse(
      await (await ctx.app.request(`/conversations/${id}`, { headers: b.headers })).json(),
    );
    expect(view.contacts).toEqual({
      mine: [{ kind: "telegram", value: "bea_b_b", shared: false }],
      theirs: [],
    });
    // Once B is erased too, the conversation goes, and its shares with it.
    await eraseAccount({ db: ctx.client, logger, now: () => new Date() }, b.accountId);
    const left = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM contact_share WHERE conversation_id = $1",
      [id],
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
  });

  test("The export carries the person's stored contacts and their own shares, never the other's", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // A's clock, a minute between the share, its end and the share again.
    const shared = new Date();
    const stopped = new Date(shared.getTime() + 60_000);
    const again = new Date(shared.getTime() + 120_000);
    let clock = shared;
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, now: () => clock });
    expect((await keep(app, a, "phone", "040 123 4567")).status).toBe(200);
    expect((await share(app, a, id, "phone")).status).toBe(200);
    clock = stopped;
    expect(
      (
        await app.request(`/conversations/${id}/contacts/phone`, {
          method: "DELETE",
          headers: a.headers,
        })
      ).status,
    ).toBe(200);
    // Shared again, and left standing.
    clock = again;
    expect((await share(app, a, id, "phone")).status).toBe(200);
    expect((await keep(ctx.app, b, "instagram", MARK)).status).toBe(200);
    expect((await share(ctx.app, b, id, "instagram")).status).toBe(200);
    const { document, raw } = await openExport(
      await ctx.app.request("/account/export", { headers: a.headers }),
    );
    expect(document.contacts).toEqual([
      { kind: "phone", value: "+358401234567", updatedAt: expect.any(String) },
    ]);
    // Oldest first: the one A stopped, then the one standing, which has not ended.
    expect(document.conversations[0]?.shares).toEqual([
      {
        kind: "phone",
        sharedAt: shared.toISOString(),
        endedAt: stopped.toISOString(),
        endedHow: "stopped",
      },
      { kind: "phone", sharedAt: again.toISOString(), endedAt: null, endedHow: null },
    ]);
    // Nothing of B's: not the piece, not the share.
    expect(raw).not.toContain(MARK);
    expect(raw).not.toContain("instagram");
  });

  test("a conversation goes whole once both people are erased: nobody is left to keep it for", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const both = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    const kept = await conversationBetween(ctx.client, a.accountId, c.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    const { logger } = await captureLogger();
    const erase = (accountId: string) =>
      eraseAccount({ db: ctx.client, logger, now: () => new Date() }, accountId);
    expect(await erase(b.accountId)).toMatchObject({ conversations: 1, emptiedConversations: 0 });
    expect(await erase(a.accountId)).toMatchObject({ conversations: 2, emptiedConversations: 1 });
    const left = await ctx.client.query<{ id: string }>(
      "SELECT id FROM conversation WHERE id = ANY($1)",
      [[both, kept]],
    );
    expect(left.rows.map((r) => r.id)).toEqual([kept]);
    const messages = await ctx.client.query<{ n: string }>(
      "SELECT count(*) AS n FROM message WHERE conversation_id = $1",
      [both],
    );
    expect(Number(messages.rows[0]?.n)).toBe(0);
  });
});
