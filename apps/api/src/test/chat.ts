import { randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { ConversationDetail, ConversationList, PHOTO_VARIANTS } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { expect } from "vitest";
import type { App } from "../app.ts";
import { type MediaStore, objectKey } from "../media/index.ts";
import { signInAs } from "./account.ts";
import { cardShown } from "./cards.ts";
import { jsonHeaders, type TestContext } from "./harness.ts";
import { people } from "./people.ts";

/**
 * A conversation between two accounts, as the match's record will write it
 * (#348; #100 writes it from the second like): the row and the two
 * participants, side a and side b, and optionally messages, each a minute
 * after the one before. Plain SQL like `signedInAccount`: a test of another
 * slice may not import the chat's internals.
 */
export async function conversationBetween(
  db: Queryable,
  a: string,
  b: string,
  options: {
    openedAt?: Date;
    /** Who wrote each message, in order, and what. */
    messages?: Array<{ from: "a" | "b"; body: string; at?: Date }>;
    archivedAt?: Date;
  } = {},
): Promise<string> {
  const openedAt = options.openedAt ?? new Date(Date.now() - 3_600_000);
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO conversation (opened_at, archived_at) VALUES ($1, $2) RETURNING id",
    [openedAt, options.archivedAt ?? null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("test conversation not written");
  await db.query(
    `INSERT INTO conversation_participant (conversation_id, account_id, side, joined_at)
     VALUES ($1, $2, 'a', $4), ($1, $3, 'b', $4)`,
    [id, a, b, openedAt],
  );
  let seq = 0;
  let last: Date | null = null;
  for (const message of options.messages ?? []) {
    seq += 1;
    const at = message.at ?? new Date(openedAt.getTime() + seq * 60_000);
    await db.query(
      `INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6)`,
      [id, seq, message.from, randomUUID(), message.body, at],
    );
    last = at;
  }
  await db.query("UPDATE conversation SET next_seq = $2, last_message_at = $3 WHERE id = $1", [
    id,
    seq + 1,
    last,
  ]);
  return id;
}

/**
 * A photo sent in the conversation by one side, as the send writes it (#350):
 * a message photo row of the sender's, approved, and its message, the next
 * in sequence. The objects go into the store when one is given, so an
 * erasure, a prune or a reset can be seen to delete them (#351).
 */
export async function photoMessage(
  db: Queryable,
  input: {
    conversationId: string;
    accountId: string;
    side: "a" | "b";
    caption?: string | null;
    store?: MediaStore;
  },
): Promise<{ photoId: string; key: string; seq: number }> {
  const key = randomBytes(32).toString("hex");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose)
     VALUES ($1, $2, 'LKO2?U%2Tw=w', 800, 600, 'approved', 'message') RETURNING id`,
    [input.accountId, key],
  );
  const photoId = rows[0]?.id;
  if (!photoId) throw new Error("test photo not written");
  const sent = await db.query<{ seq: number }>(
    `WITH bumped AS (
       UPDATE conversation SET next_seq = next_seq + 1, last_message_at = now()
       WHERE id = $1 RETURNING next_seq - 1 AS seq)
     INSERT INTO message (conversation_id, seq, side, client_id, kind, body, photo_id)
     SELECT $1, bumped.seq, $2, $3, 'photo', $4, $5 FROM bumped
     RETURNING seq`,
    [input.conversationId, input.side, randomUUID(), input.caption ?? null, photoId],
  );
  const seq = sent.rows[0]?.seq;
  if (seq === undefined) throw new Error("test conversation not found");
  for (const variant of PHOTO_VARIANTS) {
    await input.store?.put(objectKey(key, variant), new Uint8Array([1, 2, 3]), "image/webp");
  }
  return { photoId, key, seq };
}

/**
 * The test's transaction with another request's work slipped in once, just
 * before the first statement matching the pattern, as if a concurrent request
 * had committed at that point (identity/races.test.ts does the same).
 */
export function interleaved(
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

/**
 * The same, with the other work slipped in just after the first statement
 * matching the pattern, as if a concurrent request had committed at that
 * moment (identity/races.test.ts).
 */
export function interleavedAfter(
  db: Queryable,
  after: RegExp,
  other: () => Promise<unknown>,
): Queryable & { ran: () => boolean } {
  let ran = false;
  return {
    ran: () => ran,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const result = await db.query<R>(text, values);
      if (!ran && after.test(text)) {
        ran = true;
        await other();
      }
      return result;
    },
  };
}

/** A person of a conversation test: their account, and the headers of a session of theirs. */
export type ChatPerson = { accountId: string; headers: Record<string, string> };

export async function person(ctx: TestContext, name: string): Promise<ChatPerson> {
  const [accountId] = await people(ctx.client, null, 1, { complete: true });
  if (!accountId) throw new Error("no person");
  await ctx.client.query("UPDATE profile SET display_name = $2 WHERE account_id = $1", [
    accountId,
    name,
  ]);
  return { accountId, headers: (await signInAs(ctx.client, accountId)).headers };
}

export async function detailOf(app: App, who: ChatPerson, id: string): Promise<ConversationDetail> {
  const answer = await app.request(`/conversations/${id}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationDetail.parse(await answer.json());
}

export async function listOf(app: App, who: ChatPerson, query = ""): Promise<ConversationList> {
  const answer = await app.request(`/conversations${query}`, { headers: who.headers });
  expect(answer.status).toBe(200);
  return ConversationList.parse(await answer.json());
}

export const blockFrom = (app: App, who: ChatPerson, id: string) =>
  app.request(`/conversations/${id}/block`, { method: "POST", headers: who.headers });

export const send = (app: App, who: ChatPerson, id: string, body: string) =>
  app.request(`/conversations/${id}/messages`, {
    method: "POST",
    headers: jsonHeaders(who.headers),
    body: JSON.stringify({ clientId: randomUUID(), body }),
  });

export const block = async (ctx: TestContext, blocker: ChatPerson, blocked: ChatPerson) => {
  await cardShown(ctx.client, blocker.accountId, blocked.accountId);
  const answer = await ctx.app.request("/blocks", {
    method: "POST",
    headers: jsonHeaders(blocker.headers),
    body: JSON.stringify({ accountId: blocked.accountId }),
  });
  expect(answer.status).toBe(204);
};

/** Two active accounts with their identities, and a conversation between them, side a and side b. */
export async function twoInAConversation(db: Queryable, label: string) {
  const accounts: string[] = [];
  for (const side of ["a", "b"]) {
    const identity = await db.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
      [`${label} ${side} ${randomUUID()}`],
    );
    const account = await db.query<{ id: string }>(
      "INSERT INTO account (identity_id, state, birth_year, birth_month) VALUES ($1, 'active', 1990, 6) RETURNING id",
      [identity.rows[0]?.id],
    );
    accounts.push(account.rows[0]?.id as string);
  }
  const conversation = await db.query<{ id: string }>(
    "INSERT INTO conversation DEFAULT VALUES RETURNING id",
  );
  const id = conversation.rows[0]?.id as string;
  await db.query(
    `INSERT INTO conversation_participant (conversation_id, account_id, side)
     VALUES ($1, $2, 'a'), ($1, $3, 'b')`,
    [id, accounts[0], accounts[1]],
  );
  return { a: accounts[0] as string, b: accounts[1] as string, id };
}
