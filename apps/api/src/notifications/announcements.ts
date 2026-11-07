import { type Queryable, transaction } from "@kuutti/db";
import {
  type AdminAnnouncement,
  type AdminAnnouncementList,
  ANNOUNCEMENTS_LISTED,
  type AnnouncementDraft,
  type AnnouncementText,
} from "@kuutti/schema";
import { AppError } from "../lib/errors.ts";
import { tFor } from "../lib/i18n.ts";
import type { Logger } from "../lib/logger.ts";
import { type Mailer, MailFailed } from "../lib/mail.ts";
import { contactDetailsIn } from "../profile/index.ts";
import { recordAudit } from "../safety/index.ts";
import * as repo from "./repo.ts";

// Announcements (#573, ADR-068): one text to everybody, for what people must
// know, never a call to come back. An admin writes it, another admin approves
// it, and the approval writes a notice for every account in its transaction;
// the push and the email go after it commits (push.ts). The audit rows carry
// no text a person typed, and no log line carries the text or an address.

/**
 * The words a reader of `locale` gets (ADR-068 §3, §5): Finnish for Finnish
 * and Stadi, Swedish where it was written and English where it was not, and
 * English for everything else. Also which language that is, for the email's
 * own lines.
 */
export function announcementTextFor(
  texts: repo.AnnouncementTexts,
  locale: string | null,
): { locale: "en" | "fi" | "sv"; text: AnnouncementText } {
  if (locale?.startsWith("fi")) return { locale: "fi", text: texts.fi };
  if (locale === "sv" && texts.sv) return { locale: "sv", text: texts.sv };
  return { locale: "en", text: texts.en };
}

/** The panel's view of one: never who wrote or approved it, only whether the caller wrote it. */
function adminViewOf(row: repo.AnnouncementRow, staffIdentityId: string): AdminAnnouncement {
  return {
    id: row.id,
    en: row.texts.en,
    fi: row.texts.fi,
    sv: row.texts.sv,
    writtenAt: row.writtenAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    yours: row.writtenBy === staffIdentityId,
  };
}

/** The newest announcements, and how many one approved now would reach. */
export async function listForAdmin(
  deps: { db: Queryable; now: () => Date },
  staffIdentityId: string,
): Promise<AdminAnnouncementList> {
  const rows = await repo.listAnnouncements(deps.db, ANNOUNCEMENTS_LISTED);
  return {
    items: rows.map((row) => adminViewOf(row, staffIdentityId)),
    reach: await repo.announcementReach(deps.db, deps.now()),
  };
}

/**
 * The plain-text rule (ADR-009) on every title and body: an announcement
 * carries no address, link, phone number or handle (ADR-068 §1). The refusal
 * names the language and what was found, never the text.
 */
function refuseContactDetails(draft: AnnouncementDraft): void {
  for (const [language, text] of Object.entries(draft)) {
    if (!text) continue;
    for (const words of [text.title, text.body]) {
      const found = contactDetailsIn(words);
      if (found) {
        throw new AppError(400, "text_contact_details", "No contact details in an announcement", {
          language,
          found,
        });
      }
    }
  }
}

/** A draft, by the calling admin; written to the audit log with no words. */
export async function writeAnnouncement(
  deps: { db: Queryable; now: () => Date },
  input: { draft: AnnouncementDraft; staffIdentityId: string },
): Promise<AdminAnnouncement> {
  refuseContactDetails(input.draft);
  const row = await transaction(deps.db, async (tx) => {
    const written = await repo.insertAnnouncement(tx, {
      draft: input.draft,
      writtenBy: input.staffIdentityId,
      at: deps.now(),
    });
    await recordAudit(tx, {
      actorIdentityId: input.staffIdentityId,
      action: "announcement.write",
      subjectType: "announcement",
      subjectId: written.id,
      detail: { swedish: input.draft.sv !== undefined },
    });
    return written;
  });
  return adminViewOf(row, input.staffIdentityId);
}

const notFound = () => new AppError(404, "not_found", "No such announcement");
const alreadySent = () =>
  new AppError(409, "announcement_sent", "The announcement went to everybody already");

/** A draft goes, by any admin; a sent announcement never does (ADR-068 §2). */
export async function deleteAnnouncement(
  deps: { db: Queryable },
  input: { id: string; staffIdentityId: string },
): Promise<void> {
  await transaction(deps.db, async (tx) => {
    const row = await repo.lockAnnouncement(tx, input.id);
    if (!row) throw notFound();
    if (row.approvedAt) throw alreadySent();
    await recordAudit(tx, {
      actorIdentityId: input.staffIdentityId,
      action: "announcement.delete",
      subjectType: "announcement",
      subjectId: row.id,
    });
    await repo.deleteAnnouncement(tx, row.id);
  });
}

/**
 * The second admin's approval (ADR-068 §2, §3): never the one who wrote it,
 * once. A notice for every account is written in the same transaction; what
 * the caller does after the commit is the push and the email.
 */
export async function approveAnnouncement(
  deps: { db: Queryable; now: () => Date },
  input: { id: string; staffIdentityId: string },
): Promise<{ announcement: AdminAnnouncement; notices: number }> {
  return transaction(deps.db, async (tx) => {
    const found = await repo.lockAnnouncement(tx, input.id);
    if (!found) throw notFound();
    if (found.approvedAt) throw alreadySent();
    if (found.writtenBy === input.staffIdentityId) {
      throw new AppError(
        409,
        "own_announcement",
        "An announcement is approved by an admin other than the one who wrote it",
      );
    }
    const { row, notices } = await repo.approveAnnouncement(tx, {
      id: found.id,
      approvedBy: input.staffIdentityId,
      at: deps.now(),
    });
    await recordAudit(tx, {
      actorIdentityId: input.staffIdentityId,
      action: "announcement.approve",
      subjectType: "announcement",
      subjectId: row.id,
      detail: { notices },
    });
    return { announcement: adminViewOf(row, input.staffIdentityId), notices };
  });
}

/** The least time between two emails of one announcement: ten a second at most (ADR-068 §5). */
export const MAIL_SPACING_MS = 100;

/**
 * The email of an announcement (ADR-068 §5): to everybody its notice reached
 * whose address is confirmed and whose switch is on, each read fresh just
 * before its send, in the language they read the terms in. One at a time,
 * spaced; a failed send is logged by its reason and the rest go on, and
 * nothing is retried. The number sent.
 */
// shortcut: the sending lives in this process's memory, so a restart while it
// runs loses the rest (ADR-068, Left out); a column for how far it got would lift it.
export async function mailAnnouncement(
  deps: {
    db: Queryable;
    logger: Logger;
    mailer: Mailer;
    pause: (ms: number) => Promise<void>;
  },
  announcementId: string,
): Promise<number> {
  const texts = await repo.announcementTexts(deps.db, announcementId);
  if (!texts) return 0;
  let sent = 0;
  for (const accountId of await repo.announcementAccounts(deps.db, announcementId)) {
    const to = await repo.announcementMailOf(deps.db, accountId);
    if (!to) continue;
    if (sent > 0) await deps.pause(MAIL_SPACING_MS);
    const { locale, text } = announcementTextFor(texts, to.locale);
    const t = tFor(locale);
    try {
      await deps.mailer.send({
        to: to.address,
        subject: t("mail.announcement.subject", { title: text.title }),
        text: [text.title, text.body, t("mail.announcement.why"), t("mail.signature")].join("\n\n"),
      });
      sent += 1;
    } catch (error) {
      const reason =
        error instanceof MailFailed
          ? { reason: error.reason, status: error.status }
          : { reason: error instanceof Error ? error.name : "unknown" };
      deps.logger.warn({ accountId, ...reason }, "announcement mail not sent");
    }
  }
  deps.logger.info({ announcementId, sent }, "announcement mailed");
  return sent;
}
