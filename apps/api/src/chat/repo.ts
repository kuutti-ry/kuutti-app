import type { Queryable } from "@kuutti/db";
import type {
  ContactKind,
  ContactShareEnd,
  ConversationCloseKind,
  MessageKind,
  PhotoDescription,
} from "@kuutti/schema";

// The chat's statements (#348, ADR-031). Raw parameterised SQL, as in the
// other slices: Deps.db is the Queryable seam the tests hand a rolled-back
// transaction through. Every statement a person's request runs starts from
// the caller's own participant row (`me.account_id = $1`), rule 6: a
// conversation the caller is not in is never read. The block table is read
// here, and only here in the slice, for the one thing a block does to a
// conversation: it ends it for both, and the blocker never sees it again
// (ADR-030 §2 and §6; safety/no-signal.test.ts lists this file). A report's
// frozen copy is written here, from the thread, and read nowhere in the
// slice (`copyConversation`, #351; listed there too).

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
 * A shadow ban (`s`) of the account that withholds from the other person of
 * conversation `c` what the account did under it (ADR-024 §6, #105): one
 * still open, or one lifted only after the conversation had ended, so a lift
 * never shows an ended conversation anything new (#470).
 */
// shortcut: the lift's time and the close's are each the request's, not the
// commit's, so an admin's ban and a moderator's lift of the same person within
// one wait on the sanction lock can be stored in the wrong order; taking the
// time after `lockAccountForSanction` in the sanctions' writes would close it.
const withholdingBan = (account: string) => `s.account_id = ${account} AND s.kind = 'shadow_ban'
    AND (s.lifted_at IS NULL OR s.lifted_at > c.closed_at)`;
const WITHHOLDING_BAN = withholdingBan("them.account_id");

/** A read mark held to the newest message of conversation `c` from before `began`. */
const markBefore = (mark: string, began: string) => `least(${mark}, coalesce((
      SELECT max(pm.seq) FROM message pm
      WHERE pm.conversation_id = c.id AND pm.created_at < ${began}), 0))`;

/**
 * The messages the caller may read: their own, and the counterpart's except
 * those sent during a shadow ban that withholds them, which appear once it
 * is lifted while the conversation is open.
 */
const MESSAGE_VISIBLE = `(m.side = me.side OR NOT EXISTS (
  SELECT 1 FROM sanction s
  WHERE ${WITHHOLDING_BAN} AND s.created_at <= m.created_at))`;

/**
 * The counterpart's read mark as the caller sees it. Under a shadow ban that
 * withholds, it goes no further than the newest message from before the
 * earliest such ban began, as presence shows nobody online (ADR-031 §9):
 * a mark moving beside a missing photo and no Online is a pattern only a
 * shadow ban makes (#470). The mark only rises, so nothing read before the
 * ban stops showing as read, and the true mark shows at the lift.
 */
// shortcut: a line from before the ban that the person reads only after it
// began still shows as read; the mark as it stood when the ban began, a
// column written by the ban, would close that.
const COUNTERPART_READ_UP_TO = `CASE WHEN wb.began IS NULL THEN them.read_up_to
    ELSE ${markBefore("them.read_up_to", "wb.began")} END`;

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

// Nothing is unread in a closed conversation: its marks stand still
// (`markRead`), so a count there could never be read away.
const CONVERSATION_COLUMNS = `c.id, c.opened_at, c.last_message_at, c.next_seq, c.archived_at,
  c.closed_at, c.closed_how, me.side, me.read_up_to,
  them.account_id AS counterpart_id, ${COUNTERPART_READ_UP_TO} AS counterpart_read_up_to,
  (them.account_id IS NOT NULL AND blocked_between(me.account_id, them.account_id)) AS blocked,
  p.display_name AS counterpart_name, a.birth_year, a.birth_month,
  lm.seq AS last_seq, lm.side AS last_side, lm.kind AS last_kind, lm.body AS last_body,
  lm.created_at AS last_created_at,
  CASE WHEN c.closed_at IS NOT NULL THEN 0 ELSE
    (SELECT count(*)::int FROM message m
     WHERE m.conversation_id = c.id AND m.side <> me.side AND m.seq > me.read_up_to
       AND ${MESSAGE_VISIBLE}) END AS unread`;

const CONVERSATION_JOINS = `LEFT JOIN account a ON a.id = them.account_id
  LEFT JOIN profile p ON p.account_id = them.account_id
  LEFT JOIN LATERAL (
    SELECT m.seq, m.side, m.kind, m.body, m.created_at FROM message m
    WHERE m.conversation_id = c.id AND ${MESSAGE_VISIBLE}
    ORDER BY m.seq DESC LIMIT 1) lm ON true
  LEFT JOIN LATERAL (
    SELECT min(s.created_at) AS began FROM sanction s WHERE ${WITHHOLDING_BAN}) wb ON true`;

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
  /** A photo message's photo (#350), null on a text and once the photo went. `key` never leaves the API. */
  photo: {
    id: string;
    key: string;
    blurhash: string;
    width: number;
    height: number;
    description: PhotoDescription | null;
  } | null;
};

const messageFrom = (r: Row): MessageRow => ({
  id: r.id as string,
  seq: r.seq as number,
  side: r.side as Side,
  kind: r.kind as MessageKind,
  body: (r.body as string | null) ?? null,
  createdAt: r.created_at as Date,
  clientId: r.client_id as string,
  photo: !r.photo_id
    ? null
    : {
        id: r.photo_id as string,
        key: r.photo_key as string,
        blurhash: r.photo_blurhash as string,
        width: r.photo_width as number,
        height: r.photo_height as number,
        description: (r.photo_description as PhotoDescription | null) ?? null,
      },
});

// A message with its photo (#350): the photo only when it is a message photo,
// so a profile photo can never be read through a message; its description is
// the check's, from the review row, as the photos' reads take it.
const MESSAGE_COLUMNS = `m.id, m.seq, m.side, m.kind, m.body, m.created_at, m.client_id,
  ph.id AS photo_id, ph.key AS photo_key, ph.blurhash AS photo_blurhash,
  ph.width AS photo_width, ph.height AS photo_height,
  (SELECT r.description FROM photo_review r WHERE r.photo_id = ph.id) AS photo_description`;
const MESSAGE_PHOTO = "LEFT JOIN photo ph ON ph.id = m.photo_id AND ph.purpose = 'message'";

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
    `SELECT ${MESSAGE_COLUMNS}
     ${FROM_CALLER}
     JOIN message m ON m.conversation_id = c.id
     ${MESSAGE_PHOTO}
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
 * the caller's own (rule 6). A closed conversation's marks stand where the
 * close found them, whoever closed it and how: the blocker can no longer
 * reach it and the one who ended it still can, so a mark moving after an
 * end would tell the other person it was not a block (ADR-030 §12). The
 * answer stays the same, and the trigger fires only on a change. A mark
 * whose statement saw the conversation open lands as a read before the
 * close, which it was.
 */
export async function markRead(
  db: Queryable,
  input: { accountId: string; conversationId: string; upTo: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE conversation_participant me
     SET read_up_to = CASE WHEN c.closed_at IS NULL
                           THEN greatest(me.read_up_to, least($3::int, c.next_seq - 1))
                           ELSE me.read_up_to END
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
  /** The conversation's messages so far, either side's. */
  messages: number;
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
    `SELECT me.side, c.opened_at, c.last_message_at, c.next_seq - 1 AS messages,
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
    messages: row.messages as number,
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
    `SELECT ${MESSAGE_COLUMNS}
     FROM conversation_participant me
     JOIN message m ON m.conversation_id = me.conversation_id
     ${MESSAGE_PHOTO}
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
    /** A text's words, or a photo's caption (null without one). */
    body: string | null;
    at: Date;
    /** A photo message's photo (#350), written in the same transaction; absent for a text. */
    photoId?: string;
  },
): Promise<MessageRow> {
  const { rows } = await db.query<Row>(
    `WITH bumped AS (
       UPDATE conversation c SET next_seq = next_seq + 1, last_message_at = $5, archived_at = NULL
       WHERE c.id = $1
         AND EXISTS (SELECT 1 FROM conversation_participant me
                     WHERE me.conversation_id = c.id AND me.account_id = $6 AND me.side = $2::conversation_side)
       RETURNING next_seq - 1 AS seq),
     m AS (
       INSERT INTO message (conversation_id, seq, side, client_id, kind, body, photo_id, created_at)
       SELECT $1, bumped.seq, $2::conversation_side, $3, $7::message_kind, $4, $8, $5 FROM bumped
       RETURNING *)
     SELECT ${MESSAGE_COLUMNS} FROM m ${MESSAGE_PHOTO}`,
    [
      input.conversationId,
      input.side,
      input.clientId,
      input.body,
      input.at,
      input.accountId,
      input.photoId ? "photo" : "text",
      input.photoId ?? null,
    ],
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
 * erasure, a sanction, an unmatch), or for the block where one stands. Where
 * a block stands, a conversation closed earlier for another reason is written
 * as the block's too, so that its blocker never sees it again once the link a
 * live block test needs is cut (a ban, then a block from an earlier card,
 * then the erasure: ADR-031 §2). `conversationId` keeps it to one
 * conversation (an unmatch, #351), `counterpartId` to those with one other
 * account (a block, #351).
 */
export async function closeConversationsOf(
  db: Queryable,
  input: {
    accountIds: string[];
    how: ConversationCloseKind;
    at: Date;
    conversationId?: string;
    counterpartId?: string;
  },
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
       WHERE me.account_id = ANY($1::uuid[])
         AND ($4::uuid IS NULL OR c.id = $4) AND ($5::uuid IS NULL OR them.account_id = $5)),
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
    [
      input.accountIds,
      input.at,
      input.how,
      input.conversationId ?? null,
      input.counterpartId ?? null,
    ],
  );
  const closed = rows.map((r) => ({
    conversationId: r.id as string,
    how: r.closed_how as ConversationCloseKind,
    messages: r.messages as number,
    counterpartId: (r.counterpart_id as string | null) ?? null,
    closedNow: r.was_open === true,
  }));
  // What either person shared there ends with the close (#103), in a
  // statement of its own: one after the close's, so a share that held the
  // conversation's lock while the close waited for it is ended too.
  if (closed.length > 0) {
    await db.query(
      `UPDATE contact_share SET ended_at = $2, ended_how = 'closed'
       WHERE conversation_id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [closed.map((close) => close.conversationId), input.at],
    );
  }
  return closed;
}

/**
 * The erased person's photos that a report's frozen copy still holds (#351):
 * erasure keeps their rows (`erasePhotosOfAccount`'s `keep`), and they leave
 * the person's messages here, which read "Photo removed" as a photo that
 * went does (#350). Only the copy names them now, until the night's prune
 * lets them go. The person's own rows, by the photo's account (rule 6).
 */
export async function detachPhotosOf(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query(
    `UPDATE message m SET photo_id = NULL
     FROM photo p
     WHERE p.id = m.photo_id AND p.account_id = $1`,
    [accountId],
  );
  return result.rowCount ?? 0;
}

/**
 * The erased person's messages that the counterpart never received: sent
 * during a shadow ban that withholds them (ADR-024 §6). The ban goes with
 * the erasure (ADR-024 §8), so they would appear afterwards; they go first.
 */
export async function deleteWithheldMessagesOf(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query(
    `DELETE FROM message m
     USING conversation_participant me, conversation c
     WHERE me.account_id = $1 AND m.conversation_id = me.conversation_id AND m.side = me.side
       AND c.id = me.conversation_id
       AND EXISTS (SELECT 1 FROM sanction s
                   WHERE ${withholdingBan("$1")} AND s.created_at <= m.created_at)`,
    [accountId],
  );
  return result.rowCount ?? 0;
}

/**
 * The erased person's read marks as the counterpart saw them: held where a
 * shadow ban withheld them (#470). The ban goes with the erasure, so the mark
 * the person moved under it would show afterwards, under "Deleted user";
 * it goes back to what was shown, first. Nobody saw it higher.
 */
export async function holdWithheldMarksOf(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `UPDATE conversation_participant me
     SET read_up_to = ${markBefore("me.read_up_to", "wb.began")}
     FROM conversation c,
          LATERAL (SELECT min(s.created_at) AS began FROM sanction s
                   WHERE ${withholdingBan("$1")}) wb
     WHERE me.account_id = $1 AND c.id = me.conversation_id AND wb.began IS NOT NULL`,
    [accountId],
  );
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
 * Silent since $1, the window's start (TD-13): neither archived nor closed,
 * and its last message, or opening, and newest share of a contact (#103)
 * older: a share brings a conversation back as a message does, and keeps it
 * out as a message does. The newest share as an anti-join: none at or after
 * the window's start. A break stops no clock (ADR-022 §4).
 */
const SILENT = `c.archived_at IS NULL AND c.closed_at IS NULL
  AND coalesce(c.last_message_at, c.opened_at) < $1
  AND NOT EXISTS (SELECT 1 FROM contact_share s
                  WHERE s.conversation_id = c.id AND s.shared_at >= $1)`;

/**
 * The night's candidates, their rows locked until the archive commits: a send
 * or a share in flight holds its conversation's row (lockConversation) until
 * it commits, and this waits for it. A share writes only its own row, and a
 * statement that waited for a row re-checks at most that row, never the
 * shares, so the archive that follows (archiveSilent, in the same
 * transaction) reads them afresh.
 */
export async function lockSilent(db: Queryable, olderThan: Date): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id FROM conversation c WHERE ${SILENT} ORDER BY c.id FOR UPDATE`,
    [olderThan],
  );
  return rows.map((r) => r.id);
}

/**
 * The night's archive (TD-13) of the conversations lockSilent locked that
 * are still silent: a statement of its own, so under READ COMMITTED it sees
 * a share that committed while lockSilent waited for it, and leaves that
 * conversation out.
 */
export async function archiveSilent(
  db: Queryable,
  input: { ids: string[]; at: Date; olderThan: Date },
): Promise<Archived[]> {
  if (input.ids.length === 0) return [];
  const { rows } = await db.query<Row>(
    `UPDATE conversation c SET archived_at = $2
     WHERE c.id = ANY($3::uuid[]) AND ${SILENT}
     RETURNING c.id, c.opened_at, c.next_seq - 1 AS messages,
       ARRAY(SELECT p.account_id FROM conversation_participant p
             WHERE p.conversation_id = c.id AND p.account_id IS NOT NULL ORDER BY p.side) AS account_ids`,
    [input.olderThan, input.at, input.ids],
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
  /** The person's own shares of a contact there (#103), oldest first: the record, never a value. */
  shares: Array<{
    kind: ContactKind;
    sharedAt: Date;
    endedAt: Date | null;
    endedHow: ContactShareEnd | null;
  }>;
  /** The person's own messages and the counterpart's readable ones, in order; the counterpart's without words. */
  lines: Array<{
    mine: boolean;
    at: Date;
    kind: MessageKind;
    body: string | null;
    length: number;
    /** The person's own photo message's photo (#350), while it is there; null otherwise. */
    photoId: string | null;
  }>;
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
                       'kind', m.kind,
                       'body', CASE WHEN m.side = me.side THEN m.body END,
                       'length', char_length(m.body),
                       'photoId', CASE WHEN m.side = me.side THEN m.photo_id END)
                     ORDER BY m.seq)
              FROM message m
              WHERE m.conversation_id = c.id AND ${MESSAGE_VISIBLE}), '[]'::json) AS lines,
            coalesce((
              SELECT json_agg(json_build_object(
                       'kind', s.kind, 'sharedAt', s.shared_at,
                       'endedAt', s.ended_at, 'endedHow', s.ended_how)
                     ORDER BY s.shared_at, s.id)
              FROM contact_share s
              WHERE s.conversation_id = c.id AND s.side = me.side), '[]'::json) AS shares
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
    shares: (
      r.shares as Array<{
        kind: ContactKind;
        sharedAt: string;
        endedAt: string | null;
        endedHow: ContactShareEnd | null;
      }>
    ).map((share) => ({
      kind: share.kind,
      sharedAt: new Date(share.sharedAt),
      endedAt: share.endedAt === null ? null : new Date(share.endedAt),
      endedHow: share.endedHow,
    })),
    lines: (
      r.lines as Array<{
        mine: boolean;
        at: string;
        kind: MessageKind;
        body: string | null;
        length: number | null;
        photoId: string | null;
      }>
    ).map((line) => ({
      mine: line.mine,
      at: new Date(line.at),
      kind: line.kind,
      body: line.body,
      length: line.length ?? 0,
      photoId: line.photoId ?? null,
    })),
  }));
}

// A report or a block from a conversation (#351, ADR-030 §12): the safety
// slice writes the report and the block; these read the conversation it
// names, and write its copy, through the caller's own participant row (rule
// 6), after its row is locked, so the copy is the thread as it stood when
// the report was filed: a send either committed before the lock and is
// copied, or waits for the report's close and is refused.

export type ReportedConversation = {
  /** The caller blocked the other person: the conversation is hidden from them. */
  hidden: boolean;
  /** The other person's account; null once they are erased. */
  counterpartId: string | null;
  closedAt: Date | null;
};

/**
 * The conversation the caller names, its row locked until the caller's
 * transaction ends; null when it is not theirs. The two people's account and
 * identity rows are held first (FOR KEY SHARE, what the report's and the
 * block's foreign keys take anyway), and only then the conversation: an
 * erasure and a ban take a person's rows before the conversations they close,
 * so taking the conversation first and the other person's rows after would
 * deadlock with them. Who the other person is is read once without a lock and
 * afresh after it, which decides.
 */
export async function lockForReport(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<ReportedConversation | null> {
  const other = await db.query<{ account_id: string | null }>(
    `SELECT them.account_id FROM conversation_participant me
     JOIN conversation_participant them
       ON them.conversation_id = me.conversation_id AND them.side <> me.side
     WHERE me.account_id = $1 AND me.conversation_id = $2`,
    [accountId, conversationId],
  );
  const counterpart = other.rows[0]?.account_id ?? null;
  await db.query(
    `SELECT 1 FROM account a JOIN identity i ON i.id = a.identity_id
     WHERE a.id = ANY($1::uuid[]) FOR KEY SHARE OF a, i`,
    [counterpart ? [accountId, counterpart] : [accountId]],
  );
  if (!(await lockConversation(db, accountId, conversationId))) return null;
  const { rows } = await db.query<Row>(
    `SELECT NOT (${VISIBLE_TO_CALLER}) AS hidden, them.account_id AS counterpart_id, c.closed_at
     ${FROM_CALLER}
     WHERE me.account_id = $1 AND me.conversation_id = $2`,
    [accountId, conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    hidden: row.hidden === true,
    counterpartId: (row.counterpart_id as string | null) ?? null,
    closedAt: (row.closed_at as Date | null) ?? null,
  };
}

/**
 * A report's frozen copy (#351, ADR-030 §12): every message of the
 * conversation, both people's, those a shadow ban withholds from the caller
 * included, since the moderators read the thread as it is, not as one side
 * was shown it; each line's side seen from the report. One INSERT … SELECT,
 * so the words never pass through the process (rule 5). Through the caller's
 * own participant row, under the conversation's lock the caller holds: a send
 * either committed before the lock and is copied, or waits for the report's
 * close and is refused. The number of lines copied.
 */
export async function copyConversation(
  db: Queryable,
  input: { accountId: string; conversationId: string; reportId: string },
): Promise<number> {
  const result = await db.query(
    `INSERT INTO report_message (report_id, seq, side, kind, body, photo_id, created_at)
     SELECT $3, m.seq,
            (CASE WHEN m.side = me.side THEN 'reporter' ELSE 'reported' END)::report_message_side,
            m.kind, m.body, m.photo_id, m.created_at
     FROM conversation_participant me
     JOIN message m ON m.conversation_id = me.conversation_id
     WHERE me.account_id = $1 AND me.conversation_id = $2`,
    [input.accountId, input.conversationId, input.reportId],
  );
  return result.rowCount ?? 0;
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

/**
 * The blocker's side of each conversation between the accounts of two
 * identities: whom a block between them turns the conversation gone for.
 * The blocked side is told by the close's own notification, never by the
 * block's (ADR-030 §6, migration 0063). The listener reads this after the
 * commit, and the blocked person's erasure may have cut their link by then:
 * a conversation of the blocker's whose other side is unlinked and whose
 * close is the blocker's own block counts too, so the blocker's phones still
 * hear that it is gone. That may tell the blocker again of one already gone
 * for them, which tells nobody anything.
 */
export async function blockerSidesBetween(
  db: Queryable,
  blocker: string,
  blocked: string,
): Promise<Array<{ conversationId: string; accountId: string }>> {
  const { rows } = await db.query<{ conversation_id: string; account_id: string }>(
    `SELECT DISTINCT p.conversation_id, p.account_id
     FROM conversation_participant p
     JOIN account pa ON pa.id = p.account_id
     JOIN conversation c ON c.id = p.conversation_id
     JOIN conversation_participant q ON q.conversation_id = p.conversation_id AND q.side <> p.side
     LEFT JOIN account qa ON qa.id = q.account_id
     WHERE pa.identity_id = $1
       AND (qa.identity_id = $2
         OR (q.account_id IS NULL AND c.closed_how = 'block' AND c.closed_by = p.side))
     ORDER BY p.conversation_id`,
    [blocker, blocked],
  );
  return rows.map((r) => ({ conversationId: r.conversation_id, accountId: r.account_id }));
}

/** One message as the caller reads it, with the caller's side, or null when it is not theirs to read. */
export async function messageFor(
  db: Queryable,
  input: { accountId: string; conversationId: string; seq: number },
): Promise<{ side: Side; row: MessageRow } | null> {
  const { rows } = await db.query<Row>(
    `SELECT me.side AS my_side, ${MESSAGE_COLUMNS}
     ${FROM_CALLER}
     JOIN message m ON m.conversation_id = c.id
     ${MESSAGE_PHOTO}
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND m.seq = $3
       AND ${VISIBLE_TO_CALLER} AND ${MESSAGE_VISIBLE}`,
    [input.accountId, input.conversationId, input.seq],
  );
  const row = rows[0];
  return row ? { side: row.my_side as Side, row: messageFrom(row) } : null;
}

// Contacts (#103, ADR-031 §11): a person's own stored pieces, and their
// shares in a conversation. A piece is read by its owner (`account_id = $1`),
// and by the other person of a conversation only through the caller's own
// participant row, while it is shared there, the conversation open between
// the two, no block between them, and neither the share begun nor the piece
// changed under a shadow ban of its owner's that is still open. A share's row
// holds no value: the conversation shows the stored piece while the share
// stands.

export type ContactRow = { kind: ContactKind; value: string; updatedAt: Date };

const contactFrom = (r: Row): ContactRow => ({
  kind: r.kind as ContactKind,
  value: r.value as string,
  updatedAt: r.updated_at as Date,
});

/** Open between the two for the caller: not closed, the counterpart linked, no block either way. */
const OPEN_BETWEEN = `c.closed_at IS NULL AND them.account_id IS NOT NULL
  AND NOT blocked_between(me.account_id, them.account_id)`;

/**
 * A shadow ban of the counterpart's still open (ADR-024 §6); with `since`, an
 * SQL expression, only one begun at or before it. The one rule of what the
 * ban withholds of the contacts, for the reads and for the frame alike.
 */
const counterpartShadowBanned = (since?: string) => `EXISTS (
  SELECT 1 FROM sanction x
  WHERE x.account_id = them.account_id AND x.kind = 'shadow_ban'
    AND x.lifted_at IS NULL${since ? ` AND x.created_at <= ${since}` : ""})`;

/**
 * A share of the counterpart's that the caller may see (`s` the share, `k`
 * its piece): none begun, and none whose piece was changed, during a shadow
 * ban of its owner's still open, as MESSAGE_VISIBLE withholds a message; it
 * shows once the ban is lifted. A share begun before the ban and left as it
 * was stays shown.
 */
const SHARE_VISIBLE = `NOT ${counterpartShadowBanned("greatest(s.shared_at, k.updated_at)")}`;

/** The caller's stored pieces, in the kinds' order (the enum's, CONTACT_KINDS). */
export async function listContacts(db: Queryable, accountId: string): Promise<ContactRow[]> {
  const { rows } = await db.query<Row>(
    "SELECT kind, value, updated_at FROM contact WHERE account_id = $1 ORDER BY kind",
    [accountId],
  );
  return rows.map(contactFrom);
}

/**
 * Keeps the caller's piece of that kind, the one stored before replaced
 * (migration 0059 announces a shared one's change). `updated_at` is when the
 * value last changed: the same value kept again leaves it, so it changes
 * nothing that SHARE_VISIBLE reads under a shadow ban.
 */
export async function upsertContact(
  db: Queryable,
  input: { accountId: string; kind: ContactKind; value: string; at: Date },
): Promise<ContactRow> {
  const { rows } = await db.query<Row>(
    `INSERT INTO contact (account_id, kind, value, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, kind)
       DO UPDATE SET value = EXCLUDED.value,
         updated_at = CASE WHEN contact.value = EXCLUDED.value THEN contact.updated_at
                           ELSE EXCLUDED.updated_at END
     RETURNING kind, value, updated_at`,
    [input.accountId, input.kind, input.value, input.at],
  );
  const row = rows[0];
  if (!row) throw new Error("contact upsert returned no row");
  return contactFrom(row);
}

/** Removes the caller's piece of that kind; false when there was none. */
export async function deleteContact(
  db: Queryable,
  input: { accountId: string; kind: ContactKind },
): Promise<boolean> {
  const result = await db.query("DELETE FROM contact WHERE account_id = $1 AND kind = $2", [
    input.accountId,
    input.kind,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** Every stored piece of the person's: what erasure deletes (ADR-007 §4). */
export async function deleteContactsOf(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM contact WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

/**
 * The caller's piece of that kind, held until the share commits: a removal
 * waits for it, and then ends the share it begins. False when none is kept.
 */
export async function holdContact(
  db: Queryable,
  accountId: string,
  kind: ContactKind,
): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM contact k WHERE k.account_id = $1 AND k.kind = $2 FOR SHARE OF k",
    [accountId, kind],
  );
  return rows.length > 0;
}

/** A share begun on the caller's side; false when one of that kind stands already. */
export async function beginShare(
  db: Queryable,
  input: { accountId: string; conversationId: string; kind: ContactKind; at: Date },
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO contact_share (conversation_id, side, kind, shared_at)
     SELECT me.conversation_id, me.side, $3, $4 FROM conversation_participant me
     WHERE me.account_id = $1 AND me.conversation_id = $2
     ON CONFLICT (conversation_id, side, kind) WHERE ended_at IS NULL DO NOTHING
     RETURNING id`,
    [input.accountId, input.conversationId, input.kind, input.at],
  );
  return rows.length > 0;
}

/** Out of the archive, as a message brings it (TD-13); a conversation not archived is left as it is. */
export async function leaveArchive(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<void> {
  await db.query(
    `UPDATE conversation c SET archived_at = NULL
     WHERE c.id = $2 AND c.archived_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM conversation_participant me
                   WHERE me.conversation_id = c.id AND me.account_id = $1)`,
    [accountId, conversationId],
  );
}

/**
 * Ends the caller's standing shares of that kind: in one conversation when
 * it names one (its owner stopped it), else in every conversation (the piece
 * was removed). The number ended.
 */
export async function endShares(
  db: Queryable,
  input: {
    accountId: string;
    conversationId?: string;
    kind: ContactKind;
    how: Exclude<ContactShareEnd, "closed">;
    at: Date;
  },
): Promise<number> {
  const result = await db.query(
    `UPDATE contact_share s SET ended_at = $4, ended_how = $5::contact_share_end
     FROM conversation_participant me
     WHERE me.account_id = $1 AND ($2::uuid IS NULL OR me.conversation_id = $2)
       AND s.conversation_id = me.conversation_id AND s.side = me.side
       AND s.kind = $3 AND s.ended_at IS NULL`,
    [input.accountId, input.conversationId ?? null, input.kind, input.at, input.how],
  );
  return result.rowCount ?? 0;
}

export type ConversationContactRows = {
  mine: Array<{ kind: ContactKind; value: string; shared: boolean }>;
  theirs: Array<{ kind: ContactKind; value: string }>;
};

/**
 * The contacts of one conversation for the caller: their own stored pieces,
 * each shared here or not (never in a closed one), and the counterpart's
 * pieces the caller may see now. Empty for a conversation the caller may not
 * see; the route has asked first.
 */
export async function readConversationContacts(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<ConversationContactRows> {
  const mine = await db.query<Row>(
    `SELECT k.kind, k.value,
            (${OPEN_BETWEEN} AND EXISTS (
              SELECT 1 FROM contact_share s
              WHERE s.conversation_id = c.id AND s.side = me.side AND s.kind = k.kind
                AND s.ended_at IS NULL)) AS shared
     ${FROM_CALLER}
     JOIN contact k ON k.account_id = me.account_id
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND ${VISIBLE_TO_CALLER}
     ORDER BY k.kind`,
    [accountId, conversationId],
  );
  const theirs = await db.query<Row>(
    `SELECT k.kind, k.value
     ${FROM_CALLER}
     JOIN contact_share s ON s.conversation_id = c.id AND s.side = them.side AND s.ended_at IS NULL
     JOIN contact k ON k.account_id = them.account_id AND k.kind = s.kind
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND ${VISIBLE_TO_CALLER}
       AND ${OPEN_BETWEEN} AND ${SHARE_VISIBLE}
     ORDER BY k.kind`,
    [accountId, conversationId],
  );
  return {
    mine: mine.rows.map((r) => ({
      kind: r.kind as ContactKind,
      value: r.value as string,
      shared: r.shared === true,
    })),
    theirs: theirs.rows.map((r) => ({ kind: r.kind as ContactKind, value: r.value as string })),
  };
}

/**
 * Whether a change of the conversation's contacts is told to the caller's
 * sockets: only while it is open between the two (a closed or hidden one has
 * its own frame, and a block is never a signal, ADR-030 §7), and never while
 * the counterpart is under a shadow ban still open (SHARE_VISIBLE's ban). What
 * the counterpart begins or changes meanwhile is withheld from the caller, so
 * a frame for it would have nothing new to read and would tell them of the
 * ban (ADR-024 §6); a piece taken back meanwhile goes at the caller's next
 * read (ADR-031 Open 18).
 */
export async function contactsFrameReaches(
  db: Queryable,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 ${FROM_CALLER}
     WHERE me.account_id = $1 AND me.conversation_id = $2 AND ${OPEN_BETWEEN}
       AND NOT ${counterpartShadowBanned()}`,
    [accountId, conversationId],
  );
  return rows.length > 0;
}

/**
 * The openers a person wrote since `since` (#105, ADR-033): each
 * conversation's first message, sequence 1, on the person's own side, read
 * through their own participant rows (rule 6). Its words go only to
 * `first-messages.ts`, which compares them in memory and returns counts;
 * no word is a statement parameter, so a database error cannot echo one.
 */
export async function openersSince(
  db: Queryable,
  accountId: string,
  since: Date,
): Promise<{ conversationId: string; body: string | null; at: Date }[]> {
  const { rows } = await db.query<{
    conversation_id: string;
    body: string | null;
    created_at: Date;
  }>(
    `SELECT m.conversation_id, m.body, m.created_at
       FROM conversation_participant me
       JOIN message m ON m.conversation_id = me.conversation_id AND m.seq = 1 AND m.side = me.side
      WHERE me.account_id = $1 AND m.created_at > $2`,
    [accountId, since],
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    body: row.body,
    at: row.created_at,
  }));
}
