import type { Queryable } from "@kuutti/db";
import { RESEARCH_K_MIN } from "@kuutti/schema";
import { expect } from "vitest";
import { addDays } from "../lib/finnish-day.ts";
import { attack } from "../test/attack.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { writeResearchCopy } from "./copy.ts";
import { type CopyStore, memoryCopyStore } from "./copy-store.ts";
import { ensureEventPartitions } from "./partitions.ts";
import { removeSubject } from "./repo.ts";

// research-export (#194, ADR-029, #380): each closed UTC day the table holds
// and the copy lacks becomes one file, once; a night that fails is caught up
// by the next; a value is released only for k pseudonyms whose consent is
// live. Each attack tries to make the copy write too early, write twice,
// lose a day, or count somebody who withdrew. Every test makes its months
// first, before anything touches `events` (research/track.test.ts says why),
// in 2019, where no partition of today's lies.

const FAILED = "the store is unavailable";

/** February and March 2019, the months every attack here writes from. */
const months = (db: Queryable) => ensureEventPartitions(db, new Date("2019-02-10T00:00:00Z"));

const copyAt = (db: Queryable, store: CopyStore, at: string) =>
  writeResearchCopy({ db, store, now: () => new Date(at) });

async function closedBy(at: string) {
  return rolledBack(async (db) => {
    await months(db);
    const store = memoryCopyStore();
    await copyAt(db, store, at);
    return { written: store.files.has("2019-03-01") };
  });
}

// 1 March 2019 ends at 00:00 UTC on the 2nd, and is closed an hour later.
attack("research copy: a day is written before it has closed", {
  attempt: () => closedBy("2019-03-02T00:59:59.000Z"),
  control: () => closedBy("2019-03-02T01:00:00.000Z"),
  succeeds: (seen) => expect(seen.written).toBe(true),
});

/** The memory store, whose put of 3 February fails `times` times. */
function failingOnTheThird(times: number) {
  const store = memoryCopyStore();
  let failed = 0;
  const putNew: CopyStore["putNew"] = async (day, body) => {
    if (day === "2019-02-03" && failed < times) {
      failed += 1;
      throw new Error(FAILED);
    }
    return store.putNew(day, body);
  };
  return { ...store, putNew };
}

async function twoNightsWith(failures: number) {
  return rolledBack(async (db) => {
    await months(db);
    const store = failingOnTheThird(failures);
    for (const at of ["2019-02-06T02:00:00Z", "2019-02-07T02:00:00Z"]) {
      // The night's runner logs a job that throws; only the planted failure may be thrown here.
      await copyAt(db, store, at).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === FAILED)) throw error;
      });
    }
    const missing: string[] = [];
    for (let day = "2019-02-01"; day <= "2019-02-06"; day = addDays(day, 1)) {
      if (!store.files.has(day)) missing.push(day);
    }
    return { missing };
  });
}

attack("research copy: a day the store failed on once is still missing after the next night", {
  attempt: () => twoNightsWith(1),
  // The store fails on the day the next night too: the day waits by right.
  control: () => twoNightsWith(2),
  succeeds: (seen) => expect(seen.missing).not.toEqual([]),
});

async function secondRunAt(at: string) {
  return rolledBack(async (db) => {
    await months(db);
    const store = memoryCopyStore();
    const puts: string[] = [];
    const counted: CopyStore = {
      ...store,
      putNew: (day, body) => {
        puts.push(day);
        return store.putNew(day, body);
      },
    };
    await copyAt(db, counted, "2019-02-06T02:00:00Z");
    const first = puts.length;
    await copyAt(db, counted, at);
    return { puts: puts.length - first };
  });
}

attack("research copy: a second run the same night puts a day's file again", {
  attempt: () => secondRunAt("2019-02-06T02:05:00Z"),
  // The next night has one more closed day to put.
  control: () => secondRunAt("2019-02-07T02:00:00Z"),
  succeeds: (seen) => expect(seen.puts).toBeGreaterThan(0),
});

/** k people in the study, one event each in one cell on 14 February; `withdrawn` of them withdraw before the night. */
async function releasedWith(withdrawn: number) {
  return rolledBack(async (db) => {
    await months(db);
    const accounts = await people(db, null, RESEARCH_K_MIN, { state: "active" });
    const { rows } = await db.query<{ account_id: string; research_id: string }>(
      `INSERT INTO research_subject (account_id, consent_version, enrolled_at)
       SELECT id, 'research-attack', '2019-01-01T00:00:00Z' FROM unnest($1::uuid[]) AS id
       RETURNING account_id, research_id::text`,
      [accounts],
    );
    await db.query(
      `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
       SELECT '2019-02-14T10:00:00Z', 'profile_saved', id::uuid, 'research-attack', 'otaniemi',
              '25-29', '{"gender": "woman", "fields": {"intent": "long_term"}}',
              '{"complete": true, "approvedPhotos": 3}'
       FROM unnest($1::text[]) AS id`,
      [rows.map((row) => row.research_id)],
    );
    for (const row of rows.slice(0, withdrawn)) await removeSubject(db, row.account_id);
    const run = await copyAt(db, memoryCopyStore(), "2019-02-16T02:00:00Z");
    return { released: run.released };
  });
}

attack("research copy: a person who withdrew still counts toward k in a cell of ten", {
  attempt: () => releasedWith(1),
  control: () => releasedWith(0),
  succeeds: (seen) => expect(seen.released).toBeGreaterThan(0),
});
