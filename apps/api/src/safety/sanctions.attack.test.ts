import type { Queryable } from "@kuutti/db";
import type { SanctionKind } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { applySanction, endSuspensions } from "./sanctions.ts";

// What goes through today (#380): a hole, which its contract forbids.
const HOLE = "#380";

// end-suspensions (#307, ADR-024 §5, #380): every night, every open
// suspension past its end is closed by nobody and its account settled from
// what is still open, one account per transaction. Each attack tries to make
// a night lift one too early, let somebody in whom something else keeps out,
// keep what an erasure leaves to the night, or leave a due one open.

/** When the suspensions are given, and the day they end: at the start of 17.10.2026 in Finland. */
const GIVEN = new Date("2026-10-14T09:00:00.000Z");
const ENDS_ON = "2026-10-17";
const ENDS_AT = new Date("2026-10-16T21:00:00.000Z");
/** 04:00 in Helsinki on the day it ends, and the next night. */
const NIGHT = new Date("2026-10-17T01:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-18T01:00:00.000Z");
const SECOND = 1000;
const STUCK = "this person's settlement fails every night";

const give = (db: Queryable, accountId: string, kind: SanctionKind, endsOn?: string) =>
  applySanction(db, {
    accountId,
    kind,
    reason: "other",
    note: "Kept writing after being asked to stop.",
    actor: null,
    at: GIVEN,
    ...(endsOn ? { endsOn } : {}),
  });

/** A person suspended until the start of `endsOn` in Finland, as the panel leaves them. */
async function suspended(db: Queryable, endsOn = ENDS_ON): Promise<string> {
  const [accountId] = await people(db, null, 1, { state: "active" });
  if (!accountId) throw new Error("person not written");
  await give(db, accountId, "suspend", endsOn);
  return accountId;
}

const openSuspensions = async (db: Queryable, ids: readonly string[]) =>
  (
    await db.query(
      `SELECT 1 FROM sanction
        WHERE account_id = ANY($1::uuid[]) AND kind = 'suspend' AND lifted_at IS NULL`,
      [ids],
    )
  ).rows.length;

const standingOf = async (db: Queryable, accountId: string) =>
  (
    await db.query<{ standing: string }>(
      "SELECT i.standing FROM identity i JOIN account a ON a.identity_id = i.id WHERE a.id = $1",
      [accountId],
    )
  ).rows[0]?.standing;

async function liftedAt(at: Date) {
  return rolledBack(async (db) => {
    const id = await suspended(db);
    await endSuspensions(db, at);
    return { lifted: (await openSuspensions(db, [id])) === 0 };
  });
}

attack("end-suspensions: a suspension is lifted a second before it ends", {
  attempt: () => liftedAt(new Date(ENDS_AT.getTime() - SECOND)),
  control: () => liftedAt(ENDS_AT),
  succeeds: (seen) => expect(seen.lifted).toBe(true),
});

async function standingAfterTheNight(alsoBanned: boolean) {
  return rolledBack(async (db) => {
    const id = await suspended(db);
    if (alsoBanned) await give(db, id, "ban");
    await endSuspensions(db, NIGHT);
    return { standing: await standingOf(db, id) };
  });
}

attack("end-suspensions: a person who is also banned is let back in when the suspension ends", {
  attempt: () => standingAfterTheNight(true),
  control: () => standingAfterTheNight(false),
  succeeds: (seen) => expect(seen.standing).toBe("ok"),
});

// ADR-024 §8: erasure keeps an open suspension on the identity, and "a kept
// row goes when it is lifted later (by an admin or the night)".
async function recordAfterTheNight(erased: boolean) {
  return rolledBack(async (db) => {
    const id = await suspended(db);
    if (erased) await db.query("UPDATE account SET state = 'deleted' WHERE id = $1", [id]);
    await endSuspensions(db, NIGHT);
    const rows = await db.query("SELECT 1 FROM sanction WHERE account_id = $1", [id]);
    return { kept: rows.rows.length > 0 };
  });
}

attack("end-suspensions: an erased person's suspension, lifted by the night, stays on the record", {
  attempt: () => recordAfterTheNight(true),
  control: () => recordAfterTheNight(false),
  succeeds: (seen) => expect(seen.kept).toBe(true),
});

/**
 * The database, except that the night's lift of the first person it tries
 * throws, and throws again on every later night: one item the night can
 * never finish, as a person whose settlement keeps failing would be.
 */
function stuckOnTheFirst(db: Queryable): Queryable & { stuck: () => string | undefined } {
  let stuck: string | undefined;
  return {
    stuck: () => stuck,
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      if (/^\s*UPDATE sanction SET lifted_at/.test(text)) {
        stuck ??= String(values?.[0]);
        if (values?.[0] === stuck) throw new Error(STUCK);
      }
      return db.query<R>(text, values);
    },
  };
}

/** Three people suspended; those after the first end on `othersEndOn`; two nights, one person stuck. */
async function behindTheStuck(othersEndOn: string) {
  return rolledBack(async (db) => {
    const ids = [await suspended(db), await suspended(db, othersEndOn)];
    ids.push(await suspended(db, othersEndOn));
    const db2 = stuckOnTheFirst(db);
    for (const at of [NIGHT, NEXT_NIGHT]) {
      // The night's runner logs a job that throws; only the planted failure may be thrown here.
      await endSuspensions(db2, at).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === STUCK)) throw error;
      });
    }
    return {
      othersOpen: await openSuspensions(
        db,
        ids.filter((id) => id !== db2.stuck()),
      ),
    };
  });
}

attack(
  "end-suspensions: one person the night cannot settle keeps the others suspended past their day, that night and the next",
  {
    // Goes through today: the loop over the accounts has no catch, so one that fails ends the job, every night.
    open: HOLE,
    attempt: () => behindTheStuck(ENDS_ON),
    // The others end after both nights: their suspensions are open by right.
    control: () => behindTheStuck("2026-10-20"),
    succeeds: (seen) => expect(seen.othersOpen).toBeGreaterThan(0),
  },
);

async function secondRun(firstRun: Date) {
  return rolledBack(async (db) => {
    await suspended(db);
    await endSuspensions(db, firstRun);
    return { again: await endSuspensions(db, new Date(NIGHT.getTime() + 60 * SECOND)) };
  });
}

attack("end-suspensions: a second run the same night ends a suspension again", {
  attempt: () => secondRun(NIGHT),
  // The first run is the night before the end: the second is the one that ends it.
  control: () => secondRun(new Date(NIGHT.getTime() - 24 * 60 * 60 * SECOND)),
  succeeds: (seen) => expect(seen.again).toBeGreaterThan(0),
});
