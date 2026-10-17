import { randomUUID } from "node:crypto";
import type { Queryable } from "@kuutti/db";

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
