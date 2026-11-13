import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { memoryMediaStore } from "../media/index.ts";
import { attack } from "../test/attack.ts";
import { conversationBetween, photoMessage } from "../test/chat.ts";
import { captureLogger } from "../test/harness.ts";
import { people } from "../test/people.ts";
import { reportIn } from "../test/reports.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { pruneReports } from "./reports.ts";

// prune-reports (#84, #351, ADR-030 §8, #380): "a report filed more than twelve
// months ago goes, open or decided, with its frozen copy; its block stays.
// Then every photo of an erased sender that no copy holds any more goes ...;
// a living sender's photo stays theirs." Each attack tries to make a night
// take a report too soon, its block with it, or a living person's photo.

/** 04:00 in Helsinki, one October night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const ago = (ms: number) => new Date(NIGHT.getTime() - ms);
const LONG_AGO = ago(400 * DAY);

async function two(db: Queryable): Promise<[string, string]> {
  const [a, b] = await people(db, null, 2, { state: "active" });
  if (!a || !b) throw new Error("people not written");
  return [a, b];
}

const prune = async (db: Queryable, store = memoryMediaStore()) =>
  pruneReports({ db, logger: (await captureLogger()).logger, store }, NIGHT);

async function reportFiled(at: Date) {
  return rolledBack(async (db) => {
    const [reporter, reported] = await two(db);
    const id = await reportIn(db, reporter, reported, at.toISOString());
    await prune(db);
    return {
      pruned: (await db.query("SELECT 1 FROM report WHERE id = $1", [id])).rows.length === 0,
    };
  });
}

attack("prune-reports: a report filed a second short of a year ago is pruned", {
  attempt: () => reportFiled(ago(365 * DAY - SECOND)),
  control: () => reportFiled(ago(365 * DAY + SECOND)),
  succeeds: (seen) => expect(seen.pruned).toBe(true),
});

const blockBetween = `SELECT 1 FROM block b
  JOIN account r ON r.identity_id = b.blocker_identity_id
  JOIN account d ON d.identity_id = b.blocked_identity_id
  WHERE r.id = $1 AND d.id = $2`;

async function blockAfterThePrune(blocked: boolean) {
  return rolledBack(async (db) => {
    const [reporter, reported] = await two(db);
    await reportIn(db, reporter, reported, LONG_AGO.toISOString());
    if (blocked) {
      await db.query(
        `INSERT INTO block (blocker_identity_id, blocked_identity_id, created_at)
         SELECT r.identity_id, d.identity_id, $3 FROM account r, account d WHERE r.id = $1 AND d.id = $2`,
        [reporter, reported, LONG_AGO],
      );
      expect((await db.query(blockBetween, [reporter, reported])).rows).toHaveLength(1);
    }
    await prune(db);
    return { blockLeft: (await db.query(blockBetween, [reporter, reported])).rows.length > 0 };
  });
}

attack("prune-reports: a pruned report's block goes with it", {
  attempt: () => blockAfterThePrune(true),
  // A report from before reports blocked: nothing is left by right.
  control: () => blockAfterThePrune(false),
  succeeds: (seen) => expect(seen.blockLeft).toBe(false),
});

async function photoAfterThePrune(senderErased: boolean) {
  return rolledBack(async (db) => {
    const [reader, sender] = await two(db);
    const conversationId = await conversationBetween(db, reader, sender, { openedAt: ago(DAY) });
    const store = memoryMediaStore();
    const { photoId } = await photoMessage(db, {
      conversationId,
      accountId: sender,
      side: "b",
      store,
    });
    if (senderErased)
      await db.query("UPDATE account SET state = 'deleted' WHERE id = $1", [sender]);
    await prune(db, store);
    return {
      gone: (await db.query("SELECT 1 FROM photo WHERE id = $1", [photoId])).rows.length === 0,
    };
  });
}

attack("prune-reports: a living sender's photo that no copy names is deleted", {
  attempt: () => photoAfterThePrune(false),
  control: () => photoAfterThePrune(true),
  succeeds: (seen) => expect(seen.gone).toBe(true),
});
