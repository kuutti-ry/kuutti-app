import type { Queryable } from "@kuutti/db";
import type { ConversationCloseKind, MessageKind } from "@kuutti/schema";

// The chat's statements (#348, ADR-031). Raw parameterised SQL, as in the
// other slices: Deps.db is the Queryable seam the tests hand a rolled-back
// transaction through. Every statement a person's request runs starts from
// the caller's own participant row (`me.account_id = $1`), rule 6: a
// conversation the caller is not in is never read. The block table is read
// here, and only here in the slice, for the one thing a block does to a
// conversation: it ends it for both, and the blocker never sees it again
// (ADR-030 §2 and §6; safety/no-signal.test.ts lists this file).

export type Side = "a" | "b";

/** The caller blocked the counterpart, by identity: what hides a conversation from its blocker while both are linked. */
const CALLER_BLOCKED = `(them.account_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM block bl
  JOIN account x ON x.identity_id = bl.blocker_identity_id
  JOIN account y ON y.identity_id = bl.blocked_identity_id
  WHERE x.id = me.account_id AND y.id = them.account_id))`;

/**
 * Who may see the conversation at all: not its blocker, by a block that
 * stands (while both are linked) or by the close a block wrote (after an
 * erasure has cut the link). Everyone else sees it, open or closed.
 */
const VISIBLE_TO_CALLER = `NOT ${CALLER_BLOCKED}
  AND (c.closed_how IS DISTINCT FROM 'block' OR c.closed_by IS DISTINCT FROM me.side)`;

/**
 * The messages the caller may read: their own, and the counterpart's except
 * those sent during a shadow ban that is still open (ADR-024 §6, #105),
 * which appear once it is lifted.
 */
const MESSAGE_VISIBLE = `(m.side = me.side OR NOT EXISTS (
  SELECT 1 FROM sanction s
  WHERE s.account_id = them.account_id AND s.kind = 'shadow_ban'
    AND s.lifted_at IS NULL AND s.created_at <= m.created_at))`;

const FROM_CALLER = `FROM conversation_participant me
  JOIN conversation c ON c.id = me.conversation_id
  JOIN conversation_participant them ON them.conversation_id = c.id AND them.side <> me.side`;

export type ConversationRow = {
  id: string;
  openedAt: Date;
  lastMessageAt: Date | null;
  nextSeq: number;
  archivedAt: Date | null;
  closedAt: Date | null;
  closedHow: ConversationCloseKind | null;
  side: Side;
  readUpTo: number;
  /** Null once the counterpart is erased. */
  counterpartId: string | null;
  counterpartReadUpTo: number;
  /** A block stands between the two, set by either; the conversation reads closed. */
  blocked: boolean;
  counterpartName: string | null;
  counterpartBirthYear: number | null;
  counterpartBirthMonth: number | null;
  last: {
    seq: number;
    side: Side;
    kind: MessageKind;
    body: string | null;
    createdAt: Date;
  } | null;
  unread: number;
};

type Row = Record<string, unknown>;

const conversationFrom = (r: Row): ConversationRow => ({
  id: r.id as string,
  openedAt: r.opened_at as Date,
  lastMessageAt: (r.last_message_at as Date | null) ?? null,
  nextSeq: r.next_seq as number,
  archivedAt: (r.archived_at as Date | null) ?? null,
  closedAt: (r.closed_at as Date | null) ?? null,
  closedHow: (r.closed_how as ConversationCloseKind | null) ?? null,
  side: r.side as Side,
  readUpTo: r.read_up_to as number,
  counterpartId: (r.counterpart_id as string | null) ?? null,
  counterpartReadUpTo: r.counterpart_read_up_to as number,
  blocked: r.blocked === true,
  counterpartName: (r.counterpart_name as string | null) ?? null,
  counterpartBirthYear: (r.birth_year as number | null) ?? null,
  counterpartBirthMonth: (r.birth_month as number | null) ?? null,
  last:
    r.last_seq === null || r.last_seq === undefined
      ? null
      : {
          seq: r.last_seq as number,
          side: r.last_side as Side,
          kind: r.last_kind as MessageKind,
          body: (r.last_body as string | null) ?? null,
          createdAt: r.last_created_at as Date,
        },
  unread: r.unread as number,
});

const CONVERSATION_COLUMNS = `c.id, c.opened_at, c.last_message_at, c.next_seq, c.archived_at,
  c.closed_at, c.closed_how, me.side, me.read_up_to,
  them.account_id AS counterpart_id, them.read_up_to AS counterpart_read_up_to,
  (them.account_id IS NOT NULL AND blocked_between(me.account_id, them.account_id)) AS blocked,
  p.display_name AS counterpart_name, a.birth_year, a.birth_month,
  lm.seq AS last_seq, lm.side AS last_side, lm.kind AS last_kind, lm.body AS last_body,
  lm.created_at AS last_created_at,
  (SELECT count(*)::int FROM message m
   WHERE m.conversation_id = c.id AND m.side <> me.side AND m.seq > me.read_up_to
     AND ${MESSAGE_VISIBLE}) AS unread`;

const CONVERSATION_JOINS = `LEFT JOIN account a ON a.id = them.account_id
  LEFT JOIN profile p ON p.account_id = them.account_id
  LEFT JOIN LATERAL (
    SELECT m.seq, m.side, m.kind, m.body, m.created_at FROM message m
    WHERE m.conversation_id = c.id AND ${MESSAGE_VISIBLE}
    ORDER BY m.seq DESC LIMIT 1) lm ON true`;

/** The caller's conversations, newest first by the last message they may see, else by the opening. */
export async function listConversations(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<ConversationRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${CONVERSATION_COLUMNS}
     ${FROM_CALLER}
     ${CONVERSATION_JOINS}
     WHERE me.account_id = $1 AND ${VISIBLE_TO_CALLER}
     ORDER BY coalesce(lm.created_at, c.opened_at) DESC, c.id
     LIMIT $2`,
    [accountId, limit],
  );
  return rows.map(conversationFrom);
}

/** One conversation as the caller sees it, or null: not theirs, nobody's, or hidden from its blocker. */
export async function findConversation(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${CONVERSATION_COLUMNS}
     ${FROM_CALLER}
     ${CONVERSATION_JOINS}
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND ${VISIBLE_TO_CALLER}`,
    [accountId, conversationId],
  );
  return rows[0] ? conversationFrom(rows[0]) : null;
}

export type MessageRow = {
  id: string;
  seq: number;
  side: Side;
  kind: MessageKind;
  body: string | null;
  createdAt: Date;
  clientId: string;
};

const messageFrom = (r: Row): MessageRow => ({
  id: r.id as string,
  seq: r.seq as number,
  side: r.side as Side,
  kind: r.kind as MessageKind,
  body: (r.body as string | null) ?? null,
  createdAt: r.created_at as Date,
  clientId: r.client_id as string,
});

/**
 * A page of what the caller may read: back from `before` (or from the
 * newest) newest first, or onward from `after` oldest first. Empty for a
 * conversation the caller may not see; the route has asked first.
 */
export async function listMessages(
  db: Queryable,
  input: {
    accountId: string;
    conversationId: string;
    before?: number | undefined;
    after?: number | undefined;
    limit: number;
  },
): Promise<MessageRow[]> {
  const onward = input.after !== undefined;
  const { rows } = await db.query<Row>(
    `SELECT m.id, m.seq, m.side, m.kind, m.body, m.created_at, m.client_id
     ${FROM_CALLER}
     JOIN message m ON m.conversation_id = c.id
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND ${VISIBLE_TO_CALLER}
       AND ${MESSAGE_VISIBLE}
       AND ($3::int IS NULL OR m.seq < $3) AND ($4::int IS NULL OR m.seq > $4)
     ORDER BY m.seq ${onward ? "ASC" : "DESC"}
     LIMIT $5`,
    [input.accountId, input.conversationId, input.before ?? null, input.after ?? null, input.limit],
  );
  return rows.map(messageFrom);
}

/**
 * The read mark, raised and never lowered, never past the newest message; 0
 * rows for a conversation the caller may not see. The participant row is
 * the caller's own (rule 6).
 */
export async function markRead(
  db: Queryable,
  input: { accountId: string; conversationId: string; upTo: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE conversation_participant me
     SET read_up_to = greatest(me.read_up_to, least($3::int, c.next_seq - 1))
     FROM conversation c, conversation_participant them
     WHERE me.account_id = $1 AND me.conversation_id = $2
       AND c.id = me.conversation_id
       AND them.conversation_id = c.id AND them.side <> me.side
       AND ${VISIBLE_TO_CALLER}`,
    [input.accountId, input.conversationId, input.upTo],
  );
  return (result.rowCount ?? 0) > 0;
}

// The send (ADR-031 §3). The caller's account row is held first (FOR SHARE,
// as every writer takes it: an erasure finishes first, or waits), then the
// conversation's row is locked; what the send decides on is read after the
// lock, in a statement of its own, so a block, a close or an erasure that
// committed while it waited is seen.

/**
 * The caller's account, held against an erasure or a sanction until the send
 * commits, and only in a state the session guard admits with the identity in
 * good standing (`insertSession`'s test): a send already past the guard when
 * a suspension or a ban commits writes nothing.
 */
export async function holdLiveAccount(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM account a JOIN identity i ON i.id = a.identity_id
     WHERE a.id = $1 AND i.standing = 'ok'
       AND a.state IN ('registered', 'active', 'paused', 'shadow_banned')
     FOR SHARE OF a`,
    [accountId],
  );
  return rows.length > 0;
}

/** Locks the conversation's row through the caller's participant row; false when there is none. */
export async function lockConversation(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT c.id FROM conversation c
     WHERE c.id = $2
       AND EXISTS (SELECT 1 FROM conversation_participant me
                   WHERE me.conversation_id = c.id AND me.account_id = $1)
     FOR UPDATE`,
    [accountId, conversationId],
  );
  return rows.length > 0;
}

export type SendState = {
  side: Side;
  openedAt: Date;
  lastMessageAt: Date | null;
  /** Hidden from the caller: they blocked the other. */
  hidden: boolean;
  /** Closed for writing: a close, a block either way, or the counterpart erased. */
  closed: boolean;
};

/** What the send decides on, read after the lock (a fresh snapshot). */
export async function readSendState(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<SendState | null> {
  const { rows } = await db.query<Row>(
    `SELECT me.side, c.opened_at, c.last_message_at,
            NOT (${VISIBLE_TO_CALLER}) AS hidden,
            (c.closed_at IS NOT NULL OR them.account_id IS NULL
              OR blocked_between(me.account_id, them.account_id)) AS closed
     ${FROM_CALLER}
     WHERE me.account_id = $1 AND me.conversation_id = $2`,
    [accountId, conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    side: row.side as Side,
    openedAt: row.opened_at as Date,
    lastMessageAt: (row.last_message_at as Date | null) ?? null,
    hidden: row.hidden === true,
    closed: row.closed === true,
  };
}

/** The message a client id already names in the caller's conversation, whichever side wrote it. */
export async function findByClientId(
  db: Queryable,
  input: { accountId: string; conversationId: string; clientId: string },
): Promise<MessageRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT m.id, m.seq, m.side, m.kind, m.body, m.created_at, m.client_id
     FROM conversation_participant me
     JOIN message m ON m.conversation_id = me.conversation_id
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND m.client_id = $3`,
    [input.accountId, input.conversationId, input.clientId],
  );
  return rows[0] ? messageFrom(rows[0]) : null;
}

/**
 * The message, its sequence taken from the conversation in the same
 * statement that moves the conversation on: the next sequence, the time of
 * the last message, and out of the archive (TD-13). The row is locked
 * already; the UPDATE would wait for it anyway, so two sends at once are two
 * consecutive sequences however they interleave.
 */
export async function insertMessage(
  db: Queryable,
  input: {
    accountId: string;
    conversationId: string;
    side: Side;
    clientId: string;
    body: string;
    at: Date;
  },
): Promise<MessageRow> {
  const { rows } = await db.query<Row>(
    `WITH bumped AS (
       UPDATE conversation c SET next_seq = next_seq + 1, last_message_at = $5, archived_at = NULL
       WHERE c.id = $1
         AND EXISTS (SELECT 1 FROM conversation_participant me
                     WHERE me.conversation_id = c.id AND me.account_id = $6 AND me.side = $2::conversation_side)
       RETURNING next_seq - 1 AS seq)
     INSERT INTO message (conversation_id, seq, side, client_id, kind, body, created_at)
     SELECT $1, bumped.seq, $2::conversation_side, $3, 'text', $4, $5 FROM bumped
     RETURNING id, seq, side, kind, body, created_at, client_id`,
    [input.conversationId, input.side, input.clientId, input.body, input.at, input.accountId],
  );
  const row = rows[0];
  if (!row) throw new Error("message insert returned no row");
  return messageFrom(row);
}

// Closing (ADR-031 §2). A conversation closes once and keeps its first
// reason; whoever closes it, a block that stands between the two wins, so
// that the blocker never sees it again: `closed_by` is the blocker's side,
// the one who stays preferred where both blocked.

export type Closed = {
  conversationId: string;
  how: ConversationCloseKind;
  messages: number;
  /** The account on the other side from the one acted on, null once erased. */
  counterpartId: string | null;
  /** It was open or archived until now; false where only a block rewrote an earlier close. */
  closedNow: boolean;
};

/**
 * Closes every open or archived conversation of the accounts, for `how` (an
 * erasure, a sanction), or for the block where one stands. Where a block
 * stands, a conversation closed earlier for another reason is written as the
 * block's too, so that its blocker never sees it again once the link a live
 * block test needs is cut (a ban, then a block from an earlier card, then the
 * erasure: ADR-031 §2).
 */
export async function closeConversationsOf(
  db: Queryable,
  input: { accountIds: string[]; how: ConversationCloseKind; at: Date },
): Promise<Closed[]> {
  if (input.accountIds.length === 0) return [];
  const blockedBy = (blocker: string, blocked: string) => `EXISTS (
    SELECT 1 FROM block bl
    JOIN account x ON x.identity_id = bl.blocker_identity_id
    JOIN account y ON y.identity_id = bl.blocked_identity_id
    WHERE x.id = ${blocker} AND y.id = ${blocked})`;
  const { rows } = await db.query<Row>(
    `WITH closing AS (
       SELECT c.id, c.closed_at IS NULL AS was_open, me.side AS my_side, them.side AS their_side,
              them.account_id AS counterpart_id,
              (them.account_id IS NOT NULL AND ${blockedBy("them.account_id", "me.account_id")}) AS they_blocked,
              (them.account_id IS NOT NULL AND ${blockedBy("me.account_id", "them.account_id")}) AS i_blocked
       ${FROM_CALLER}
       WHERE me.account_id = ANY($1::uuid[])),
     touched AS (
       SELECT * FROM closing
       WHERE was_open OR they_blocked OR i_blocked)
     UPDATE conversation c
     SET closed_at = coalesce(c.closed_at, $2),
         closed_how = CASE WHEN touched.they_blocked OR touched.i_blocked THEN 'block'
                           ELSE $3::conversation_close END,
         closed_by = CASE WHEN touched.they_blocked THEN touched.their_side
                          ELSE touched.my_side END
     FROM touched
     WHERE c.id = touched.id
     RETURNING c.id, c.closed_how, c.next_seq - 1 AS messages, touched.counterpart_id, touched.was_open`,
    [input.accountIds, input.at, input.how],
  );
  return rows.map((r) => ({
    conversationId: r.id as string,
    how: r.closed_how as ConversationCloseKind,
    messages: r.messages as number,
    counterpartId: (r.counterpart_id as string | null) ?? null,
    closedNow: r.was_open === true,
  }));
}

/**
 * The erased person's messages that the counterpart never received: sent
 * during a shadow ban still open (ADR-024 §6). The ban goes with the
 * erasure (ADR-024 §8), so they would appear afterwards; they go first.
 */
export async function deleteWithheldMessagesOf(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query(
    `DELETE FROM message m
     USING conversation_participant me
     WHERE me.account_id = $1 AND m.conversation_id = me.conversation_id AND m.side = me.side
       AND EXISTS (SELECT 1 FROM sanction s
                   WHERE s.account_id = $1 AND s.kind = 'shadow_ban'
                     AND s.lifted_at IS NULL AND s.created_at <= m.created_at)`,
    [accountId],
  );
  return result.rowCount ?? 0;
}

/** Cuts the person's link to their conversations (TD-7): the rows stay for the counterpart. The conversations it was cut from. */
export async function unlinkParticipant(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ conversation_id: string }>(
    "UPDATE conversation_participant SET account_id = NULL WHERE account_id = $1 RETURNING conversation_id",
    [accountId],
  );
  return rows.map((r) => r.conversation_id);
}

/**
 * Of these conversations, the ones nobody is linked to any more: both people
 * erased, so nobody is left whom the words are kept for (TD-7, ADR-031 §5).
 * They go, with their messages and participant rows by cascade.
 */
export async function deleteUnlinkedConversations(
  db: Queryable,
  conversationIds: string[],
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const result = await db.query(
    `DELETE FROM conversation c
     WHERE c.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM conversation_participant p
                       WHERE p.conversation_id = c.id AND p.account_id IS NOT NULL)`,
    [conversationIds],
  );
  return result.rowCount ?? 0;
}

export type Archived = {
  conversationId: string;
  openedAt: Date;
  messages: number;
  accountIds: string[];
};

/**
 * The night's archive (TD-13): every conversation neither archived nor
 * closed whose last message, or opening, is older than the window. A break
 * stops no clock (ADR-022 §4).
 */
export async function archiveSilent(
  db: Queryable,
  input: { at: Date; olderThan: Date },
): Promise<Archived[]> {
  const { rows } = await db.query<Row>(
    `UPDATE conversation c SET archived_at = $1
     WHERE c.archived_at IS NULL AND c.closed_at IS NULL
       AND coalesce(c.last_message_at, c.opened_at) < $2
     RETURNING c.id, c.opened_at, c.next_seq - 1 AS messages,
       ARRAY(SELECT p.account_id FROM conversation_participant p
             WHERE p.conversation_id = c.id AND p.account_id IS NOT NULL ORDER BY p.side) AS account_ids`,
    [input.at, input.olderThan],
  );
  return rows.map((r) => ({
    conversationId: r.id as string,
    openedAt: r.opened_at as Date,
    messages: r.messages as number,
    accountIds: r.account_ids as string[],
  }));
}

export type ExportedRow = {
  id: string;
  openedAt: Date;
  archivedAt: Date | null;
  closedAt: Date | null;
  closedHow: ConversationCloseKind | null;
  counterpartLinked: boolean;
  blocked: boolean;
  /** The person's own messages and the counterpart's readable ones, in order; the counterpart's without words. */
  lines: Array<{ mine: boolean; at: Date; body: string | null; length: number }>;
};

/**
 * Every conversation of the person for their export (ADR-031 §5), oldest
 * first: their own messages with the words, the counterpart's they could
 * read as a time and a length, the words never read out of the database.
 */
export async function exportConversationsOf(
  db: Queryable,
  accountId: string,
): Promise<ExportedRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT c.id, c.opened_at, c.archived_at, c.closed_at, c.closed_how,
            them.account_id IS NOT NULL AS counterpart_linked,
            (them.account_id IS NOT NULL AND blocked_between(me.account_id, them.account_id)) AS blocked,
            coalesce((
              SELECT json_agg(json_build_object(
                       'mine', m.side = me.side,
                       'at', m.created_at,
                       'body', CASE WHEN m.side = me.side THEN m.body END,
                       'length', char_length(m.body))
                     ORDER BY m.seq)
              FROM message m
              WHERE m.conversation_id = c.id AND ${MESSAGE_VISIBLE}), '[]'::json) AS lines
     ${FROM_CALLER}
     WHERE me.account_id = $1
     ORDER BY c.opened_at, c.id`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    openedAt: r.opened_at as Date,
    archivedAt: (r.archived_at as Date | null) ?? null,
    closedAt: (r.closed_at as Date | null) ?? null,
    closedHow: (r.closed_how as ConversationCloseKind | null) ?? null,
    counterpartLinked: r.counterpart_linked === true,
    blocked: r.blocked === true,
    lines: (
      r.lines as Array<{ mine: boolean; at: string; body: string | null; length: number | null }>
    ).map((line) => ({
      mine: line.mine,
      at: new Date(line.at),
      body: line.body,
      length: line.length ?? 0,
    })),
  }));
}

// The socket's fan-out (#349, ADR-031 §5). A notification names a
// conversation, a session or a block, never a person's text; the listener
// finds whom it concerns with the two routing reads below, and then reads
// what each of them may see through their own participant row (rule 6), with
// every rule of the reads above: the block, the close, the shadow ban.

/** The accounts still linked to a conversation, with their sides: whom a notification about it concerns. */
export async function participantsOf(
  db: Queryable,
  conversationId: string,
): Promise<Array<{ accountId: string; side: Side }>> {
  const { rows } = await db.query<{ account_id: string; side: Side }>(
    `SELECT account_id, side FROM conversation_participant
     WHERE conversation_id = $1 AND account_id IS NOT NULL ORDER BY side`,
    [conversationId],
  );
  return rows.map((r) => ({ accountId: r.account_id, side: r.side }));
}

/** The conversations between the accounts of two identities: what a block between them ends. */
export async function conversationsBetweenIdentities(
  db: Queryable,
  a: string,
  b: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT p.conversation_id AS id
     FROM conversation_participant p
     JOIN account pa ON pa.id = p.account_id
     JOIN conversation_participant q ON q.conversation_id = p.conversation_id AND q.side <> p.side
     JOIN account qa ON qa.id = q.account_id
     WHERE pa.identity_id = $1 AND qa.identity_id = $2`,
    [a, b],
  );
  return rows.map((r) => r.id);
}

/** One message as the caller reads it, with the caller's side, or null when it is not theirs to read. */
export async function messageFor(
  db: Queryable,
  input: { accountId: string; conversationId: string; seq: number },
): Promise<{ side: Side; row: MessageRow } | null> {
  const { rows } = await db.query<Row>(
    `SELECT me.side AS my_side, m.id, m.seq, m.side, m.kind, m.body, m.created_at, m.client_id
     ${FROM_CALLER}
     JOIN message m ON m.conversation_id = c.id
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND m.seq = $3
       AND ${VISIBLE_TO_CALLER} AND ${MESSAGE_VISIBLE}`,
    [input.accountId, input.conversationId, input.seq],
  );
  const row = rows[0];
  return row ? { side: row.my_side as Side, row: messageFrom(row) } : null;
}
