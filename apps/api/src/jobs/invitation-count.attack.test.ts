import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { applySanction } from "../safety/index.ts";
import { signedInAccount, withMatchingConfig } from "../test/account.ts";
import { attack } from "../test/attack.ts";
import { captureLogger } from "../test/harness.ts";
import { completed, consented, invitationOf } from "../test/invitations.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { invitationCountJob } from "./invitation-count.ts";

// invitation-count (#107, ADR-044 §7, #380): an invitation counts the first
// night its redeemer's profile is complete, once; "Somebody suspended or
// banned is not complete while the sanction stands, so their invitation
// waits for the lift"; "A banned or suspended inviter still earns". Each
// attack tries to make the night count twice, count a suspended friend, or
// keep a suspended inviter's fish.

/** 04:00 in Finland, one Friday; the sanctions are given the day before. */
const T = new Date("2026-10-23T01:00:00.000Z");
const GIVEN = new Date("2026-10-22T09:00:00.000Z");

const countAt = async (db: Queryable, at: Date) =>
  invitationCountJob({ db, logger: (await captureLogger()).logger, now: () => at }).run();

/** A friend who typed `inviter`'s code; complete when `finished`. */
async function friendOf(db: Queryable, inviter: string, finished: boolean) {
  const friend = (await signedInAccount(db, undefined, { state: "registered" })).accountId;
  await consented(db, friend);
  const id = await invitationOf(db, inviter, { redeemedBy: friend });
  if (finished) await completed(db, friend);
  return { friend, id };
}

/** An inviter whose profile is complete, at the night's reward of one fish a side. */
async function inviterIn(db: Queryable) {
  await withMatchingConfig(db, { invitation_reward: { inviterFish: 1, friendFish: 1 } });
  const inviter = (await signedInAccount(db)).accountId;
  await completed(db, inviter);
  return inviter;
}

const suspend = (db: Queryable, accountId: string) =>
  applySanction(db, {
    accountId,
    kind: "suspend",
    reason: "other",
    note: "Kept writing after being asked to stop.",
    endsOn: "2026-10-30",
    actor: null,
    at: GIVEN,
  });

async function secondRun(anotherFinishesBetween: boolean) {
  return rolledBack(async (db) => {
    const inviter = await inviterIn(db);
    await friendOf(db, inviter, true);
    const late = anotherFinishesBetween ? await friendOf(db, inviter, false) : null;
    await countAt(db, T);
    if (late) await completed(db, late.friend);
    return { again: (await countAt(db, new Date(T.getTime() + 60_000))).counted };
  });
}

attack("invitation-count: a second run the same night counts an invitation again", {
  attempt: () => secondRun(false),
  // A second friend finishes between the two runs: theirs counts by right.
  control: () => secondRun(true),
  succeeds: (seen) => expect(seen.again).toBeGreaterThan(0),
});

async function countedIf(friendSuspended: boolean) {
  return rolledBack(async (db) => {
    const { friend } = await friendOf(db, await inviterIn(db), true);
    if (friendSuspended) await suspend(db, friend);
    return { counted: (await countAt(db, T)).counted };
  });
}

attack("invitation-count: a suspended friend's invitation counts", {
  attempt: () => countedIf(true),
  control: () => countedIf(false),
  succeeds: (seen) => expect(seen.counted).toBe(1),
});

async function inviterEarns(inviterIs: "suspended" | "erased") {
  return rolledBack(async (db) => {
    const inviter = await inviterIn(db);
    const { id } = await friendOf(db, inviter, true);
    if (inviterIs === "suspended") await suspend(db, inviter);
    else {
      // What the inviter's erasure leaves of a redeemed invitation (ADR-044 §10).
      await db.query("UPDATE invitation SET inviter_account_id = NULL WHERE id = $1", [id]);
      await db.query("UPDATE account SET state = 'deleted' WHERE id = $1", [inviter]);
    }
    await countAt(db, T);
    const units = await db.query("SELECT 1 FROM reward WHERE account_id = $1", [inviter]);
    return { units: units.rows.length };
  });
}

attack("invitation-count: a suspended inviter earns nothing for a friend who finished", {
  attempt: () => inviterEarns("suspended"),
  // "An inviter erased before it counted earns nothing" (ADR-044 §10).
  control: () => inviterEarns("erased"),
  succeeds: (seen) => expect(seen.units).toBe(0),
});
