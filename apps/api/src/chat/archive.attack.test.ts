import { expect } from "vitest";
import { withMatchingConfig } from "../test/account.ts";
import { attack } from "../test/attack.ts";
import { conversationBetween } from "../test/chat.ts";
import { captureLogger } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { archiveJob } from "./archive.ts";

// archive-silent-conversations (#348, TD-13, #380): a conversation nobody wrote
// in, or shared a contact in, for silent_match_archive_days is put away; "A
// closed one stays as it is. A break stops no clock (ADR-022 §4): the paused
// person's conversations go the same way." Each attack tries to make a night
// archive one too soon, keep a paused person's, archive a closed one or one
// with a fresh share, or archive one twice.

/** 04:00 in Helsinki, two October nights; seven days of silence. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-17T01:00:00.000Z");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const ago = (ms: number) => new Date(NIGHT.getTime() - ms);

type Quiet = {
  opened: Date;
  lastMessage?: Date;
  shared?: Date;
  closed?: Date;
  paused?: boolean;
  nights?: Date[];
};

/** One conversation of two people as described, the nights run; when it was archived, if it was. */
async function archivedAt({
  opened,
  lastMessage,
  shared,
  closed,
  paused,
  nights = [NIGHT],
}: Quiet) {
  return rolledBack(async (db) => {
    await withMatchingConfig(db, { silent_match_archive_days: 7 });
    const [a, b] = await people(db, null, 2, { state: "active" });
    if (!a || !b) throw new Error("people not written");
    const id = await conversationBetween(db, a, b, {
      openedAt: opened,
      messages: lastMessage ? [{ from: "a", body: "Hei!", at: lastMessage }] : [],
    });
    if (shared) {
      await db.query(
        "INSERT INTO contact_share (conversation_id, side, kind, shared_at) VALUES ($1, 'a', 'phone', $2)",
        [id, shared],
      );
    }
    if (closed) {
      await db.query(
        "UPDATE conversation SET closed_at = $2, closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
        [id, closed],
      );
    }
    if (paused) {
      await db.query("UPDATE account SET state = 'paused', paused_from = 'active' WHERE id = $1", [
        a,
      ]);
    }
    const { logger } = await captureLogger();
    for (const at of nights) await archiveJob({ db, logger, now: () => at }).run();
    const row = await db.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM conversation WHERE id = $1",
      [id],
    );
    return { archivedAt: row.rows[0]?.archived_at ?? null };
  });
}

attack("archive: a conversation silent a second short of seven days is archived", {
  attempt: () => archivedAt({ opened: ago(7 * DAY - SECOND) }),
  control: () => archivedAt({ opened: ago(7 * DAY + SECOND) }),
  succeeds: (seen) => expect(seen.archivedAt).not.toBeNull(),
});

attack("archive: a paused person's conversation, silent eight days, is left out", {
  attempt: () => archivedAt({ opened: ago(8 * DAY), paused: true }),
  // Six days of silence: left by right.
  control: () => archivedAt({ opened: ago(6 * DAY), paused: true }),
  succeeds: (seen) => expect(seen.archivedAt).toBeNull(),
});

attack(
  "archive: a conversation whose contact was shared yesterday is archived for its old messages",
  {
    attempt: () =>
      archivedAt({ opened: ago(30 * DAY), lastMessage: ago(20 * DAY), shared: ago(DAY) }),
    control: () =>
      archivedAt({ opened: ago(30 * DAY), lastMessage: ago(20 * DAY), shared: ago(10 * DAY) }),
    succeeds: (seen) => expect(seen.archivedAt).not.toBeNull(),
  },
);

attack("archive: a closed conversation is archived", {
  attempt: () => archivedAt({ opened: ago(30 * DAY), closed: ago(10 * DAY) }),
  control: () => archivedAt({ opened: ago(30 * DAY) }),
  succeeds: (seen) => expect(seen.archivedAt).not.toBeNull(),
});

attack("archive: the next night archives an archived conversation again", {
  attempt: () => archivedAt({ opened: ago(8 * DAY), nights: [NIGHT, NEXT_NIGHT] }),
  // Silent six and a half days at the first night: the second archives it by right.
  control: () => archivedAt({ opened: ago(6.5 * DAY), nights: [NIGHT, NEXT_NIGHT] }),
  succeeds: (seen) => expect(seen.archivedAt).toEqual(NEXT_NIGHT),
});
