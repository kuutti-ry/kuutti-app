import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createPool,
  migrate,
  type Pool,
  type PoolClient,
  type Queryable,
  withTemporaryDatabase,
} from "@kuutti/db";
import { ConversationDetail, ConversationList, ErrorResponse, MessagePage } from "@kuutti/schema";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { eraseAccount } from "../identity/index.ts";
import { objectKey } from "../media/index.ts";
import { signInAs, withMatchingConfig } from "../test/account.ts";
import { cardShown } from "../test/cards.ts";
import {
  conversationBetween,
  interleaved,
  photoMessage,
  twoInAConversation,
} from "../test/chat.ts";
import { captureLogger, type TestContext, test, testConfig } from "../test/harness.ts";
import { testMediaDeps } from "../test/media.ts";
import { people } from "../test/people.ts";
import { pidOf, waitsFor, watched } from "../test/races.ts";
import { recordConversationBlock } from "./blocks.ts";
import { pruneReports, REPORT_RETENTION_DAYS, recordConversationReport } from "./reports.ts";
import { applySanction } from "./sanctions.ts";

// features/safety/reports.feature and blocks.feature, from a conversation
// (#351, ADR-030 §12), and features/identity/erasure.feature's photos a
// report's copy holds: the report with its frozen copy, the block and the
// close in one transaction, the window after a close, the day's cap and the
// open report, who may ask, the night's prune and the erasure's hold.

const DAY = 86_400_000;

type Person = { accountId: string; headers: Record<string, string> };

async function person(ctx: TestContext, name: string): Promise<Person> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

type App = ReturnType<typeof createApp>;
const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});
const report = (app: App, who: Person, id: string, body: unknown = { reason: "harassment" }) =>
  app.request(`/conversations/${id}/report`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify(body),
  });
const blockFrom = (app: App, who: Person, id: string) =>
  app.request(`/conversations/${id}/block`, { method: "POST", headers: who.headers });
const errorCode = async (answer: Response) => ErrorResponse.parse(await answer.json()).error.code;
const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
  Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
const written = async (ctx: TestContext) => ({
  reports: await count(ctx, "SELECT count(*) AS n FROM report"),
  copies: await count(ctx, "SELECT count(*) AS n FROM report_message"),
  blocks: await count(ctx, "SELECT count(*) AS n FROM block"),
  closed: await count(ctx, "SELECT count(*) AS n FROM conversation WHERE closed_at IS NOT NULL"),
});
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
const blockStands = (ctx: TestContext, blocker: Person, blocked: Person) =>
  count(
    ctx,
    `SELECT count(*) AS n FROM block bl
     JOIN account x ON x.identity_id = bl.blocker_identity_id
     JOIN account y ON y.identity_id = bl.blocked_identity_id
     WHERE x.id = $1 AND y.id = $2`,
    [blocker.accountId, blocked.accountId],
  );

describe("a report from a conversation", () => {
  test("A report from a conversation copies every message, blocks both ways and closes it", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [
        { from: "b", body: "Moi Aino" },
        { from: "a", body: "Hei Bea" },
      ],
    });
    const fromB = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: b.accountId,
      side: "b",
      caption: "Katso",
    });
    const fromA = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: a.accountId,
      side: "a",
      caption: null,
    });
    const answer = await report(ctx.app, a, id, { reason: "harassment", note: "Uhkaili." });
    expect(answer.status).toBe(204);

    const filed = await ctx.client.query(
      `SELECT reporter_account_id, reported_account_id, source, reason, note, conversation_id, id
       FROM report`,
    );
    expect(filed.rows).toEqual([
      {
        reporter_account_id: a.accountId,
        reported_account_id: b.accountId,
        source: "conversation",
        reason: "harassment",
        note: "Uhkaili.",
        conversation_id: id,
        id: expect.any(String),
      },
    ]);
    const thread = await ctx.client.query(
      "SELECT seq, side, kind, body, photo_id, created_at FROM message WHERE conversation_id = $1 ORDER BY seq",
      [id],
    );
    const copy = await ctx.client.query(
      "SELECT seq, side, kind, body, photo_id, created_at FROM report_message WHERE report_id = $1 ORDER BY seq",
      [filed.rows[0]?.id],
    );
    // The thread as it stood, each line's side seen from the report.
    expect(copy.rows).toEqual(
      thread.rows.map((line) => ({ ...line, side: line.side === "a" ? "reporter" : "reported" })),
    );
    expect(copy.rows.map((line) => line.photo_id)).toEqual([
      null,
      null,
      fromB.photoId,
      fromA.photoId,
    ]);

    // The block both ways, and the close as the reporter's block.
    expect(await blockStands(ctx, a, b)).toBe(1);
    const closed = await ctx.client.query(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [id],
    );
    expect(closed.rows).toEqual([{ closed_how: "block", closed_by: "a" }]);
    expect(await listOf(ctx.app, a)).toEqual({ open: [], archived: [] });
    expect((await ctx.app.request(`/conversations/${id}`, { headers: a.headers })).status).toBe(
      404,
    );
    expect((await listOf(ctx.app, b)).archived).toEqual([
      expect.objectContaining({ id, state: "closed", closedHow: "unmatch", counterpart: null }),
    ]);
    // Sent again, as after a lost answer, it is open: 204, nothing more, and the
    // same once B has deleted the account, so the answer says nothing of B.
    const once = await written(ctx);
    expect((await report(ctx.app, a, id)).status).toBe(204);
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    const erased = await written(ctx);
    expect((await report(ctx.app, a, id)).status).toBe(204);
    expect(await written(ctx)).toEqual(erased);
    expect(erased.reports).toBe(once.reports);
  });

  test("The person blocked can still report the conversation within the window, and not after it", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { report_after_close_days: 30 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    // The thirtieth day, a minute before its end.
    await ctx.client.query("UPDATE conversation SET closed_at = $2 WHERE id = $1", [
      id,
      new Date(Date.now() - 30 * DAY + 60_000),
    ]);
    expect((await detailOf(ctx.app, b, id)).reportable).toBe(true);
    expect((await report(ctx.app, b, id)).status).toBe(204);
    expect(
      await count(
        ctx,
        `SELECT count(*) AS n FROM report r JOIN report_message rm ON rm.report_id = r.id
         WHERE r.reporter_account_id = $1 AND r.conversation_id = $2`,
        [b.accountId, id],
      ),
    ).toBe(1);

    // Another pair, ended thirty-one days ago.
    const c = await person(ctx, "Cia");
    const d = await person(ctx, "Dan");
    const late = await conversationBetween(ctx.client, c.accountId, d.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    expect(
      (
        await ctx.app.request(`/conversations/${late}/unmatch`, {
          method: "POST",
          headers: d.headers,
        })
      ).status,
    ).toBe(204);
    await ctx.client.query("UPDATE conversation SET closed_at = $2 WHERE id = $1", [
      late,
      new Date(Date.now() - 31 * DAY),
    ]);
    expect((await detailOf(ctx.app, c, late)).reportable).toBe(false);
    const before = await written(ctx);
    const refused = await report(ctx.app, c, late);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("report_window_closed");
    expect(await written(ctx)).toEqual(before);
  });

  test("A report from a conversation counts toward the day's cap and one open report per pair", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { reports_per_day: 5 });
    const a = await person(ctx, "Aino");
    const others: Person[] = [];
    for (const name of ["Bea", "Cia", "Dan", "Eva", "Fia", "Gun"]) {
      others.push(await person(ctx, name));
    }
    const ids: string[] = [];
    for (const [i, other] of others.entries()) {
      // Every other one silent: a copy of no messages is a report all the same.
      const messages = i % 2 === 0 ? [{ from: "b" as const, body: "Moi" }] : [];
      ids.push(await conversationBetween(ctx.client, a.accountId, other.accountId, { messages }));
    }
    const [first, ...rest] = ids;
    if (!first) throw new Error("no conversation");
    expect((await report(ctx.app, a, first)).status).toBe(204);
    // The same again, as after a lost answer: the report is open, nothing more is written.
    const once = await written(ctx);
    expect((await report(ctx.app, a, first, { reason: "other" })).status).toBe(204);
    expect(await written(ctx)).toEqual(once);
    // Four more fill the day.
    for (const id of rest.slice(0, 4)) expect((await report(ctx.app, a, id)).status).toBe(204);
    const full = await written(ctx);
    expect(full.reports).toBe(5);
    const last = rest[4];
    if (!last) throw new Error("no last conversation");
    const refused = await report(ctx.app, a, last);
    expect(refused.status).toBe(429);
    expect(await errorCode(refused)).toBe("report_budget_exceeded");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await written(ctx)).toEqual(full);
    expect((await detailOf(ctx.app, a, last)).state).toBe("open");
  });

  test("A second report from a conversation while one is open writes nothing more, whoever is gone meanwhile", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    expect((await report(ctx.app, a, id)).status).toBe(204);
    const once = await written(ctx);
    expect(once).toMatchObject({ reports: 1, copies: 1, blocks: 1 });
    // Again, as after a lost answer, with other words: the report is open.
    expect((await report(ctx.app, a, id, { reason: "other", note: "Taas." })).status).toBe(204);
    expect(await written(ctx)).toEqual(once);
    // B deletes the account: the conversation is still hidden from A, and the
    // open report is found by the conversation, not by B, so the answer stays.
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    expect(await written(ctx)).toEqual(once);
    expect((await report(ctx.app, a, id)).status).toBe(204);
    expect(await written(ctx)).toEqual(once);
  });

  test("The one who blocked cannot report the conversation they no longer see, and learns nothing from the answer", async ({
    ctx,
  }) => {
    await withMatchingConfig(ctx.client, { report_after_close_days: 30 });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    const before = await written(ctx);
    const refused = async (when: string) => {
      const answer = await report(ctx.app, a, id);
      expect(answer.status, when).toBe(404);
      expect(await errorCode(answer), when).toBe("not_found");
    };
    await refused("within the window");
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    await refused("after B's erasure");
    await ctx.client.query("UPDATE conversation SET closed_at = $2 WHERE id = $1", [
      id,
      new Date(Date.now() - 31 * DAY),
    ]);
    await refused("after the window");
    expect(await written(ctx)).toEqual(before);
  });

  test("an open report of the same person, filed before the block it brings, answers the same and writes nothing", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    // Written as no route writes it, a report with no block: the open report answers first.
    await ctx.client.query(
      `INSERT INTO report (reporter_account_id, reported_account_id, source, reason)
       VALUES ($1, $2, 'card', 'other')`,
      [a.accountId, b.accountId],
    );
    const before = await written(ctx);
    expect((await report(ctx.app, a, id)).status).toBe(204);
    expect(await written(ctx)).toEqual(before);
    expect((await detailOf(ctx.app, a, id)).state).toBe("open");
  });

  test("Only the conversation's two people can report or block from it", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "a", body: "Hei" }],
    });
    const before = await written(ctx);
    for (const answer of [
      await report(ctx.app, c, id),
      await blockFrom(ctx.app, c, id),
      await report(ctx.app, a, randomUUID()),
      await blockFrom(ctx.app, a, randomUUID()),
    ]) {
      expect(answer.status).toBe(404);
      expect(await errorCode(answer)).toBe("not_found");
    }
    expect(await written(ctx)).toEqual(before);
    // What the contract refuses, before anything is looked up.
    for (const body of [
      {},
      { reason: "rude" },
      { reason: "other", note: " " },
      { accountId: b.accountId, reason: "other" },
    ]) {
      expect((await report(ctx.app, a, id, body)).status).toBe(400);
    }
    expect((await report(ctx.app, a, "not-a-uuid")).status).toBe(400);
    expect((await blockFrom(ctx.app, a, "not-a-uuid")).status).toBe(400);
    // Without a session, or with one nobody issued.
    for (const headers of [{}, { authorization: "Bearer nobody" }] as Record<string, string>[]) {
      const reported = await ctx.app.request(`/conversations/${id}/report`, {
        method: "POST",
        headers: jsonHeaders(headers),
        body: JSON.stringify({ reason: "other" }),
      });
      expect(reported.status).toBe(401);
      expect(
        (await ctx.app.request(`/conversations/${id}/block`, { method: "POST", headers })).status,
      ).toBe(401);
    }
    // The caller erased between the guard and the hold: refused as nobody, nothing written.
    for (const ask of [report, blockFrom]) {
      const racing = interleaved(ctx.client, /state <> 'deleted' FOR SHARE/, () =>
        ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [c.accountId]),
      );
      const app = createApp({
        config: testConfig(),
        logger: (await captureLogger()).logger,
        db: racing,
      });
      const other = await conversationBetween(ctx.client, c.accountId, b.accountId);
      expect((await ask(app, c, other)).status).toBe(404);
      expect(racing.ran()).toBe(true);
      await ctx.client.query("UPDATE account SET state = 'active' WHERE id = $1", [c.accountId]);
    }
    expect(await written(ctx)).toEqual(before);
    // The other person erased: nobody is left to report or block.
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    const late = await report(ctx.app, a, id);
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe("report_window_closed");
    // A block back answers as set, whoever is still there (ADR-030 §6), and writes nothing.
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    // Nothing of the report's or the block's; the erasure closed B's conversations itself.
    const after = await written(ctx);
    expect({ ...after, closed: 0 }).toEqual({ ...before, closed: 0 });
  });

  test("The night prunes a report's copy, and the photos only it held of an erased sender", async ({
    ctx,
  }) => {
    const media = testMediaDeps();
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const fromA = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: a.accountId,
      side: "a",
      caption: null,
      store: media.store,
    });
    const fromB = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: b.accountId,
      side: "b",
      caption: "Tässä",
      store: media.store,
    });
    expect((await report(app, a, id)).status).toBe(204);
    await eraseAccount(
      { db: ctx.client, logger, now: () => new Date(), media: media.deps },
      b.accountId,
    );
    // The copy holds B's photo through the erasure, its objects with it.
    const photosOf = async () =>
      (
        await ctx.client.query<{ id: string }>(
          "SELECT id FROM photo WHERE id = ANY($1) ORDER BY id",
          [[fromA.photoId, fromB.photoId]],
        )
      ).rows.map((row) => row.id);
    expect(await photosOf()).toEqual([fromA.photoId, fromB.photoId].sort());
    expect(media.store.objects.has(objectKey(fromB.key, "full"))).toBe(true);

    // Within the twelve months, nothing goes.
    const now = new Date();
    expect(await pruneReports({ db: ctx.client, logger, store: media.store }, now)).toEqual({
      pruned: 0,
      photos: 0,
      objects: 0,
    });
    await ctx.client.query("UPDATE report SET created_at = $1", [
      new Date(now.getTime() - (REPORT_RETENTION_DAYS + 1) * DAY),
    ]);
    expect(await pruneReports({ db: ctx.client, logger, store: media.store }, now)).toEqual({
      pruned: 1,
      photos: 1,
      objects: 3,
    });
    expect(await count(ctx, "SELECT count(*) AS n FROM report_message")).toBe(0);
    // B's photo and objects are gone; A's photo is A's, live, and stays.
    expect(await photosOf()).toEqual([fromA.photoId]);
    expect(media.store.objects.has(objectKey(fromB.key, "full"))).toBe(false);
    expect(media.store.objects.has(objectKey(fromA.key, "full"))).toBe(true);
    // The block stays: it is not the report's.
    expect(await blockStands(ctx, a, b)).toBe(1);
    // An erasure that held a photo while the prune let its last copy go leaves
    // it on the erased account with no copy: the next night's sweep takes it.
    const c = await person(ctx, "Cia");
    const late = await conversationBetween(ctx.client, c.accountId, a.accountId);
    const fromC = await photoMessage(ctx.client, {
      conversationId: late,
      accountId: c.accountId,
      side: "a",
      caption: null,
      store: media.store,
    });
    await ctx.client.query("UPDATE account SET state = 'deleted' WHERE id = $1", [c.accountId]);
    expect(await pruneReports({ db: ctx.client, logger, store: media.store }, now)).toEqual({
      pruned: 0,
      photos: 1,
      objects: 3,
    });
    expect(await count(ctx, "SELECT count(*) AS n FROM photo WHERE id = $1", [fromC.photoId])).toBe(
      0,
    );
    expect(media.store.objects.has(objectKey(fromC.key, "full"))).toBe(false);
  });

  test("The photos a report's copy holds outlive their sender's erasure, and leave the conversation", async ({
    ctx,
  }) => {
    const media = testMediaDeps();
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const fromA = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: a.accountId,
      side: "a",
      caption: "Minä",
      store: media.store,
    });
    const fromB = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: b.accountId,
      side: "b",
      caption: "Sinä",
      store: media.store,
    });
    expect((await report(app, a, id)).status).toBe(204);
    const owned = await count(ctx, "SELECT count(*) AS n FROM photo WHERE account_id = $1", [
      a.accountId,
    ]);
    const summary = await eraseAccount(
      { db: ctx.client, logger, now: () => new Date(), media: media.deps },
      a.accountId,
    );
    // Held for the copy: not among the erased, the row and the objects stay.
    expect(await count(ctx, "SELECT count(*) AS n FROM photo WHERE id = $1", [fromA.photoId])).toBe(
      1,
    );
    expect(summary.photos).toBe(owned - 1);
    // The log line says why: one held for the copy (#351).
    expect(summary.heldPhotos).toBe(1);
    expect(media.store.objects.has(objectKey(fromA.key, "full"))).toBe(true);
    // In the conversation it reads removed, as an erased person's photo does.
    const page = await app.request(`/conversations/${id}/messages`, { headers: b.headers });
    expect(page.status).toBe(200);
    // B's own photo, in the same copy, is B's and stays as it was.
    const messages = MessagePage.parse(await page.json()).messages;
    expect(messages.map((m) => [m.body, m.photo?.photoId ?? null])).toEqual([
      ["Sinä", fromB.photoId],
      ["Minä", null],
    ]);
  });
});

describe("a block from a conversation", () => {
  test("A block from a conversation ends it for both and hides it from the blocker", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    const once = await written(ctx);
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    expect(await written(ctx)).toEqual(once);
    expect(await blockStands(ctx, a, b)).toBe(1);
    const closed = await ctx.client.query(
      "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
      [id],
    );
    expect(closed.rows).toEqual([{ closed_how: "block", closed_by: "a" }]);
    for (const answer of [
      await ctx.app.request(`/conversations/${id}`, { headers: a.headers }),
      await ctx.app.request(`/conversations/${id}/messages`, { headers: a.headers }),
      await ctx.app.request(`/conversations/${id}/contacts`, { headers: a.headers }),
      await ctx.app.request(`/conversations/${id}/unmatch`, { method: "POST", headers: a.headers }),
      await report(ctx.app, a, id),
    ]) {
      expect(answer.status).toBe(404);
    }
    const seen = await detailOf(ctx.app, b, id);
    expect(seen).toMatchObject({ state: "closed", closedHow: "unmatch", counterpart: null });
    const later = async () => {
      const sent = await ctx.app.request(`/conversations/${id}/messages`, {
        method: "POST",
        headers: jsonHeaders(b.headers),
        body: JSON.stringify({ clientId: randomUUID(), body: "Miksi?" }),
      });
      expect(sent.status).toBe(409);
      expect(await errorCode(sent)).toBe("conversation_closed");
    };
    await later();
    // B erased: the block still answers A as set, and A still cannot report what A hid.
    await eraseAccount(
      { db: ctx.client, logger: (await captureLogger()).logger, now: () => new Date() },
      b.accountId,
    );
    expect((await blockFrom(ctx.app, a, id)).status).toBe(204);
    expect((await report(ctx.app, a, id)).status).toBe(404);
  });
  test("A block from a card ends the conversation between the two as well", async ({ ctx }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const elsewhere = await conversationBetween(ctx.client, a.accountId, c.accountId);
    await cardShown(ctx.client, a.accountId, b.accountId);
    const answer = await ctx.app.request("/blocks", {
      method: "POST",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ accountId: b.accountId }),
    });
    expect(answer.status).toBe(204);
    const closed = await ctx.client.query(
      "SELECT id, closed_how, closed_by FROM conversation WHERE id = ANY($1) ORDER BY id = $2 DESC",
      [[id, elsewhere], id],
    );
    expect(closed.rows).toEqual([
      { id, closed_how: "block", closed_by: "a" },
      { id: elsewhere, closed_how: null, closed_by: null },
    ]);
    // The window to report it starts for the one blocked.
    expect(await detailOf(ctx.app, b, id)).toMatchObject({
      state: "closed",
      closedHow: "unmatch",
      reportable: true,
    });
  });

  test("A report from a card ends the conversation between the two as a block does", async ({
    ctx,
  }) => {
    const a = await person(ctx, "Aino");
    const b = await person(ctx, "Bea");
    const c = await person(ctx, "Cia");
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, {
      messages: [{ from: "b", body: "Moi" }],
    });
    const elsewhere = await conversationBetween(ctx.client, a.accountId, c.accountId);
    const kept = await ctx.app.request("/contacts/telegram", {
      method: "PUT",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ value: "piiprobe_4711" }),
    });
    expect(kept.status).toBe(200);
    for (const where of [id, elsewhere]) {
      const shared = await ctx.app.request(`/conversations/${where}/contacts/telegram`, {
        method: "POST",
        headers: a.headers,
      });
      expect(shared.status).toBe(200);
    }
    await cardShown(ctx.client, a.accountId, b.accountId);
    const answer = await ctx.app.request("/reports", {
      method: "POST",
      headers: jsonHeaders(a.headers),
      body: JSON.stringify({ accountId: b.accountId, reason: "harassment" }),
    });
    expect(answer.status).toBe(204);
    const closed = await ctx.client.query(
      "SELECT id, closed_how, closed_by FROM conversation WHERE id = ANY($1) ORDER BY id = $2 DESC",
      [[id, elsewhere], id],
    );
    expect(closed.rows).toEqual([
      { id, closed_how: "block", closed_by: "a" },
      { id: elsewhere, closed_how: null, closed_by: null },
    ]);
    // A card's report names no conversation and copies nothing.
    const filed = await ctx.client.query("SELECT source, conversation_id FROM report");
    expect(filed.rows).toEqual([{ source: "card", conversation_id: null }]);
    expect(await count(ctx, "SELECT count(*) AS n FROM report_message")).toBe(0);
    // What A shared there ends with it; the share elsewhere stands.
    const shares = await ctx.client.query(
      "SELECT conversation_id, ended_how FROM contact_share ORDER BY conversation_id = $1 DESC",
      [id],
    );
    expect(shares.rows).toEqual([
      { conversation_id: id, ended_how: "closed" },
      { conversation_id: elsewhere, ended_how: null },
    ]);
    expect((await ctx.app.request(`/conversations/${id}`, { headers: a.headers })).status).toBe(
      404,
    );
    expect(await detailOf(ctx.app, b, id)).toMatchObject({
      state: "closed",
      closedHow: "unmatch",
      counterpart: null,
      reportable: true,
    });
  });
});

// The other person's erasure or ban against a report or a block from the
// conversation (#351), on connections of their own: both take the person's
// rows before the conversation, so the report or the block waits for them
// there, never holding the conversation the erasure or the ban must close.
// Taken the other way round, each would wait for the other until Postgres
// broke the cycle with 40P01.
const MIGRATIONS = resolve(import.meta.dirname, "../../../../packages/db/drizzle");

describe("a report or a block against the other person's erasure or ban", () => {
  it("a report waits for the other person's erasure before it takes the conversation, and then finds nobody to report", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({
        connectionString: url,
        max: 4,
        applicationName: "kuutti-351-erase",
      });
      const erasing = await pool.connect();
      const reporting = await pool.connect();
      try {
        await migrate(pool, MIGRATIONS);
        const { a, b, id } = await twoInAConversation(pool, "kuutti 351 erase");
        const { logger } = await captureLogger();
        const erasurePid = await pidOf(erasing);
        const reportPid = await pidOf(reporting);
        await erasing.query("BEGIN");
        await reporting.query("BEGIN");
        // The erasure holds B's account and is about to close B's conversations
        // when the report starts; it goes on once the report waits for it.
        let waited = false;
        let report: ReturnType<typeof watched<unknown>> | undefined;
        const db = interleaved(erasing, /WITH closing AS/, async () => {
          const at = new Date();
          report = watched(
            recordConversationReport(reporting, {
              reporterAccountId: a,
              conversationId: id,
              reason: "harassment",
              note: null,
              at,
              since: new Date(at.getTime() - DAY),
              limit: 5,
              afterCloseDays: 30,
            }),
          );
          waited = await waitsFor(pool, reportPid, erasurePid, report.settled);
        });
        const erased = await eraseAccount({ db, logger, now: () => new Date() }, b).then(
          () => null,
          (error: unknown) => String(error),
        );
        await erasing.query(erased === null ? "COMMIT" : "ROLLBACK");
        const reported = await report?.outcome;
        await reporting.query("COMMIT");
        expect(db.ran()).toBe(true);
        expect(waited).toBe(true);
        expect({ erased, reported }).toEqual({
          erased: null,
          reported: { outcome: "window_closed" },
        });
        const count = async (table: string) =>
          Number(
            (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
          );
        expect(await count("report")).toBe(0);
        expect(await count("block")).toBe(0);
      } finally {
        erasing.release();
        reporting.release();
        await pool.end();
      }
    });
  }, 30_000);

  it("a block waits for a ban of the other person before it takes the conversation, and then closes it as the block's", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 4, applicationName: "kuutti-351-ban" });
      const banning = await pool.connect();
      const blocking = await pool.connect();
      try {
        await migrate(pool, MIGRATIONS);
        const { a, b, id } = await twoInAConversation(pool, "kuutti 351 ban");
        const banPid = await pidOf(banning);
        const blockPid = await pidOf(blocking);
        await banning.query("BEGIN");
        await blocking.query("BEGIN");
        let waited = false;
        let block: ReturnType<typeof watched<unknown>> | undefined;
        const db = interleaved(banning, /WITH closing AS/, async () => {
          block = watched(
            recordConversationBlock(blocking, { accountId: a, conversationId: id, at: new Date() }),
          );
          waited = await waitsFor(pool, blockPid, banPid, block.settled);
        });
        const banned = await applySanction(db, {
          accountId: b,
          kind: "ban",
          reason: "harassment",
          note: "Threats.",
          actor: null,
          at: new Date(),
        }).then(
          () => null,
          (error: unknown) => String(error),
        );
        await banning.query(banned === null ? "COMMIT" : "ROLLBACK");
        const blocked = await block?.outcome;
        await blocking.query("COMMIT");
        expect(db.ran()).toBe(true);
        expect(waited).toBe(true);
        expect({ banned, blocked }).toEqual({ banned: null, blocked: "blocked" });
        // The ban closed it first; the block, after it, wrote its own close over it.
        const closed = await pool.query(
          "SELECT closed_how, closed_by FROM conversation WHERE id = $1",
          [id],
        );
        expect(closed.rows).toEqual([{ closed_how: "block", closed_by: "a" }]);
      } finally {
        banning.release();
        blocking.release();
        await pool.end();
      }
    });
  }, 30_000);
});

// A report from a conversation against the other person's erasure when the
// report holds them first, against a close in flight, and against the other
// person's report (#351, ADR-030 §12), each on connections of their own over
// committed rows, the one let go on only once Postgres says the other waits
// for it (pg_blocking_pids, never a sleep).
describe("a report from a conversation in a race", () => {
  const filedAt = (db: Queryable, reporter: string, conversationId: string, at = new Date()) =>
    recordConversationReport(db, {
      reporterAccountId: reporter,
      conversationId,
      reason: "harassment",
      note: null,
      at,
      since: new Date(at.getTime() - DAY),
      limit: 5,
      afterCloseDays: 30,
    });

  /** A database of the test's own, migrated, with a pool and two connections of it. */
  async function withTwoConnections(
    name: string,
    work: (pool: Pool, first: PoolClient, second: PoolClient) => Promise<void>,
  ): Promise<void> {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 4, applicationName: name });
      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await migrate(pool, MIGRATIONS);
        await work(pool, first, second);
      } finally {
        first.release();
        second.release();
        await pool.end();
      }
    });
  }

  const countIn = async (pool: Pool, sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

  it("a report that holds the other person before their erasure is filed, and the erasure keeps the photo its copy names", async () => {
    await withTwoConnections("kuutti-351-report-first", async (pool, reporting, erasing) => {
      const { logger } = await captureLogger();
      const { a, b, id } = await twoInAConversation(pool, "kuutti 351 report first");
      const sent = await photoMessage(pool, { conversationId: id, accountId: b, side: "b" });
      const reportPid = await pidOf(reporting);
      const erasurePid = await pidOf(erasing);
      await reporting.query("BEGIN");
      await erasing.query("BEGIN");
      // The report holds both people (FOR KEY SHARE) and is about to write;
      // B's erasure starts then and waits for it on B's account row.
      let erasure: ReturnType<typeof watched<null>> | undefined;
      let waited = false;
      const db = interleaved(reporting, /^INSERT INTO report \(/, async () => {
        const started = watched(
          eraseAccount({ db: erasing, logger, now: () => new Date() }, b).then(() => null),
        );
        erasure = started;
        waited = await waitsFor(pool, erasurePid, reportPid, started.settled);
      });
      const filed = await filedAt(db, a, id).catch((error: unknown) => String(error));
      await reporting.query(typeof filed === "string" ? "ROLLBACK" : "COMMIT");
      const erased = await erasure?.outcome;
      await erasing.query(erased === null ? "COMMIT" : "ROLLBACK");
      expect(db.ran()).toBe(true);
      expect(waited).toBe(true);
      expect({ filed, erased }).toEqual({ filed: { outcome: "filed" }, erased: null });
      // The copy names B's photo; the erasure, let go after the commit, held it.
      const copy = await pool.query(
        `SELECT rm.side, rm.photo_id FROM report_message rm JOIN report r ON r.id = rm.report_id
         WHERE r.conversation_id = $1 ORDER BY rm.seq`,
        [id],
      );
      expect(copy.rows).toEqual([{ side: "reported", photo_id: sent.photoId }]);
      expect(
        await countIn(pool, "SELECT count(*) AS n FROM photo WHERE id = $1", [sent.photoId]),
      ).toBe(1);
      const message = await pool.query("SELECT photo_id FROM message WHERE conversation_id = $1", [
        id,
      ]);
      expect(message.rows).toEqual([{ photo_id: null }]);
      expect(
        await countIn(
          pool,
          "SELECT count(*) AS n FROM account WHERE id = $1 AND state = 'deleted'",
          [b],
        ),
      ).toBe(1);
    });
  }, 30_000);

  it("a report that waits for a close in flight reads it, and is filed within the window", async () => {
    await withTwoConnections("kuutti-351-report-close", async (pool, ending, reporting) => {
      const { a, b, id } = await twoInAConversation(pool, "kuutti 351 report close");
      const asB = await signInAs(pool, b);
      const { logger } = await captureLogger();
      const endedAt = new Date(Date.now() - 60_000);
      // B's unmatch, through its route, on a connection of its own: written, not yet committed.
      const app = createApp({ config: testConfig(), logger, db: ending, now: () => endedAt });
      await ending.query("BEGIN");
      const ended = await app.request(`/conversations/${id}/unmatch`, {
        method: "POST",
        headers: asB.headers,
      });
      expect(ended.status).toBe(204);
      const endPid = await pidOf(ending);
      const reportPid = await pidOf(reporting);
      await reporting.query("BEGIN");
      const pending = watched(filedAt(reporting, a, id));
      const waited = await waitsFor(pool, reportPid, endPid, pending.settled);
      await ending.query("COMMIT");
      const filed = await pending.outcome;
      await reporting.query(typeof filed === "string" ? "ROLLBACK" : "COMMIT");
      expect(waited).toBe(true);
      expect(filed).toEqual({ outcome: "filed" });
      // The unmatch's time stays; the close becomes the reporter's block.
      const close = await pool.query(
        "SELECT closed_at, closed_how, closed_by FROM conversation WHERE id = $1",
        [id],
      );
      expect(close.rows).toEqual([{ closed_at: endedAt, closed_how: "block", closed_by: "a" }]);
      expect(await countIn(pool, "SELECT count(*) AS n FROM report")).toBe(1);
      expect(await countIn(pool, "SELECT count(*) AS n FROM block")).toBe(1);
    });
  }, 30_000);

  it("two reports at once from both sides are both filed, each with its copy, and the conversation closes once", async () => {
    await withTwoConnections("kuutti-351-two-reports", async (pool, first, second) => {
      const { a, b, id } = await twoInAConversation(pool, "kuutti 351 two reports");
      await pool.query(
        `INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
         VALUES ($1, 1, 'a', gen_random_uuid(), 'text', 'Hei', now()),
                ($1, 2, 'b', gen_random_uuid(), 'text', 'Moi', now())`,
        [id],
      );
      await pool.query("UPDATE conversation SET next_seq = 3 WHERE id = $1", [id]);
      const firstPid = await pidOf(first);
      const secondPid = await pidOf(second);
      // A's report holds the conversation, written and not yet committed; B's waits for it.
      const atA = new Date(Date.now() - 1000);
      await first.query("BEGIN");
      const fromA = await filedAt(first, a, id, atA);
      await second.query("BEGIN");
      const pending = watched(filedAt(second, b, id));
      const waited = await waitsFor(pool, secondPid, firstPid, pending.settled);
      await first.query("COMMIT");
      const fromB = await pending.outcome;
      await second.query(typeof fromB === "string" ? "ROLLBACK" : "COMMIT");
      expect(waited).toBe(true);
      expect({ fromA, fromB }).toEqual({
        fromA: { outcome: "filed" },
        fromB: { outcome: "filed" },
      });
      // Each copy is the whole thread, each line's side seen from its own report.
      const copies = await pool.query<{ reporter: string; sides: string[] }>(
        `SELECT r.reporter_account_id AS reporter,
                array_agg(rm.side::text ORDER BY rm.seq) AS sides
         FROM report r JOIN report_message rm ON rm.report_id = r.id
         WHERE r.conversation_id = $1 GROUP BY r.reporter_account_id`,
        [id],
      );
      expect(new Map(copies.rows.map((row) => [row.reporter, row.sides]))).toEqual(
        new Map([
          [a, ["reporter", "reported"]],
          [b, ["reported", "reporter"]],
        ]),
      );
      expect(await countIn(pool, "SELECT count(*) AS n FROM block")).toBe(2);
      // Closed once, at A's report, as A's block; B's report found it closed and kept it so.
      const close = await pool.query(
        "SELECT closed_at, closed_how, closed_by FROM conversation WHERE id = $1",
        [id],
      );
      expect(close.rows).toEqual([{ closed_at: atA, closed_how: "block", closed_by: "a" }]);
    });
  }, 30_000);
});
