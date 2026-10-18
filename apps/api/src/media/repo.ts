import { type Queryable, transaction } from "@kuutti/db";
import type {
  ModerationLabel,
  Photo,
  PhotoCaption,
  PhotoDescription,
  PhotoId,
  PhotoPurpose,
  PhotoRejectionReason,
  PhotoReviewItem,
  PhotoState,
  PhotoVariant,
} from "@kuutti/schema";

// Raw parameterised SQL for the same reason as identity/repo.ts: Deps.db is
// the Queryable seam the test harness hands a rolled-back transaction through.
// Every statement that reads or changes a photo carries the caller's account
// id in its WHERE clause (rule 6); the one exception, countRowsForKey, counts
// rows for an object key across accounts because the object is shared.

type Row = Record<string, unknown>;

export type PhotoRow = Photo & { key: string };

const photoFrom = (r: Row): PhotoRow => ({
  id: r.id as PhotoId,
  key: r.key as string,
  blurhash: r.blurhash as string,
  width: r.width as number,
  height: r.height as number,
  state: r.state as PhotoState,
  rejectionReason: (r.rejection_reason as PhotoRejectionReason | null) ?? null,
  appealable: r.appealable === true,
  position: r.position as number,
  createdAt: (r.created_at as Date).toISOString(),
  caption: (r.caption as PhotoCaption | null) ?? null,
  description: (r.description as PhotoDescription | null) ?? null,
});

// The description (#296) lives on the review row, which goes with the photo;
// one lookup by the primary key per photo, in RETURNING too, so every answer
// that carries a photo carries what the check saw of it.
const COLUMNS = `id, key, blurhash, width, height, state, rejection_reason, appealable, position, created_at, caption,
  (SELECT r.description FROM photo_review r WHERE r.photo_id = photo.id) AS description`;

export async function listPhotos(db: Queryable, accountId: string): Promise<PhotoRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM photo WHERE account_id = $1 AND purpose = 'profile'
     ORDER BY position, created_at`,
    [accountId],
  );
  return rows.map(photoFrom);
}

/** The photos a card may carry (#47): approved only, in the owner's order. */
export async function listApprovedPhotos(db: Queryable, accountId: string): Promise<PhotoRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM photo WHERE account_id = $1 AND purpose = 'profile' AND state = 'approved'
     ORDER BY position, created_at`,
    [accountId],
  );
  return rows.map(photoFrom);
}

/**
 * The photos the tips of #56 count, approved or still in review, with the
 * signals photo_review keeps. Scoped by account_id. A missing review row reads
 * as no labels and zero faces, so a photo approved where no check ran does not
 * invent tips.
 */
export type PhotoTipInput = {
  state: Exclude<PhotoState, "rejected">;
  labels: ModerationLabel[];
  faces: number;
};

export async function listPhotoTipInputs(
  db: Queryable,
  accountId: string,
): Promise<PhotoTipInput[]> {
  const { rows } = await db.query<Row>(
    `SELECT p.state, coalesce(r.labels, '[]'::jsonb) AS labels, coalesce(r.faces, 0) AS faces
     FROM photo p
     LEFT JOIN photo_review r ON r.photo_id = p.id
     WHERE p.account_id = $1 AND p.purpose = 'profile' AND p.state <> 'rejected'
     ORDER BY p.position, p.created_at`,
    [accountId],
  );
  return rows.map((r: Row) => ({
    state: r.state as PhotoTipInput["state"],
    labels: r.labels as ModerationLabel[],
    faces: Number(r.faces),
  }));
}

export async function countPhotos(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM photo WHERE account_id = $1 AND purpose = 'profile'",
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Appends after the account's last photo, and only while the account has
 * fewer than `maxPhotos` and is still live: both are the statement's HAVING
 * clause, so a request that arrives after another's commit (an upload that
 * outlived the erasure of its account, #51) is refused here even when it
 * passed the guard and the service's count. Null means the statement refused. Two
 * inserts that run at the same instant can still both see the old count
 * under READ COMMITTED and both succeed, one photo over the cap and on the
 * same position; the order stays stable through created_at and is renumbered
 * by the next reorder or delete, and the extra photo is the account's own to
 * remove. Closing that window needs a transaction with an advisory lock per
 * account, which the query seam does not offer yet; it is a product cap, not a
 * security boundary, so that waits for the seam.
 */
export async function insertPhoto(
  db: Queryable,
  input: {
    accountId: string;
    key: string;
    blurhash: string;
    width: number;
    height: number;
    maxPhotos: number;
  },
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, position)
     SELECT $1, $2, $3, $4, $5, coalesce(max(position) + 1, 0) FROM photo
     WHERE account_id = $1 AND purpose = 'profile'
     HAVING count(*) < $6
        AND EXISTS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted')
     RETURNING ${COLUMNS}`,
    [input.accountId, input.key, input.blurhash, input.width, input.height, input.maxPhotos],
  );
  return rows[0] ? photoFrom(rows[0]) : null;
}

/** Whether the account still has a live row: an upload's insert refuses a tombstone as it refuses the cap. */
export async function isAccountLive(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted') AS live",
    [accountId],
  );
  return rows[0]?.live === true;
}

/**
 * The photo the caller may be issued a URL for (#52, TD-6): their own in any
 * state, or another account's approved photo on a card they were shown (the
 * card_shown row the card route of #47 writes), while its owner is active: a
 * shadow-banned, suspended, banned or paused owner's photos stop for everyone
 * at once and come back with a lift (ADR-024 §6, the card's rule of ADR-009
 * §6). A block between the two, set by either, stops them for good (#84,
 * ADR-030 §2): `blocked_between` of migration 0051. Both branches carry the
 * caller's account id (rule 6); there is no third.
 */
export async function findVisiblePhoto(
  db: Queryable,
  accountId: string,
  photoId: string,
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM photo
     WHERE id = $2 AND purpose = 'profile'
       AND (account_id = $1
         OR (state = 'approved'
           AND EXISTS (SELECT 1 FROM card_shown WHERE account_id = $1 AND photo_id = photo.id)
           AND EXISTS (SELECT 1 FROM account owner WHERE owner.id = photo.account_id AND owner.state = 'active')
           AND NOT blocked_between($1, photo.account_id)))`,
    [accountId, photoId],
  );
  return rows[0] ? photoFrom(rows[0]) : null;
}

/**
 * The main photo of the counterpart in a conversation of the viewer's (#348,
 * ADR-031 §4): their first approved photo by position, while the owner is
 * active and no block stands between the two, the card's rule (ADR-009 §6,
 * ADR-024 §6, ADR-030 §2). The proof of contact is the conversation, asked in
 * this statement through the viewer's own participant row (rule 6), the
 * owner on its other side, as a card shown is asked for a photo.
 */
export async function findMainPhotoOf(
  db: Queryable,
  input: { viewerAccountId: string; ownerAccountId: string; conversationId: string },
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM photo
     WHERE account_id = $2 AND purpose = 'profile' AND state = 'approved'
       AND EXISTS (SELECT 1 FROM conversation_participant me
                   JOIN conversation_participant them
                     ON them.conversation_id = me.conversation_id AND them.side <> me.side
                   WHERE me.conversation_id = $3 AND me.account_id = $1 AND them.account_id = $2)
       AND EXISTS (SELECT 1 FROM account owner WHERE owner.id = $2 AND owner.state = 'active')
       AND NOT blocked_between($1, $2)
     ORDER BY position, id LIMIT 1`,
    [input.viewerAccountId, input.ownerAccountId, input.conversationId],
  );
  return rows[0] ? photoFrom(rows[0]) : null;
}

/**
 * Whether the viewer was shown a card of the subject (#84): a card_shown row
 * of the viewer's on a photo the subject still has. What a first block or
 * report from a card stands on; scoped by the viewer (rule 6). The rows
 * outlive a sanction, a break and a block; they go with the photo, and with
 * the viewer's erasure.
 */
export async function wasShown(
  db: Queryable,
  input: { viewerAccountId: string; subjectAccountId: string },
): Promise<boolean> {
  // shortcut: the proof goes with the subject's photos, so somebody whose
  // shown photos were all deleted since (an erasure, a new set, M4's sweep of
  // old rows, ADR-008 §3) can no longer be blocked or reported from that card,
  // and a first try answers 404 where a paused person's answers 204 (ADR-030
  // §5, §6); a record of the contact that outlives the photos, or the round's
  // own (#96), lifts it.
  const { rows } = await db.query<{ shown: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM card_shown s JOIN photo p ON p.id = s.photo_id
                    WHERE s.account_id = $1 AND p.account_id = $2) AS shown`,
    [input.viewerAccountId, input.subjectAccountId],
  );
  return rows[0]?.shown === true;
}

export type CardServed = {
  /** Distinct accounts whose cards the viewer was shown since the day started, before this one. */
  used: number;
  /** True when the card was within the budget (or already shown today) and its shown records were written. */
  recorded: boolean;
  /** A block stands between the two (#84, ADR-030 §2): nothing was written, whatever the budget. */
  blocked: boolean;
};

/**
 * A card served to a viewer (#47 calls it, #52 wrote the rule): the shown
 * record for every photo on the card and the card budget in one statement,
 * under the viewer's advisory lock. The budget counts distinct subjects the
 * viewer was shown since the day started (matching_config
 * exposure_cards_per_day); a subject already shown today costs nothing more,
 * and a row from an earlier day takes today's date when its card comes round
 * again, so the card counts against today's budget once (#64 review).
 * A block between the two writes nothing (#84, ADR-030 §2): asked in this
 * statement, so a block that lands after the card builder's own look is
 * still honoured where the record is written. The viewer's account id is in
 * every branch (rule 6); the photo ids are the card the server built, never
 * a request body.
 */
export async function recordCardServed(
  db: Queryable,
  input: {
    viewerAccountId: string;
    subjectAccountId: string;
    photoIds: string[];
    at: Date;
    since: Date;
    limit: number;
  },
): Promise<CardServed> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `card_shown:${input.viewerAccountId}`,
    ]);
    const { rows } = await tx.query<{ used: number; allowed: boolean; blocked: boolean }>(
      `WITH blocked AS (SELECT blocked_between($1, $2) AS b),
            today AS (SELECT DISTINCT p.account_id AS subject
                      FROM card_shown s JOIN photo p ON p.id = s.photo_id
                      WHERE s.account_id = $1 AND s.at >= $5),
            used AS (SELECT count(*)::int AS n FROM today),
            allowed AS (SELECT NOT (SELECT b FROM blocked)
                            AND ((SELECT n FROM used) < $6
                              OR EXISTS (SELECT 1 FROM today WHERE subject = $2)) AS ok),
            ins AS (INSERT INTO card_shown (account_id, photo_id, at)
                    SELECT $1, unnest($3::uuid[]), $4 FROM allowed WHERE allowed.ok
                    ON CONFLICT (account_id, photo_id) DO UPDATE SET at = EXCLUDED.at
                      WHERE card_shown.at < $5
                    RETURNING 1 AS one)
       SELECT (SELECT n FROM used) AS used, (SELECT ok FROM allowed) AS allowed,
              (SELECT b FROM blocked) AS blocked`,
      [
        input.viewerAccountId,
        input.subjectAccountId,
        input.photoIds,
        input.at,
        input.since,
        input.limit,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("card_shown insert returned no row");
    return { used: row.used, recorded: row.allowed, blocked: row.blocked };
  });
}

/** Erasure (#51): the trail of cards shown to the person. Rows about their own photos go with the photos. */
export async function deleteCardShownOfAccount(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query("DELETE FROM card_shown WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

/** The deleted row, or null when it was not the caller's. */
export async function deletePhoto(
  db: Queryable,
  accountId: string,
  photoId: string,
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `DELETE FROM photo WHERE id = $1 AND account_id = $2 AND purpose = 'profile' RETURNING ${COLUMNS}`,
    [photoId, accountId],
  );
  return rows[0] ? photoFrom(rows[0]) : null;
}

/** Rows of any account under this content key: the objects go only when this reaches zero. */
export async function countRowsForKey(db: Queryable, key: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM photo WHERE key = $1", [
    key,
  ]);
  return Number(rows[0]?.n ?? 0);
}

/** Renumbers the account's photos 0..n-1 in the given order; ids not the caller's change nothing. */
export async function setPositions(
  db: Queryable,
  accountId: string,
  order: string[],
): Promise<void> {
  await db.query(
    `UPDATE photo SET position = o.position
     FROM (SELECT id::uuid, (ordinality - 1)::smallint AS position
           FROM unnest($2::text[]) WITH ORDINALITY AS u(id, ordinality)) AS o
     WHERE photo.id = o.id AND photo.account_id = $1 AND photo.purpose = 'profile'`,
    [accountId, order],
  );
}

/** Closes the gap a deletion left, so positions stay 0..n-1. */
export async function compactPositions(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `UPDATE photo SET position = o.position
     FROM (SELECT id, (row_number() OVER (ORDER BY position, created_at) - 1)::smallint AS position
           FROM photo WHERE account_id = $1 AND purpose = 'profile') AS o
     WHERE photo.id = o.id AND photo.account_id = $1 AND photo.purpose = 'profile'`,
    [accountId],
  );
}

/** False when the account is no longer live: a fetch that outlived the erasure writes nothing (#51). */
export type PhotoAccessResult = {
  /** False when the account is a tombstone (#51): nothing was written. */
  live: boolean;
  /** The account's fetches of this variant since the window started, before this one. */
  used: number;
  /** True when the row was written: the account is live and under its budget. */
  recorded: boolean;
  /** A block stands between the caller and the photo's owner (#84, ADR-030 §2): nothing was written, whatever the budget. */
  blocked: boolean;
};

/**
 * The fetch-log row and the exposure budget in one statement (#52, TD-6,
 * rule 6): the day's fetches of the variant are counted for the caller's
 * account and the row is written only under the limit. The statement runs
 * under a transaction-scoped advisory lock on (account, variant): under READ
 * COMMITTED each statement takes its own snapshot, so without the lock a
 * parallel burst could pass the count together (budget.test.ts proves the
 * limit holds against a pool). A tombstone writes nothing (#51). Nor does a
 * block between the caller and the photo's owner (#84, ADR-030 §2), asked in
 * this statement as `recordCardServed` asks it, so a block that lands after
 * `findVisiblePhoto` looked still refuses the URL.
 */
export async function insertPhotoAccess(
  db: Queryable,
  input: {
    accountId: string;
    photoId: string;
    variant: PhotoVariant;
    at: Date;
    /** Start of the budget's day; rows from before it do not count. */
    since: Date;
    limit: number;
  },
): Promise<PhotoAccessResult> {
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `photo_access:${input.accountId}:${input.variant}`,
    ]);
    const { rows } = await tx.query<{
      live: boolean;
      used: number;
      blocked: boolean;
      inserted: number;
    }>(
      `WITH live AS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted'),
          used AS (SELECT count(*)::int AS n FROM photo_access
                   WHERE account_id = $1 AND variant = $3 AND at >= $5 AND purpose = 'profile'),
          blocked AS (SELECT EXISTS (SELECT 1 FROM photo
                                     WHERE id = $2 AND account_id <> $1
                                       AND blocked_between($1, account_id)) AS b),
          ins AS (INSERT INTO photo_access (account_id, photo_id, variant, at)
                  SELECT $1, $2, $3, $4 FROM live, used, blocked WHERE used.n < $6 AND NOT blocked.b
                  RETURNING 1 AS one)
     SELECT EXISTS (SELECT 1 FROM live) AS live,
            (SELECT n FROM used) AS used,
            (SELECT b FROM blocked) AS blocked,
            (SELECT count(*) FROM ins)::int AS inserted`,
      [input.accountId, input.photoId, input.variant, input.at, input.since, input.limit],
    );
    const row = rows[0];
    if (!row) throw new Error("photo_access insert returned no row");
    return {
      live: row.live,
      used: row.used,
      recorded: row.inserted === 1,
      blocked: row.blocked,
    };
  });
}

/**
 * A fetch-log row outside the budget (#237): the export reads the person's
 * own full-size photos on the server, and the log it returns says so, as it
 * did when the export issued URLs. The row counts against later fetches like
 * any other; the export itself is bounded by its own day's cap. Nothing for
 * an erased account (#51).
 */
export async function logPhotoAccess(
  db: Queryable,
  input: {
    accountId: string;
    photoId: string;
    variant: PhotoVariant;
    at: Date;
    /** A message photo's fetch (#350) is logged and never counted against the day's budget. */
    purpose?: PhotoPurpose;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO photo_access (account_id, photo_id, variant, at, purpose)
     SELECT $1, $2, $3, $4, $5 FROM account WHERE id = $1 AND state <> 'deleted'`,
    [input.accountId, input.photoId, input.variant, input.at, input.purpose ?? "profile"],
  );
}

/**
 * The fetch log of an answer's message photos (#350), one statement: a row
 * per photo and variant the reader was not handed since `since` (the URL's
 * window, so a repeated read writes nothing), with the purpose `message`.
 * `live` false for a reader erased meanwhile (#51), who gets no row.
 */
export async function logMessagePhotoAccess(
  db: Queryable,
  input: { accountId: string; photoIds: readonly string[]; at: Date; since: Date },
): Promise<{ live: boolean; written: number }> {
  const { rows } = await db.query<{ live: boolean; written: number }>(
    `WITH live AS (SELECT 1 FROM account WHERE id = $1 AND state <> 'deleted'),
          ins AS (
            INSERT INTO photo_access (account_id, photo_id, variant, at, purpose)
            SELECT $1, u.photo_id, v.variant, $3, 'message'
            FROM unnest($2::uuid[]) AS u(photo_id)
            CROSS JOIN (VALUES ('thumb'::photo_variant), ('full'::photo_variant)) AS v(variant)
            CROSS JOIN live
            WHERE NOT EXISTS (
              SELECT 1 FROM photo_access a
              WHERE a.account_id = $1 AND a.photo_id = u.photo_id AND a.variant = v.variant
                AND a.purpose = 'message' AND a.at >= $4)
            RETURNING 1)
     SELECT EXISTS (SELECT 1 FROM live) AS live, (SELECT count(*)::int FROM ins) AS written`,
    [input.accountId, input.photoIds, input.at, input.since],
  );
  return { live: rows[0]?.live === true, written: rows[0]?.written ?? 0 };
}

/**
 * The account's photos sent in conversations since the day began (#350),
 * read under the sender's lock in the transaction that then writes the next,
 * so the day's cap holds against a burst (rule 6: the caller's account).
 */
export async function countMessagePhotosSince(
  db: Queryable,
  accountId: string,
  since: Date,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM photo
     WHERE account_id = $1 AND purpose = 'message' AND created_at >= $2`,
    [accountId, since],
  );
  return rows[0]?.n ?? 0;
}

/**
 * A photo sent in a conversation (#350): no position, the check's decision
 * as its state, and only for a live account, as a profile photo's insert
 * asks. Null when the account is a tombstone (#51).
 */
export async function insertMessagePhoto(
  db: Queryable,
  input: {
    accountId: string;
    key: string;
    blurhash: string;
    width: number;
    height: number;
    state: "approved" | "queued";
    at: Date;
  },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, position, created_at)
     SELECT $1, $2, $3, $4, $5, $6, 'message', NULL, $7
     FROM account WHERE id = $1 AND state <> 'deleted'
     RETURNING id`,
    [input.accountId, input.key, input.blurhash, input.width, input.height, input.state, input.at],
  );
  return rows[0]?.id ?? null;
}

// Moderation (#49). The automatic check and the staff routes read photos
// across accounts on purpose: what a moderator sees is every queued photo,
// behind the admin guard (lib/admin-middleware.ts) and an audit row per view.
// Rule 6 scopes what a person reads about themselves; staff access is the
// exception the security checklist names, and it is logged.

/** The automatic check's result; never overwrites a person's decision. */
export async function upsertAutomaticReview(
  db: Queryable,
  input: {
    photoId: string;
    labels: ModerationLabel[];
    faces: number;
    flagged: string[];
    modelVersion: string | null;
    checkedAt: Date;
    decision: "approved" | "queued" | "rejected";
    /** Set when the check itself rejects (#206); decided_by stays null, as for every automatic row. */
    reason: PhotoRejectionReason | null;
    /** What the check saw, for everyone to hear with the photo (#296); null where no check ran. */
    description: PhotoDescription | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO photo_review (photo_id, labels, faces, flagged, model_version, checked_at, decision, reason, description)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (photo_id) DO UPDATE
       SET labels = EXCLUDED.labels, faces = EXCLUDED.faces, flagged = EXCLUDED.flagged,
           model_version = EXCLUDED.model_version, checked_at = EXCLUDED.checked_at,
           decision = EXCLUDED.decision, reason = EXCLUDED.reason,
           description = EXCLUDED.description
       WHERE photo_review.decided_by IS NULL`,
    [
      input.photoId,
      JSON.stringify(input.labels),
      input.faces,
      input.flagged,
      input.modelVersion,
      input.checkedAt,
      input.decision,
      input.reason,
      input.description === null ? null : JSON.stringify(input.description),
    ],
  );
}

/** pending → approved, queued, or rejected with the reason the owner is told; true when this call moved it (a person's decision stands). */
export async function movePendingPhoto(
  db: Queryable,
  photoId: string,
  decision: "approved" | "queued" | "rejected",
  reason: PhotoRejectionReason | null = null,
  appealable = false,
): Promise<boolean> {
  const result = await db.query(
    "UPDATE photo SET state = $2, rejection_reason = $3, appealable = $4 WHERE id = $1 AND state = 'pending'",
    [photoId, decision, reason, appealable],
  );
  return result.rowCount === 1;
}

/**
 * Photos still pending with no person's decision, oldest first: what the
 * nightly sweep retries. That is a photo the check never reached, and one the
 * check recorded but whose state did not move (the two writes are one
 * transaction now; rows from before that are picked up here too).
 */
export async function findPendingUnchecked(
  db: Queryable,
  olderThan: Date,
  limit: number,
): Promise<Array<{ id: string; accountId: string; key: string }>> {
  const { rows } = await db.query<Row>(
    `SELECT p.id, p.account_id, p.key FROM photo p
     LEFT JOIN photo_review r ON r.photo_id = p.id
     WHERE p.purpose = 'profile' AND p.state = 'pending' AND (r.photo_id IS NULL OR r.decided_by IS NULL)
       AND p.created_at < $1
     ORDER BY p.created_at LIMIT $2`,
    [olderThan, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    accountId: r.account_id as string,
    key: r.key as string,
  }));
}

const reviewItemFrom = (r: Row): PhotoReviewItem => ({
  photoId: r.id as PhotoId,
  accountId: r.account_id as string,
  state: r.state as PhotoState,
  blurhash: r.blurhash as string,
  width: r.width as number,
  height: r.height as number,
  uploadedAt: (r.created_at as Date).toISOString(),
  checkedAt: ((r.checked_at as Date | null) ?? null)?.toISOString() ?? null,
  labels: (r.labels as ModerationLabel[] | null) ?? [],
  faces: (r.faces as number | null) ?? 0,
  flagged: (r.flagged as string[] | null) ?? [],
  appealed: r.appealed_at != null,
  // The route decides from the labels and the lines in force (admin-routes.ts).
  sensitive: false,
});

/**
 * The owner asks a person to look at the check's rejection (#253): rejected
 * and appealable becomes queued, once; the review row keeps when, and goes
 * back to queued for the panel. Scoped by the account in the statement (rule
 * 6). Null when the photo is not this account's or not appealable.
 */
export async function appealPhoto(
  db: Queryable,
  input: { accountId: string; photoId: string; at: Date },
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `UPDATE photo SET state = 'queued', rejection_reason = NULL, appealable = false
     WHERE id = $1 AND account_id = $2 AND purpose = 'profile' AND state = 'rejected' AND appealable
     RETURNING ${COLUMNS}`,
    [input.photoId, input.accountId],
  );
  const row = rows[0];
  if (!row) return null;
  await db.query(
    `UPDATE photo_review SET appealed_at = $2, decision = 'queued', reason = NULL
     WHERE photo_id = $1 AND decided_by IS NULL`,
    [input.photoId, input.at],
  );
  return photoFrom(row);
}

/**
 * The owner's line for a photo (#296), or null to clear it. Scoped by the
 * account in the statement (rule 6); null when the photo is not this
 * account's.
 */
export async function setCaption(
  db: Queryable,
  input: { accountId: string; photoId: string; caption: PhotoCaption | null },
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `UPDATE photo SET caption = $3 WHERE id = $1 AND account_id = $2 AND purpose = 'profile'
     RETURNING ${COLUMNS}`,
    [input.photoId, input.accountId, input.caption],
  );
  const row = rows[0];
  return row ? photoFrom(row) : null;
}

const QUEUE_COLUMNS = `p.id, p.account_id, p.state, p.blurhash, p.width, p.height, p.created_at,
  r.checked_at, r.labels, r.faces, r.flagged, r.appealed_at`;

/** The human queue: queued photos, oldest first. */
export async function listQueue(db: Queryable, limit: number): Promise<PhotoReviewItem[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${QUEUE_COLUMNS} FROM photo p LEFT JOIN photo_review r ON r.photo_id = p.id
     WHERE p.purpose = 'profile' AND p.state = 'queued'
     -- Longest waiting first: an appealed photo waits from its appeal, as the front page counts it (#303).
     ORDER BY coalesce(r.appealed_at, p.created_at), p.id LIMIT $1`,
    [limit],
  );
  return rows.map(reviewItemFrom);
}

/**
 * What waits in the photo queue for the front page (#303): how many, and
 * since when the oldest, from its owner's appeal if it came back that way.
 */
export async function queueSummary(
  db: Queryable,
): Promise<{ waiting: number; oldestSince: Date | null }> {
  const { rows } = await db.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(coalesce(r.appealed_at, p.created_at)) AS oldest
     FROM photo p LEFT JOIN photo_review r ON r.photo_id = p.id
     WHERE p.purpose = 'profile' AND p.state = 'queued'`,
  );
  return { waiting: rows[0]?.n ?? 0, oldestSince: rows[0]?.oldest ?? null };
}

export async function countQueue(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM photo WHERE purpose = 'profile' AND state = 'queued'",
  );
  return Number(rows[0]?.n ?? 0);
}

/** One photo as staff sees it, any account; null when there is no such photo. */
export async function findPhotoForStaff(
  db: Queryable,
  photoId: string,
): Promise<(PhotoRow & { accountId: string }) | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}, account_id FROM photo WHERE id = $1 AND purpose = 'profile'`,
    [photoId],
  );
  const r = rows[0];
  return r ? { ...photoFrom(r), accountId: r.account_id as string } : null;
}

/**
 * A person's decision: the photo's state and reason, and the review row with
 * who decided and when. Only a queued photo takes one (null otherwise, and
 * nothing is written), so an earlier decision is never overwritten. Rejected
 * is only ever written here (rules/api.md: never auto-delete, never auto-reject).
 */
export async function decidePhoto(
  db: Queryable,
  input: {
    photoId: string;
    decision: "approved" | "rejected";
    reason: PhotoRejectionReason | null;
    decidedBy: string;
    at: Date;
  },
): Promise<PhotoRow | null> {
  const { rows } = await db.query<Row>(
    `UPDATE photo SET state = $2, rejection_reason = $3
     WHERE id = $1 AND purpose = 'profile' AND state = 'queued' RETURNING ${COLUMNS}`,
    [input.photoId, input.decision, input.reason],
  );
  const row = rows[0];
  if (!row) return null;
  await db.query(
    `INSERT INTO photo_review (photo_id, labels, faces, flagged, decision, decided_by, decided_at, reason)
     VALUES ($1, '[]'::jsonb, 0, '{}', $2, $3, $4, $5)
     ON CONFLICT (photo_id) DO UPDATE
       SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by,
           decided_at = EXCLUDED.decided_at, reason = EXCLUDED.reason`,
    [input.photoId, input.decision, input.decidedBy, input.at, input.reason],
  );
  return photoFrom(row);
}

// Erasure and export (#51, TD-7): the account's photos, their review rows
// (cascade) and its own fetch log go; the objects go when no other row shares
// the content, decided by the caller after the transaction.

/** Deletes every photo row of the account; returns their content keys. */
export async function deletePhotosOfAccount(
  db: Queryable,
  accountId: string,
  keep: readonly string[] = [],
): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    "DELETE FROM photo WHERE account_id = $1 AND NOT (id = ANY($2::uuid[])) RETURNING key",
    [accountId, keep],
  );
  return rows.map((r) => r.key);
}

/**
 * The person's photos sent in conversations, the newest first, for the
 * export (#350): the id, the content key and the check's description. A
 * person sends ten a day at most, and these are rows, not files.
 */
export async function listMessagePhotosOfAccount(
  db: Queryable,
  accountId: string,
): Promise<Array<{ id: string; key: string; description: PhotoDescription | null }>> {
  const { rows } = await db.query<Row>(
    `SELECT id, key,
       (SELECT r.description FROM photo_review r WHERE r.photo_id = photo.id) AS description
     FROM photo WHERE account_id = $1 AND purpose = 'message'
     ORDER BY created_at DESC, id`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    key: r.key as string,
    description: (r.description as PhotoDescription | null) ?? null,
  }));
}

export async function deletePhotoAccessOfAccount(
  db: Queryable,
  accountId: string,
): Promise<number> {
  const result = await db.query("DELETE FROM photo_access WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

/** Of the given keys, those no photo row references any more. */
export async function orphanedKeys(db: Queryable, keys: string[]): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT k.key FROM unnest($1::text[]) AS k(key)
     WHERE NOT EXISTS (SELECT 1 FROM photo p WHERE p.key = k.key)`,
    [[...new Set(keys)]],
  );
  return rows.map((r) => r.key);
}

export async function listPhotoAccessOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ photoId: string; variant: PhotoVariant; at: Date }>> {
  const { rows } = await db.query<Row>(
    "SELECT photo_id, variant, at FROM photo_access WHERE account_id = $1 ORDER BY at DESC LIMIT $2",
    [accountId, limit],
  );
  return rows.map((r) => ({
    photoId: r.photo_id as string,
    variant: r.variant as PhotoVariant,
    at: r.at as Date,
  }));
}

/** The export (#51): the cards served to the person, each with the last day it came round, newest first. */
export async function listCardShownOfAccount(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<Array<{ photoId: string; at: Date }>> {
  const { rows } = await db.query<Row>(
    "SELECT photo_id, at FROM card_shown WHERE account_id = $1 ORDER BY at DESC, photo_id LIMIT $2",
    [accountId, limit],
  );
  return rows.map((r) => ({ photoId: r.photo_id as string, at: r.at as Date }));
}

/** The moderation outcome per photo of the account, for the export; never the labels. */
export async function listReviewsForAccount(
  db: Queryable,
  accountId: string,
): Promise<
  Map<
    string,
    {
      decision: "approved" | "queued" | "rejected";
      reason: PhotoRejectionReason | null;
      decidedBy: string | null;
      decidedAt: Date | null;
    }
  >
> {
  const { rows } = await db.query<Row>(
    `SELECT r.photo_id, r.decision, r.reason, r.decided_by, r.decided_at
     FROM photo_review r JOIN photo p ON p.id = r.photo_id WHERE p.account_id = $1`,
    [accountId],
  );
  return new Map(
    rows.map((r) => [
      r.photo_id as string,
      {
        decision: r.decision as "approved" | "queued" | "rejected",
        reason: (r.reason as PhotoRejectionReason | null) ?? null,
        decidedBy: (r.decided_by as string | null) ?? null,
        decidedAt: (r.decided_at as Date | null) ?? null,
      },
    ]),
  );
}
