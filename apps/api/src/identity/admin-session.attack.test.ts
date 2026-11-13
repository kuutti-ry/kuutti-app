import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { staffSession } from "../test/account.ts";
import { attack } from "../test/attack.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { sweepAdminSessions } from "./admin-session.ts";

// sweep-admin-sessions (#49, #310, #380): every ended staff session goes,
// except each current member's newest, which the staff list reads as their
// last sign-in; it goes once a newer one replaces it or the role is taken
// away. A live session is nobody's to sweep. Each attack tries to make the
// night take what it must keep.

/** 04:00 in Helsinki, one October night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NIGHT.getTime() + hours * HOUR);

const removed = async (db: Queryable, id: string) =>
  (await db.query("SELECT 1 FROM admin_session WHERE id = $1", [id])).rows.length === 0;

/** A member's one panel session, signed in nine hours before the night and ended an hour before it. */
async function lastSignIn(roleKept: boolean) {
  return rolledBack(async (db) => {
    const staff = await staffSession(db);
    await db.query(
      "UPDATE admin_session SET created_at = $2, expires_at = $3, revoked_at = $3 WHERE id = $1",
      [staff.sessionId, at(-9), at(-1)],
    );
    if (!roleKept) {
      await db.query("DELETE FROM moderator_roles WHERE identity_id = $1", [staff.identityId]);
    }
    await sweepAdminSessions({ db, now: () => NIGHT });
    return { removed: await removed(db, staff.sessionId) };
  });
}

attack("sweep-admin-sessions: a current member's last sign-in is removed", {
  attempt: () => lastSignIn(true),
  control: () => lastSignIn(false),
  succeeds: (seen) => expect(seen.removed).toBe(true),
});

/** A member signed in twice, the older session ending at `olderEnds`; whether the night removed the older. */
async function olderOfTwo(olderEnds: Date) {
  return rolledBack(async (db) => {
    const staff = await staffSession(db);
    await db.query("UPDATE admin_session SET created_at = $2, expires_at = $3 WHERE id = $1", [
      staff.sessionId,
      at(-2),
      olderEnds,
    ]);
    await db.query(
      `INSERT INTO admin_session (identity_id, role, access_hash, created_at, expires_at)
       VALUES ($1::uuid, 'moderator', $1::text || ' newer', $2, $3)`,
      [staff.identityId, at(-1), at(7)],
    );
    await sweepAdminSessions({ db, now: () => NIGHT });
    return { removed: await removed(db, staff.sessionId) };
  });
}

attack("sweep-admin-sessions: a live staff session that is not the member's newest is removed", {
  attempt: () => olderOfTwo(at(6)),
  control: () => olderOfTwo(new Date(NIGHT.getTime() - 1000)),
  succeeds: (seen) => expect(seen.removed).toBe(true),
});
