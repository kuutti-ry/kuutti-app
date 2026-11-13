import { expect } from "vitest";
import { withMatchingConfig } from "../test/account.ts";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { rejectUnreviewedPhotos } from "./moderation.ts";

// reject-unreviewed-photos (#376, ADR-006 §2, #380): a profile photo nobody in
// the human queue decided within photo_queue_reject_days, counted from its
// upload or its owner's appeal, is rejected as not_reviewed; 0 switches the
// limit off; a photo sent in a conversation never waits in that queue (rules/
// api.md Media: "what it is unsure of is delivered with no human queue").
// Each attack tries to make a night reject a photo it must leave.

/** 04:00 in Helsinki, one October night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const ago = (ms: number) => new Date(NIGHT.getTime() - ms);

type Queued = {
  uploaded: Date;
  appealed?: Date;
  purpose?: "profile" | "message";
  limitDays?: number;
};

/** One queued photo; whether the night rejected it. */
async function rejected({ uploaded, appealed, purpose = "profile", limitDays = 14 }: Queued) {
  return rolledBack(async (db) => {
    await withMatchingConfig(db, { photo_queue_reject_days: limitDays });
    const [owner] = await people(db, null, 1, { state: "active" });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO photo (account_id, key, blurhash, width, height, state, purpose, position, created_at)
       VALUES ($1, 'attack-queued', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067, 'queued', $2::photo_purpose,
               CASE WHEN $2 = 'profile' THEN 0 END, $3)
       RETURNING id`,
      [owner, purpose, uploaded],
    );
    const id = rows[0]?.id;
    if (appealed) {
      await db.query(
        `INSERT INTO photo_review (photo_id, labels, faces, flagged, checked_at, decision, appealed_at)
         VALUES ($1, '[]', 1, '{}', $2, 'queued', $3)`,
        [id, uploaded, appealed],
      );
    }
    await rejectUnreviewedPhotos({ db, now: () => NIGHT });
    const state = await db.query<{ state: string }>("SELECT state FROM photo WHERE id = $1", [id]);
    return { rejected: state.rows[0]?.state === "rejected" };
  });
}

attack("reject-unreviewed-photos: a photo queued a second short of the limit is rejected", {
  attempt: () => rejected({ uploaded: ago(14 * DAY - SECOND) }),
  control: () => rejected({ uploaded: ago(14 * DAY + SECOND) }),
  succeeds: (seen) => expect(seen.rejected).toBe(true),
});

attack(
  "reject-unreviewed-photos: a photo its owner appealed yesterday is rejected for its old upload",
  {
    attempt: () => rejected({ uploaded: ago(30 * DAY), appealed: ago(DAY) }),
    control: () => rejected({ uploaded: ago(30 * DAY), appealed: ago(15 * DAY) }),
    succeeds: (seen) => expect(seen.rejected).toBe(true),
  },
);

attack(
  "reject-unreviewed-photos: a photo sent in a conversation that the check was unsure of is rejected as not reviewed",
  {
    attempt: () => rejected({ uploaded: ago(30 * DAY), purpose: "message" }),
    control: () => rejected({ uploaded: ago(30 * DAY) }),
    succeeds: (seen) => expect(seen.rejected).toBe(true),
  },
);

attack("reject-unreviewed-photos: with the limit at zero, a photo queued a month is rejected", {
  attempt: () => rejected({ uploaded: ago(30 * DAY), limitDays: 0 }),
  control: () => rejected({ uploaded: ago(30 * DAY) }),
  succeeds: (seen) => expect(seen.rejected).toBe(true),
});
