import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import {
  ConversationContacts,
  ConversationDetail,
  ErrorResponse,
  StoredContact,
  StoredContacts,
} from "@kuutti/schema";
import { describe, expect } from "vitest";
import { createApp } from "../app.ts";
import { CURRENT_CONSENT_VERSIONS, eraseAccount } from "../identity/index.ts";
import { applySanction } from "../safety/index.ts";
import { signInAs, staffSession, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import { conversationBetween, interleaved } from "../test/chat.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { people } from "../test/people.ts";
import { archiveSilentConversations } from "./archive.ts";
import { readConversation } from "./conversations.ts";

// features/chat/contact-share.feature (#103, ADR-031 §11): the person's own
// contacts, kept in the one form of their kind and seen by nobody; a share in
// a conversation, seen by the other person at once until it is stopped, the
// piece removed or changed, or the conversation closed; every refusal; what
// a block, a close and a shadow ban withhold; the contacts read alone; the
// races with a close, a removal and an erasure; the minute's budget; the
// night's archive; the events. The socket's frames are live.test.ts's, the
// logs' pii-in-logs.test.ts's, erasure and the export erasure.test.ts's, a
// removal and an erasure, and a share and the night's archive, on two
// connections races.test.ts's.

const DAY = 86_400_000;

type Person = { accountId: string; headers: { authorization: string } };
type App = ReturnType<typeof createApp>;

async function person(ctx: TestContext): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const keep = (app: App, who: Person, kind: string, value: unknown) =>
  app.request(`/contacts/${kind}`, {
    method: "PUT",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ value }),
  });
const remove = (app: App, who: Person, kind: string) =>
  app.request(`/contacts/${kind}`, { method: "DELETE", headers: who.headers });
const share = (app: App, who: Person, id: string, kind: string) =>
  app.request(`/conversations/${id}/contacts/${kind}`, { method: "POST", headers: who.headers });
const stop = (app: App, who: Person, id: string, kind: string) =>
  app.request(`/conversations/${id}/contacts/${kind}`, { method: "DELETE", headers: who.headers });
const send = (app: App, who: Person, id: string, body: string) =>
  app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });

async function kept(app: App, who: Person, kind: string, value: string): Promise<StoredContact> {
  const answer = await keep(app, who, kind, value);
  expect(answer.status).toBe(200);
  return StoredContact.parse(await answer.json());
}
async function listOf(app: App, who: Person): Promise<StoredContacts> {
  const answer = await app.request("/contacts", { headers: who.headers });
  expect(answer.status).toBe(200);
  return StoredContacts.parse(await answer.json());
}
const readContacts = (app: App, who: Person, id: string) =>
  app.request(`/conversations/${id}/contacts`, { headers: who.headers });
async function detailOf(app: App, who: Person, id: string): Promise<ConversationDetail> {
  const answer = await app.request(`/conversations/${id}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  const detail = ConversationDetail.parse(await answer.json());
  // The contacts read alone answer what the detail shows, in every state a test here reads.
  const alone = await readContacts(app, who, id);
  expect(alone.status).toBe(200);
  expect(ConversationContacts.parse(await alone.json())).toEqual(detail.contacts);
  return detail;
}
async function shared(app: App, who: Person, id: string, kind: string) {
  const answer = await share(app, who, id, kind);
  expect(answer.status).toBe(200);
  return ConversationDetail.parse(await answer.json());
}
async function stopped(app: App, who: Person, id: string, kind: string) {
  const answer = await stop(app, who, id, kind);
  expect(answer.status).toBe(200);
  return ConversationDetail.parse(await answer.json());
}
const theirsOf = async (app: App, who: Person, id: string) =>
  (await detailOf(app, who, id)).contacts.theirs;
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;
/** The conversation's shares, the record as stored: whose side, which kind, how it ended. */
const sharesIn = async (ctx: TestContext, id: string) =>
  (
    await ctx.client.query<{ side: string; kind: string; ended_how: string | null }>(
      "SELECT side, kind, ended_how FROM contact_share WHERE conversation_id = $1 ORDER BY side, kind, shared_at",
      [id],
    )
  ).rows;
const storedOf = async (ctx: TestContext, who: Person) =>
  (
    await ctx.client.query<{ kind: string; value: string }>(
      "SELECT kind, value FROM contact WHERE account_id = $1 ORDER BY kind",
      [who.accountId],
    )
  ).rows;
const eventsNamed = async (ctx: TestContext, names: string[]) =>
  (
    await ctx.client.query<{ name: string; props: unknown }>(
      "SELECT name, props FROM events WHERE name = ANY($1) ORDER BY name",
      [names],
    )
  ).rows;
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
const sanction = (
  ctx: TestContext,
  who: Person,
  kind: "ban" | "shadow_ban" | "suspend",
  at: Date,
  db: Queryable = ctx.client,
) =>
  applySanction(db, {
    accountId: who.accountId,
    kind,
    reason: kind === "shadow_ban" ? "commercial_use" : "harassment",
    note: "Test sanction.",
    ...(kind === "suspend"
      ? { endsOn: new Date(at.getTime() + 7 * DAY).toISOString().slice(0, 10) }
      : {}),
    actor: null,
    at,
  });
/** The view of an account the routes no longer admit (banned), read as its own detail would be. */
const viewOf = async (ctx: TestContext, who: Person, id: string) =>
  readConversation(
    { db: ctx.client, logger: await silent(), now: () => new Date() },
    who.accountId,
    id,
  );

describe("the contacts a person keeps", () => {
  test("A person keeps a contact of each kind in its one form, seen by nobody", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    expect(await listOf(ctx.app, a)).toEqual({ contacts: [] });
    // Kept in another order than the kinds', so the list's order is its own.
    expect(await kept(ctx.app, a, "instagram", " @Aino.Koskinen ")).toEqual({
      kind: "instagram",
      value: "aino.koskinen",
      updatedAt: expect.any(String),
    });
    expect((await kept(ctx.app, a, "telegram", "@aino_k")).value).toBe("aino_k");
    expect((await kept(ctx.app, a, "whatsapp", "00 46 (70) 123-45-67")).value).toBe("+46701234567");
    expect((await kept(ctx.app, a, "phone", "040 123 4567")).value).toBe("+358401234567");
    // The same kind again replaces it: one piece of each kind.
    expect((await kept(ctx.app, a, "phone", "+358 40 123 4567")).value).toBe("+358401234567");
    const list = await listOf(ctx.app, a);
    expect(list.contacts.map((c) => [c.kind, c.value])).toEqual([
      ["phone", "+358401234567"],
      ["whatsapp", "+46701234567"],
      ["telegram", "aino_k"],
      ["instagram", "aino.koskinen"],
    ]);
    expect(await storedOf(ctx, a)).toHaveLength(4);
    // A's view of the conversation offers them, none shared; B sees none of them.
    expect((await detailOf(ctx.app, a, id)).contacts).toEqual({
      mine: list.contacts.map((c) => ({ kind: c.kind, value: c.value, shared: false })),
      theirs: [],
    });
    expect((await detailOf(ctx.app, b, id)).contacts).toEqual({ mine: [], theirs: [] });
    expect(await listOf(ctx.app, b)).toEqual({ contacts: [] });
    // The list of conversations never carries a contact.
    const conversations = await ctx.app.request("/conversations", { headers: b.headers });
    expect(await conversations.text()).not.toContain("aino");
  });

  describe("A contact that is not of its kind is refused in words, and nothing is kept", () => {
    test.for([
      ["a phone number with letters in it", "phone", "040 SOITA MULLE", "contact_invalid"],
      // Four characters after the @: Telegram's least is five.
      ["a Telegram username of four characters", "telegram", "@aino", "contact_invalid"],
      [
        "an Instagram username with two dots in a row",
        "instagram",
        "aino..koskinen",
        "contact_invalid",
      ],
      ["empty", "phone", "", "validation_failed"],
      ["over sixty-four characters", "instagram", "ainokoskinen".repeat(6), "validation_failed"],
      ["of a kind there is none of", "signal", "+358401234567", "validation_failed"],
    ] as const)("%s", async ([, kind, value, code], { ctx }) => {
      const a = await person(ctx);
      const answer = await keep(ctx.app, a, kind, value);
      expect(answer.status).toBe(400);
      const text = await answer.text();
      expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe(code);
      expect(await storedOf(ctx, a)).toEqual([]);
      if (value !== "") {
        expect(text).not.toContain(value);
        expect(JSON.stringify(ctx.logs())).not.toContain(value);
      }
      // A refusal of the kind's own rule names the kind in its log line, and nothing else.
      if (code === "contact_invalid") {
        expect(ctx.logs().find((l) => l.code === "contact_invalid")?.detail).toEqual({ kind });
      }
    });
  });

  test("a body that is not the contract's is refused before anything is read", async ({ ctx }) => {
    const a = await person(ctx);
    for (const body of [{ value: 4711 }, { value: "aino_k", extra: true }, {}]) {
      const answer = await ctx.app.request("/contacts/telegram", {
        method: "PUT",
        headers: jsonHeaders(a.headers),
        body: JSON.stringify(body),
      });
      expect(answer.status).toBe(400);
      expect(await errorCode(answer)).toBe("validation_failed");
    }
    expect(await storedOf(ctx, a)).toEqual([]);
  });

  test("a keep already past the guard writes nothing once the account is erased", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const db = interleaved(ctx.client, /FOR SHARE OF a/, async () =>
      eraseAccount({ db: ctx.client, logger: await silent(), now: () => new Date() }, a.accountId),
    );
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    const answer = await keep(app, a, "phone", "040 123 4567");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("not_found");
    expect(await storedOf(ctx, a)).toEqual([]);
  });

  test("removing a contact that is not kept answers alike, and an unknown kind is the contract's", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    await kept(ctx.app, a, "telegram", "aino_k");
    expect((await remove(ctx.app, a, "phone")).status).toBe(204);
    expect(await storedOf(ctx, a)).toEqual([{ kind: "telegram", value: "aino_k" }]);
    const unknown = await remove(ctx.app, a, "signal");
    expect(unknown.status).toBe(400);
    expect(await errorCode(unknown)).toBe("validation_failed");
  });

  test("each person's contacts are their own", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await kept(ctx.app, b, "phone", "050 765 4321");
    // B's removal of a phone number removes B's, never A's.
    expect((await remove(ctx.app, b, "phone")).status).toBe(204);
    expect(await storedOf(ctx, a)).toEqual([{ kind: "phone", value: "+358401234567" }]);
    expect(await storedOf(ctx, b)).toEqual([]);
    expect((await listOf(ctx.app, b)).contacts).toEqual([]);
  });
});

describe("a share in a conversation", () => {
  test("A shared contact is seen by the other person at once, and only in that conversation", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const c = await person(ctx);
    const withB = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // A on the other side here.
    const withC = await conversationBetween(ctx.client, c.accountId, a.accountId);
    await kept(ctx.app, a, "instagram", "aino.k");
    const answer = await shared(ctx.app, a, withB, "instagram");
    expect(answer).toMatchObject({ id: withB, state: "open" });
    expect(answer.contacts).toEqual({
      mine: [{ kind: "instagram", value: "aino.k", shared: true }],
      theirs: [],
    });
    expect((await detailOf(ctx.app, b, withB)).contacts).toEqual({
      mine: [],
      theirs: [{ kind: "instagram", value: "aino.k" }],
    });
    expect((await detailOf(ctx.app, c, withC)).contacts).toEqual({ mine: [], theirs: [] });
    expect((await detailOf(ctx.app, a, withC)).contacts.mine).toEqual([
      { kind: "instagram", value: "aino.k", shared: false },
    ]);
    // Nothing is written for B's side, and nothing asks B for anything.
    expect(await sharesIn(ctx, withB)).toEqual([{ side: "a", kind: "instagram", ended_how: null }]);
    expect(await sharesIn(ctx, withC)).toEqual([]);
    // The list never carries a contact.
    const list = await ctx.app.request("/conversations", { headers: b.headers });
    expect(await list.text()).not.toContain("aino.k");
  });

  test("Sharing again writes nothing", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    await giveResearchConsent(ctx, a);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    const first = await shared(ctx.app, a, id, "phone");
    const again = await shared(ctx.app, a, id, "phone");
    expect(again).toEqual(first);
    expect(await sharesIn(ctx, id)).toEqual([{ side: "a", kind: "phone", ended_how: null }]);
    expect(await eventsNamed(ctx, ["contact_shared"])).toHaveLength(1);
  });

  test("Stopping, changing or removing a shared contact shows at once on the other side", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await kept(ctx.app, a, "telegram", "aino_k");
    await shared(ctx.app, a, id, "phone");
    await shared(ctx.app, a, id, "telegram");
    expect(await theirsOf(ctx.app, b, id)).toEqual([
      { kind: "phone", value: "+358401234567" },
      { kind: "telegram", value: "aino_k" },
    ]);
    // A changed number shows its new value, the share standing as it was.
    await kept(ctx.app, a, "phone", "050 765 4321");
    expect(await theirsOf(ctx.app, b, id)).toEqual([
      { kind: "phone", value: "+358507654321" },
      { kind: "telegram", value: "aino_k" },
    ]);
    const afterStop = await stopped(ctx.app, a, id, "telegram");
    expect(afterStop.contacts.mine).toEqual([
      { kind: "phone", value: "+358507654321", shared: true },
      { kind: "telegram", value: "aino_k", shared: false },
    ]);
    expect(await theirsOf(ctx.app, b, id)).toEqual([{ kind: "phone", value: "+358507654321" }]);
    expect((await remove(ctx.app, a, "phone")).status).toBe(204);
    expect(await theirsOf(ctx.app, b, id)).toEqual([]);
    expect((await listOf(ctx.app, a)).contacts.map((c) => c.kind)).toEqual(["telegram"]);
    expect(await sharesIn(ctx, id)).toEqual([
      { side: "a", kind: "phone", ended_how: "removed" },
      { side: "a", kind: "telegram", ended_how: "stopped" },
    ]);
    // Kept again, the number is shared nowhere until A shares it.
    await kept(ctx.app, a, "phone", "050 765 4321");
    expect(await theirsOf(ctx.app, b, id)).toEqual([]);
    expect((await detailOf(ctx.app, a, id)).contacts.mine).toEqual([
      { kind: "phone", value: "+358507654321", shared: false },
      { kind: "telegram", value: "aino_k", shared: false },
    ]);
    // Stopping what is not shared answers with the view as it is, and writes nothing.
    expect(await stopped(ctx.app, a, id, "telegram")).toEqual(await detailOf(ctx.app, a, id));
    expect(await sharesIn(ctx, id)).toHaveLength(2);
    // Shared again, a new share stands beside the record of the old.
    await shared(ctx.app, a, id, "phone");
    expect(await sharesIn(ctx, id)).toEqual([
      { side: "a", kind: "phone", ended_how: "removed" },
      { side: "a", kind: "phone", ended_how: null },
      { side: "a", kind: "telegram", ended_how: "stopped" },
    ]);
  });

  describe("A share is refused in words, and nothing is written", () => {
    test.for([
      ['as a kind "A" does not keep', 409, "contact_not_stored"],
      ["in a conversation that closed", 409, "conversation_closed"],
      ["to somebody a block stands between", 409, "conversation_closed"],
      ["to somebody who deleted their account", 409, "conversation_closed"],
      ['after blocking "B"', 404, "not_found"],
    ] as const)("%s", async ([kase, status, code], { ctx }) => {
      const a = await person(ctx);
      const b = await person(ctx);
      const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
        archivedAt: new Date(Date.now() - DAY),
      });
      await kept(ctx.app, a, "phone", "040 123 4567");
      let kind = "phone";
      switch (kase) {
        case 'as a kind "A" does not keep':
          kind = "telegram";
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
        case 'after blocking "B"':
          await block(ctx, a, b);
          break;
      }
      const answer = await share(ctx.app, a, id, kind);
      expect(answer.status).toBe(status);
      expect(await errorCode(answer)).toBe(code);
      expect(await sharesIn(ctx, id)).toEqual([]);
      // Nothing brought it back from the archive either.
      const row = await ctx.client.query<{ archived: boolean }>(
        "SELECT archived_at IS NOT NULL AS archived FROM conversation WHERE id = $1",
        [id],
      );
      expect(row.rows[0]?.archived).toBe(true);
    });
  });

  test("A share brings an archived conversation back", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(Date.now() - 20 * DAY),
      archivedAt: new Date(Date.now() - DAY),
    });
    expect((await detailOf(ctx.app, a, id)).state).toBe("archived");
    await kept(ctx.app, a, "whatsapp", "040 123 4567");
    expect((await shared(ctx.app, a, id, "whatsapp")).state).toBe("open");
    expect((await detailOf(ctx.app, b, id)).state).toBe("open");
    // Its end leaves it where it is: open.
    expect((await stopped(ctx.app, a, id, "whatsapp")).state).toBe("open");
  });

  test("A close ends every share, and a closed conversation shows none either way", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await kept(ctx.app, b, "instagram", "bea.b");
    await shared(ctx.app, a, id, "phone");
    await shared(ctx.app, b, id, "instagram");
    await sanction(ctx, a, "ban", new Date());
    expect(await sharesIn(ctx, id)).toEqual([
      { side: "a", kind: "phone", ended_how: "closed" },
      { side: "b", kind: "instagram", ended_how: "closed" },
    ]);
    const theirView = await detailOf(ctx.app, b, id);
    expect(theirView.state).toBe("closed");
    expect(theirView.contacts).toEqual({
      mine: [{ kind: "instagram", value: "bea.b", shared: false }],
      theirs: [],
    });
    // The banned person's own view, which no route serves any more, reads the same.
    expect((await viewOf(ctx, a, id)).contacts).toEqual({
      mine: [{ kind: "phone", value: "+358401234567", shared: false }],
      theirs: [],
    });
    // Stopping in a closed conversation is not refused: there is nothing to stop.
    expect((await stopped(ctx.app, b, id, "instagram")).contacts).toEqual(theirView.contacts);
    // And a conversation closed by any other hand shows none either, its shares as they stood.
    const other = await person(ctx);
    const later = await conversationBetween(ctx.client, b.accountId, other.accountId);
    await shared(ctx.app, b, later, "instagram");
    await ctx.client.query(
      "UPDATE conversation SET closed_at = now(), closed_how = 'unmatch', closed_by = 'b' WHERE id = $1",
      [later],
    );
    expect((await detailOf(ctx.app, other, later)).contacts.theirs).toEqual([]);
    expect((await detailOf(ctx.app, b, later)).contacts.mine).toEqual([
      { kind: "instagram", value: "bea.b", shared: false },
    ]);
  });

  test("A block hides what the blocker shared, and never says so", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await kept(ctx.app, b, "instagram", "bea.b");
    await shared(ctx.app, a, id, "phone");
    await shared(ctx.app, b, id, "instagram");
    await block(ctx, b, a);
    const answer = await ctx.app.request(`/conversations/${id}`, { headers: a.headers });
    const raw = await answer.text();
    const view = ConversationDetail.parse(JSON.parse(raw));
    expect(view).toMatchObject({ state: "closed", closedHow: "unmatch" });
    expect(view.contacts).toEqual({
      mine: [{ kind: "phone", value: "+358401234567", shared: false }],
      theirs: [],
    });
    expect(raw).not.toMatch(/block/i);
    expect(raw).not.toContain("bea.b");
    // B no longer has it: every route answers 404, and both shares ended with the block's close (#351).
    for (const refused of [
      await ctx.app.request(`/conversations/${id}`, { headers: b.headers }),
      await readContacts(ctx.app, b, id),
      await share(ctx.app, b, id, "instagram"),
      await stop(ctx.app, b, id, "instagram"),
    ]) {
      expect(refused.status).toBe(404);
      expect(await errorCode(refused)).toBe("not_found");
    }
    expect((await sharesIn(ctx, id)).map((s) => s.ended_how)).toEqual(["closed", "closed"]);
  });

  test("A shadow-banned person's share is withheld from the other until the ban is lifted", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    // The app's clock, so the first share is before the ban and the second after it.
    let clock = new Date();
    const app = createApp({
      config: testConfig(),
      logger: await silent(),
      db: ctx.client,
      now: () => clock,
    });
    await kept(app, a, "phone", "040 123 4567");
    await kept(app, a, "instagram", "aino.k");
    await shared(app, a, id, "phone");
    clock = new Date(clock.getTime() + 60_000);
    const ban = await sanction(ctx, a, "shadow_ban", clock);
    clock = new Date(clock.getTime() + 60_000);
    // Nothing tells A: the share answers as always.
    expect((await shared(app, a, id, "instagram")).contacts.mine).toEqual([
      { kind: "phone", value: "+358401234567", shared: true },
      { kind: "instagram", value: "aino.k", shared: true },
    ]);
    expect(await theirsOf(app, b, id)).toEqual([{ kind: "phone", value: "+358401234567" }]);
    // Lifted, as the panel's lift writes it.
    await ctx.client.query("UPDATE sanction SET lifted_at = now() WHERE id = $1", [ban.id]);
    expect(await theirsOf(app, b, id)).toEqual([
      { kind: "phone", value: "+358401234567" },
      { kind: "instagram", value: "aino.k" },
    ]);
  });

  test("A contact changed under a shadow ban is withheld from the other until the ban is lifted", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    let clock = new Date();
    const app = createApp({
      config: testConfig(),
      logger: await silent(),
      db: ctx.client,
      now: () => clock,
    });
    await kept(app, a, "phone", "040 123 4567");
    await kept(app, a, "telegram", "aino_k");
    await shared(app, a, id, "phone");
    await shared(app, a, id, "telegram");
    clock = new Date(clock.getTime() + 60_000);
    const ban = await sanction(ctx, a, "shadow_ban", clock);
    clock = new Date(clock.getTime() + 60_000);
    // Shared before the ban and left as they were, both stay shown.
    expect(await theirsOf(app, b, id)).toEqual([
      { kind: "phone", value: "+358401234567" },
      { kind: "telegram", value: "aino_k" },
    ]);
    // A changes the number, and keeps the username again as it was.
    await kept(app, a, "phone", "050 765 4321");
    await kept(app, a, "telegram", "@aino_k");
    // Nothing tells A: both read as shared, the new number with them.
    expect((await detailOf(app, a, id)).contacts.mine).toEqual([
      { kind: "phone", value: "+358507654321", shared: true },
      { kind: "telegram", value: "aino_k", shared: true },
    ]);
    // B sees the username, unchanged, and nothing of the number, neither old nor new.
    expect(await theirsOf(app, b, id)).toEqual([{ kind: "telegram", value: "aino_k" }]);
    await ctx.client.query("UPDATE sanction SET lifted_at = now() WHERE id = $1", [ban.id]);
    expect(await theirsOf(app, b, id)).toEqual([
      { kind: "phone", value: "+358507654321" },
      { kind: "telegram", value: "aino_k" },
    ]);
  });

  test("The contacts of a conversation read alone sign nothing and write nothing", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "instagram", "aino.k");
    await shared(ctx.app, a, id, "instagram");
    // With the media configured, as on a server: the detail signs A's thumb for B.
    const { logger, lines } = await captureLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      db: ctx.client,
      media: testMediaDeps().deps,
    });
    const fetches = async () =>
      Number(
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*) AS n FROM photo_access WHERE account_id = $1",
            [b.accountId],
          )
        ).rows[0]?.n,
      );
    for (let i = 0; i < 3; i++) {
      const answer = await readContacts(app, b, id);
      expect(answer.status).toBe(200);
      expect(ConversationContacts.parse(await answer.json())).toEqual({
        mine: [],
        theirs: [{ kind: "instagram", value: "aino.k" }],
      });
    }
    expect(await fetches()).toBe(0);
    expect(lines().some((l) => l.msg === "photo url issued")).toBe(false);
    // The detail, read once, signs the thumb and logs the fetch: what each frame cost before.
    const detail = ConversationDetail.parse(
      await (await app.request(`/conversations/${id}`, { headers: b.headers })).json(),
    );
    expect(detail.counterpart).toMatchObject({
      deleted: false,
      thumb: { url: expect.any(String) },
    });
    expect(await fetches()).toBe(1);
  });
});

describe("a share against what lands meanwhile", () => {
  test("A close that lands while a share is in flight refuses it", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    // The ban commits after the share has locked the row and before it reads what it decides on.
    const db = interleaved(ctx.client, /AS hidden/, () => sanction(ctx, a, "ban", new Date()));
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    const answer = await share(app, a, id, "phone");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("conversation_closed");
    expect(await sharesIn(ctx, id)).toEqual([]);
  });

  test("A share that lands before a close in flight is ended by it", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, b, "telegram", "bea_b_b");
    // B's share commits after the ban began and before it closes the conversation.
    const db = interleaved(ctx.client, /UPDATE conversation c\s+SET closed_at/, async () => {
      await shared(ctx.app, b, id, "telegram");
    });
    await sanction(ctx, a, "ban", new Date(), db);
    expect(db.ran()).toBe(true);
    expect(await sharesIn(ctx, id)).toEqual([{ side: "b", kind: "telegram", ended_how: "closed" }]);
    expect((await viewOf(ctx, a, id)).contacts.theirs).toEqual([]);
    expect((await detailOf(ctx.app, b, id)).contacts.mine).toEqual([
      { kind: "telegram", value: "bea_b_b", shared: false },
    ]);
  });

  test("A removal that lands while a share is in flight refuses the share", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    const db = interleaved(ctx.client, /FOR SHARE OF k/, async () => {
      expect((await remove(ctx.app, a, "phone")).status).toBe(204);
    });
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    const answer = await share(app, a, id, "phone");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("contact_not_stored");
    expect(await sharesIn(ctx, id)).toEqual([]);
  });

  test("A share that lands before a removal in flight is ended by it", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    const db = interleaved(ctx.client, /DELETE FROM contact WHERE account_id = \$1 AND kind/, () =>
      shared(ctx.app, a, id, "phone"),
    );
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    expect((await remove(app, a, "phone")).status).toBe(204);
    expect(db.ran()).toBe(true);
    expect(await sharesIn(ctx, id)).toEqual([{ side: "a", kind: "phone", ended_how: "removed" }]);
    expect(await theirsOf(ctx.app, b, id)).toEqual([]);
  });

  test("a removal already past the guard writes nothing once the account is erased", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await shared(ctx.app, a, id, "phone");
    // The erasure commits after the guard admitted the removal and before it holds the account.
    const db = interleaved(ctx.client, /FOR SHARE OF a/, async () =>
      eraseAccount({ db: ctx.client, logger: await silent(), now: () => new Date() }, a.accountId),
    );
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    const answer = await remove(app, a, "phone");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await errorCode(answer)).toBe("not_found");
    // The erasure's close ended the share, and the removal wrote nothing over it.
    expect(await sharesIn(ctx, id)).toEqual([{ side: "a", kind: "phone", ended_how: "closed" }]);
    expect(await storedOf(ctx, a)).toEqual([]);
  });

  test("a share already past the guard writes nothing once a suspension lands", async ({ ctx }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    const db = interleaved(ctx.client, /FOR SHARE OF a/, () =>
      sanction(ctx, a, "suspend", new Date()),
    );
    const app = createApp({ config: testConfig(), logger: await silent(), db });
    const answer = await share(app, a, id, "phone");
    expect(db.ran()).toBe(true);
    expect(answer.status).toBe(404);
    expect(await sharesIn(ctx, id)).toEqual([]);
  });
});

describe("who may share, and how often", () => {
  test("A share, its end, and a keep or a removal of a contact count with the messages of a minute", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { messages_per_minute: 3 });
    const a = await person(ctx);
    const b = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    expect((await send(ctx.app, a, id, "Moi")).status).toBe(201);
    await shared(ctx.app, a, id, "phone");
    // The minute is spent: the stop, a keep and a removal are each refused, and nothing is written.
    for (const refused of [
      await stop(ctx.app, a, id, "phone"),
      await keep(ctx.app, a, "phone", "050 765 4321"),
      await keep(ctx.app, a, "telegram", "aino_k"),
      await remove(ctx.app, a, "phone"),
    ]) {
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await errorCode(refused)).toBe("message_budget_exceeded");
    }
    expect(await storedOf(ctx, a)).toEqual([{ kind: "phone", value: "+358401234567" }]);
    expect(await sharesIn(ctx, id)).toEqual([{ side: "a", kind: "phone", ended_how: null }]);
    // B's minute is B's own, and the reads are not counted: B's and A's both answer.
    expect(await theirsOf(ctx.app, b, id)).toEqual([{ kind: "phone", value: "+358401234567" }]);
    await kept(ctx.app, b, "telegram", "bea_b_b");
    await shared(ctx.app, b, id, "telegram");
    expect((await listOf(ctx.app, a)).contacts).toHaveLength(1);
    expect((await detailOf(ctx.app, a, id)).contacts.theirs).toEqual([
      { kind: "telegram", value: "bea_b_b" },
    ]);
  });

  test("A conversation the caller is not in, or one that does not exist, answers 404 to a share and its end", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    const c = await person(ctx);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    await kept(ctx.app, a, "phone", "040 123 4567");
    await shared(ctx.app, a, id, "phone");
    await kept(ctx.app, c, "phone", "050 765 4321");
    for (const target of [id, randomUUID()]) {
      for (const answer of [
        await share(ctx.app, c, target, "phone"),
        await stop(ctx.app, c, target, "phone"),
        await readContacts(ctx.app, c, target),
      ]) {
        expect(answer.status).toBe(404);
        expect(await errorCode(answer)).toBe("not_found");
      }
    }
    // A's share stands, and nothing was written for C.
    expect(await sharesIn(ctx, id)).toEqual([{ side: "a", kind: "phone", ended_how: null }]);
    // A malformed id or an unknown kind is the contract's.
    for (const answer of [
      await share(ctx.app, a, "not-a-uuid", "phone"),
      await stop(ctx.app, a, "not-a-uuid", "phone"),
      await readContacts(ctx.app, a, "not-a-uuid"),
      await share(ctx.app, a, id, "signal"),
      await stop(ctx.app, a, id, "signal"),
    ]) {
      expect(answer.status).toBe(400);
      expect(await errorCode(answer)).toBe("validation_failed");
    }
  });

  test("The contact routes refuse without a session", async ({ ctx }) => {
    const staff = await staffSession(ctx.client, "admin");
    const id = randomUUID();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/contacts"],
      ["PUT", "/contacts/phone", { value: "040 123 4567" }],
      ["DELETE", "/contacts/phone"],
      ["GET", `/conversations/${id}/contacts`],
      ["POST", `/conversations/${id}/contacts/phone`],
      ["DELETE", `/conversations/${id}/contacts/phone`],
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

  test("Each share that begins and each the owner takes back is a research event with no kind or value", async ({
    ctx,
  }) => {
    const a = await person(ctx);
    const b = await person(ctx);
    await giveResearchConsent(ctx, a);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(Date.now() - 2 * DAY),
      messages: [
        { from: "a", body: "Hei" },
        { from: "b", body: "Moi" },
      ],
    });
    await kept(ctx.app, a, "phone", "040 123 4567");
    await kept(ctx.app, a, "telegram", "aino_k");
    await kept(ctx.app, a, "instagram", "aino.k");
    await shared(ctx.app, a, id, "phone");
    await shared(ctx.app, a, id, "phone");
    await stopped(ctx.app, a, id, "phone");
    await shared(ctx.app, a, id, "telegram");
    expect((await remove(ctx.app, a, "telegram")).status).toBe(204);
    await shared(ctx.app, a, id, "instagram");
    // B's erasure closes the conversation, which ends the third: the close's event, not A's taking back.
    await eraseAccount(
      { db: ctx.client, logger: await silent(), now: () => new Date() },
      b.accountId,
    );
    expect(await sharesIn(ctx, id)).toEqual([
      { side: "a", kind: "phone", ended_how: "stopped" },
      { side: "a", kind: "telegram", ended_how: "removed" },
      { side: "a", kind: "instagram", ended_how: "closed" },
    ]);
    const events = await eventsNamed(ctx, ["contact_shared", "contact_unshared"]);
    const shares = { sinceOpened: "1d_7d", messages: "1-5" };
    expect(events.map((e) => [e.name, e.props]).sort()).toEqual(
      [
        ["contact_shared", shares],
        ["contact_shared", shares],
        ["contact_shared", shares],
        ["contact_unshared", {}],
        ["contact_unshared", {}],
      ].sort(),
    );
    const raw = JSON.stringify(
      (await ctx.client.query("SELECT props FROM events WHERE name LIKE 'contact_%'")).rows,
    );
    for (const told of ["phone", "telegram", "instagram", "358401234567", "aino"]) {
      expect(raw).not.toContain(told);
    }
  });
});

describe("the night's archive", () => {
  test("The night counts a share as it counts a message", async ({ ctx }) => {
    const now = new Date();
    const a = await person(ctx);
    const b = await person(ctx);
    const c = await person(ctx);
    await giveResearchConsent(ctx, a);
    const night = async () =>
      archiveSilentConversations({ db: ctx.client, logger: await silent(), now: () => now });
    const archivedOf = async (id: string) =>
      (
        await ctx.client.query<{ archived: boolean }>(
          "SELECT archived_at IS NOT NULL AS archived FROM conversation WHERE id = $1",
          [id],
        )
      ).rows[0]?.archived;
    const archives = async () => (await eventsNamed(ctx, ["conversation_archived"])).length;
    // Silent for twenty days, nothing shared in it.
    const broughtBack = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      openedAt: new Date(now.getTime() - 20 * DAY),
    });
    // Opened a month ago, and its one share ten days ago (by an app whose clock is then).
    const sharedLongAgo = await conversationBetween(ctx.client, a.accountId, c.accountId, {
      openedAt: new Date(now.getTime() - 30 * DAY),
    });
    const then = createApp({
      config: testConfig(),
      logger: await silent(),
      db: ctx.client,
      now: () => new Date(now.getTime() - 10 * DAY),
    });
    await kept(then, a, "phone", "040 123 4567");
    await shared(then, a, sharedLongAgo, "phone");
    // A share as old as the window is no activity: both are archived, each an event of A's.
    expect(await night()).toBe(2);
    expect(await archivedOf(broughtBack)).toBe(true);
    expect(await archivedOf(sharedLongAgo)).toBe(true);
    expect(await archives()).toBe(2);
    // A share brings the first back, and the next night leaves it open.
    const app = createApp({
      config: testConfig(),
      logger: await silent(),
      db: ctx.client,
      now: () => now,
    });
    await shared(app, a, broughtBack, "phone");
    expect(await archivedOf(broughtBack)).toBe(false);
    expect(await night()).toBe(0);
    expect(await archivedOf(broughtBack)).toBe(false);
    expect(await archives()).toBe(2);
  });
});
