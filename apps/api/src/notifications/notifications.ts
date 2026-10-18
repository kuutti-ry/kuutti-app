import type { Queryable } from "@kuutti/db";
import {
  type ExportedNotifications,
  NOTICES_MAX,
  type Notices,
  type NotificationChoice,
  NotificationKind,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import * as repo from "./repo.ts";

// The notification choices and the notices in the app (#176, ADR-032). A
// choice is the person's switch per kind, on until switched off; nothing is
// sent from here: the senders come later and read the choice (#102 the
// message). A notice is what must reach the person even without a push, the
// first of them a moderator's warning (ADR-024 §7).

/** Every kind in its order, each on unless the person switched it off. */
export async function choicesOf(db: Queryable, accountId: string): Promise<NotificationChoice[]> {
  const stored = new Map(
    (await repo.listChoices(db, accountId)).map((row) => [row.kind, row.enabled]),
  );
  return NotificationKind.options.map((kind) => ({ kind, enabled: stored.get(kind) ?? true }));
}

/** Switches one kind for the caller; an account erased meanwhile writes nothing (404). */
export async function setChoice(
  deps: { db: Queryable; now: () => Date },
  input: { accountId: string; kind: NotificationKind; enabled: boolean },
): Promise<NotificationChoice[]> {
  if (!(await repo.upsertChoice(deps.db, { ...input, at: deps.now() }))) {
    throw new AppError(404, "not_found", "No live account");
  }
  return choicesOf(deps.db, input.accountId);
}

/** The caller's newest notices. */
export async function noticesOf(db: Queryable, accountId: string): Promise<Notices> {
  const rows = await repo.listNotices(db, accountId, NOTICES_MAX);
  return {
    notices: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      at: row.at.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      reason: row.reason,
    })),
  };
}

/** Marks one of the caller's notices read; one not theirs is 404. */
export async function readNotice(
  deps: { db: Queryable; now: () => Date },
  input: { accountId: string; noticeId: string },
): Promise<void> {
  if (!(await repo.markRead(deps.db, { ...input, at: deps.now() }))) {
    throw new AppError(404, "not_found", "No such notice");
  }
}

/** A moderator's warning tells the person in the app (ADR-024 §7), in the warning's transaction. */
export async function recordWarningNotice(
  db: Queryable,
  input: { accountId: string; sanctionId: string; at: Date },
): Promise<void> {
  await repo.insertWarningNotice(db, input);
}

/** The person's part of the export (ADR-007 §3): the choices as they stand and every notice. */
export async function exportNotifications(
  db: Queryable,
  accountId: string,
): Promise<ExportedNotifications> {
  return {
    choices: await choicesOf(db, accountId),
    notices: (await repo.exportedNotices(db, accountId)).map((row) => ({
      kind: row.kind,
      at: row.at.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    })),
  };
}

/** The person's part of an erasure (ADR-007 §4), in its transaction. */
export async function eraseNotificationsOf(
  db: Queryable,
  accountId: string,
): Promise<{ choices: number; notices: number }> {
  return repo.deleteOf(db, accountId);
}
