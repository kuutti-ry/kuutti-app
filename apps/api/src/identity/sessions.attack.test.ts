import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { sweepSessions } from "./sessions.ts";

// sweep-sessions (#35, ADR-058, #380): ended sessions stay thirty days for the
// device list and support, then go; expired ones go; so does every session of
// an erased account; a login attempt still open, under way or holding a live
// code stays. Each attack tries to make the night take one too soon or keep
// one it must take.

/** 04:00 in Helsinki, one October night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const ago = (ms: number) => new Date(NIGHT.getTime() - ms);

/** One session of a new person, ended at `revokedAt` (or live), refresh good for sixty days more; whether the night removed it. */
async function sessionSwept(revokedAt: Date | null, state: "active" | "deleted" = "active") {
  return rolledBack(async (db) => {
    const [accountId] = await people(db, null, 1, { state: "active" });
    if (!accountId) throw new Error("person not written");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash,
                            family_hash, expires_at, revoked_at)
       VALUES ($1::uuid, 'ios', $1::text || ' access', $2, $1::text || ' refresh',
               $1::text || ' family', $3, $4)
       RETURNING id`,
      [accountId, NIGHT, new Date(NIGHT.getTime() + 60 * DAY), revokedAt],
    );
    await db.query("UPDATE account SET state = $2 WHERE id = $1", [accountId, state]);
    await sweepSessions({ db, now: () => NIGHT });
    const left = await db.query("SELECT 1 FROM session WHERE id = $1", [rows[0]?.id]);
    return { removed: left.rows.length === 0 };
  });
}

attack("sweep-sessions: a session ended a second short of thirty days ago is removed", {
  attempt: () => sessionSwept(ago(30 * DAY - SECOND)),
  control: () => sessionSwept(ago(30 * DAY + SECOND)),
  succeeds: (seen) => expect(seen.removed).toBe(true),
});

attack("sweep-sessions: a session of an erased person is kept while it is within its thirty days", {
  attempt: () => sessionSwept(ago(DAY), "deleted"),
  control: () => sessionSwept(ago(DAY)),
  succeeds: (seen) => expect(seen.removed).toBe(false),
});

/** A login attempt over a second ago whose code lives until `codeExpiresAt`; whether the night removed it. */
async function attemptSwept(codeExpiresAt: Date) {
  return rolledBack(async (db) => {
    await db.query(
      `INSERT INTO auth_request (state, nonce, platform, expires_at, code_hash, code_expires_at, outcome)
       VALUES ('attack-live-code', 'n', 'ios', $1, 'attack-live-code-hash', $2, 'created')`,
      [ago(SECOND), codeExpiresAt],
    );
    await sweepSessions({ db, now: () => NIGHT });
    const left = await db.query("SELECT 1 FROM auth_request WHERE state = 'attack-live-code'");
    return { removed: left.rows.length === 0 };
  });
}

attack("sweep-sessions: a login attempt whose code is still live is removed", {
  attempt: () => attemptSwept(new Date(NIGHT.getTime() + SECOND)),
  control: () => attemptSwept(ago(SECOND)),
  succeeds: (seen) => expect(seen.removed).toBe(true),
});
