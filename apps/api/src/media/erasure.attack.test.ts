import type { Queryable } from "@kuutti/db";
import { PHOTO_VARIANTS } from "@kuutti/schema";
import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { conversationBetween, photoMessage } from "../test/chat.ts";
import { captureLogger } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { reportIn } from "../test/reports.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { sweepOrphanedObjects } from "./erasure.ts";
import { memoryMediaStore, objectKey } from "./store.ts";

// What goes through today (#380): a hole, which its contract forbids.
const HOLE = "#380";

// sweep-orphaned-objects (#636, ADR-007, #380): the night deletes the objects
// under media/ a day old or more that no photo row names, and leaves an
// object of another shape alone. Each attack tries to make it delete what it
// must not. The store is the in-memory one, never the S3 stand-in: run from
// this database against a shared bucket, the sweep would take every
// persona's photo for an orphan.

/** 04:00 in Helsinki, one November night. */
const NIGHT = new Date("2026-11-07T02:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SECOND = 1000;
const WEEK_AGO = new Date(NIGHT.getTime() - 7 * DAY);

/** One object written at `writtenAt` that no row names, and whether the night deleted it. */
async function loneObject(db: Queryable, key: string, writtenAt: Date) {
  const store = memoryMediaStore(() => writtenAt);
  await store.put(key, new Uint8Array([1]), "image/webp");
  const { logger } = await captureLogger();
  await sweepOrphanedObjects({ db, store, logger }, NIGHT);
  return { deleted: !store.objects.has(key) };
}

attack(
  "sweep-orphaned-objects: an object no row names is deleted a second before it is a day old",
  {
    attempt: () =>
      rolledBack((db) =>
        loneObject(
          db,
          objectKey("k-attack-young", "card"),
          new Date(NIGHT.getTime() - DAY + SECOND),
        ),
      ),
    control: () =>
      rolledBack((db) =>
        loneObject(
          db,
          objectKey("k-attack-young", "card"),
          new Date(NIGHT.getTime() - DAY - SECOND),
        ),
      ),
    succeeds: (seen) => expect(seen.deleted).toBe(true),
  },
);

// The variant shape is media/<content key>/<variant>.webp, the three of
// PHOTO_VARIANTS; anything else under media/ is "not this job's to judge".
attack(
  "sweep-orphaned-objects: an object under media/ that is not one of a photo's variants is deleted",
  {
    // Goes through today: the content key is read from any file name under media/<key>/, not only thumb, card and full.
    open: HOLE,
    attempt: () => rolledBack((db) => loneObject(db, "media/k-attack-odd/original.webp", WEEK_AGO)),
    control: () => rolledBack((db) => loneObject(db, objectKey("k-attack-odd", "card"), WEEK_AGO)),
    succeeds: (seen) => expect(seen.deleted).toBe(true),
  },
);

/**
 * A photo an erased sender sent, which a report's copy holds (#351): its row
 * stays for the moderators. Unless `held`, the copy and the row have been let
 * go, as the night's prune does with the last copy.
 */
async function heldPhoto(held: boolean) {
  return rolledBack(async (db) => {
    const [reporter, sender] = await people(db, null, 2, { state: "active" });
    if (!reporter || !sender) throw new Error("people not written");
    const conversationId = await conversationBetween(db, reporter, sender, { openedAt: WEEK_AGO });
    const store = memoryMediaStore(() => WEEK_AGO);
    const { photoId, key } = await photoMessage(db, {
      conversationId,
      accountId: sender,
      side: "b",
      store,
    });
    const reportId = await reportIn(
      db,
      reporter,
      sender,
      WEEK_AGO.toISOString(),
      undefined,
      "conversation",
    );
    await db.query(
      `INSERT INTO report_message (report_id, seq, side, kind, photo_id, created_at)
       VALUES ($1, 1, 'reported', 'photo', $2, $3)`,
      [reportId, photoId, WEEK_AGO],
    );
    await db.query("UPDATE account SET state = 'deleted' WHERE id = $1", [sender]);
    if (!held) {
      await db.query("DELETE FROM report_message WHERE report_id = $1", [reportId]);
      await db.query("DELETE FROM photo WHERE id = $1", [photoId]);
    }
    const { logger } = await captureLogger();
    for (const variant of PHOTO_VARIANTS) {
      expect(store.objects.has(objectKey(key, variant))).toBe(true);
    }
    await sweepOrphanedObjects({ db, store, logger }, NIGHT);
    // Losing even one variant violates the hold; another variant surviving cannot hide it.
    return { deleted: PHOTO_VARIANTS.some((v) => !store.objects.has(objectKey(key, v))) };
  });
}

attack(
  "sweep-orphaned-objects: a variant of an erased sender's photo that a report's copy still holds is deleted",
  {
    attempt: () => heldPhoto(true),
    control: () => heldPhoto(false),
    succeeds: (seen) => expect(seen.deleted).toBe(true),
  },
);
