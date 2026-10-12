import type { Queryable } from "@kuutti/db";
import type { PhotoCheckKind } from "@kuutti/schema";
import { matchingConfigNumbers } from "../lib/matching-config.ts";

/**
 * Photos the automatic check did not show to others for a hard label, and the
 * closer look they lead to (#253, ADR-006 §2, the maintainer's decisions of
 * 12/10/2026). A note says which kind and when; nothing of the picture. Enough
 * of them within the window make the check stricter for that account for a
 * while: computed from the notes, never stored, and over by itself. Nobody
 * sees the notes but the person, in their export; the check never bans
 * anybody, a ban stays a person's decision (TD-7).
 */

/** Twelve months, like the report snapshots of #84 (rules/db.md); the nightly prune keeps it. */
export const NOTE_RETENTION_DAYS = 365;

export const CLOSER_LOOK_KEYS = {
  attempts: "photo_closer_look_attempts",
  windowDays: "photo_closer_look_window_days",
  days: "photo_closer_look_days",
  reject: "photo_closer_look_reject",
} as const;

export type CloserLook = {
  /** When the closer look ends; null when none is on. */
  until: Date | null;
  /** The reject line of every hard group while it is on. */
  reject: number;
};

/** A day here is 24 hours, in SQL as in JS, whatever the session's time zone does with summer time. */
const DAY_MS = 86_400_000;

/** One note, written in the transaction that rejects the photo. */
export async function recordPhotoCheckNote(
  db: Queryable,
  input: { accountId: string; photoId: string; kind: PhotoCheckKind; at: Date },
): Promise<void> {
  await db.query(
    "INSERT INTO photo_check_note (account_id, photo_id, kind, at) VALUES ($1, $2, $3, $4)",
    [input.accountId, input.photoId, input.kind, input.at],
  );
}

/**
 * A person approved the photo on appeal: the check was wrong about it, so its
 * note goes and counts toward no closer look.
 */
export async function withdrawPhotoCheckNote(
  db: Queryable,
  input: { accountId: string; photoId: string },
): Promise<number> {
  const result = await db.query(
    "DELETE FROM photo_check_note WHERE photo_id = $1 AND account_id = $2",
    [input.photoId, input.accountId],
  );
  return result.rowCount ?? 0;
}

/**
 * The closer look in force for an account at `now`: `attempts` notes within
 * `window_days` start it at the last of them, and it lasts `days` from there;
 * a later note in such a run moves the end. Scoped by the account (rule 6).
 */
export async function closerLookOf(
  db: Queryable,
  accountId: string,
  now: Date,
): Promise<CloserLook> {
  const n = await matchingConfigNumbers(db, Object.values(CLOSER_LOOK_KEYS));
  const days = n[CLOSER_LOOK_KEYS.days];
  const { rows } = await db.query<{ since: Date | null }>(
    `SELECT max(b.at) AS since FROM photo_check_note b
     WHERE b.account_id = $1 AND b.at <= $2
       AND b.at > $2::timestamptz - make_interval(hours => 24 * $3::int)
       AND (SELECT count(*) FROM photo_check_note w
            WHERE w.account_id = $1
              AND w.at BETWEEN b.at - make_interval(hours => 24 * $4::int) AND b.at) >= $5`,
    [accountId, now, days, n[CLOSER_LOOK_KEYS.windowDays], n[CLOSER_LOOK_KEYS.attempts]],
  );
  const since = rows[0]?.since ?? null;
  return {
    until: since ? new Date(since.getTime() + days * DAY_MS) : null,
    reject: n[CLOSER_LOOK_KEYS.reject],
  };
}

/** The person's own notes, oldest first, for their export. */
export async function listPhotoCheckNotes(
  db: Queryable,
  accountId: string,
): Promise<{ kind: PhotoCheckKind; at: Date }[]> {
  const { rows } = await db.query<{ kind: PhotoCheckKind; at: Date }>(
    "SELECT kind, at FROM photo_check_note WHERE account_id = $1 ORDER BY at",
    [accountId],
  );
  return rows;
}

/** The erasure path's step (rules/db.md): the notes go with the account. */
export async function deletePhotoCheckNotesOfAccount(
  db: Queryable,
  accountId: string,
): Promise<number> {
  const result = await db.query("DELETE FROM photo_check_note WHERE account_id = $1", [accountId]);
  return result.rowCount ?? 0;
}

/** The nightly prune: a note older than twelve months goes. */
export async function prunePhotoCheckNotes(db: Queryable, now: Date): Promise<number> {
  const result = await db.query(
    "DELETE FROM photo_check_note WHERE at < $1::timestamptz - make_interval(hours => 24 * $2::int)",
    [now, NOTE_RETENTION_DAYS],
  );
  return result.rowCount ?? 0;
}
