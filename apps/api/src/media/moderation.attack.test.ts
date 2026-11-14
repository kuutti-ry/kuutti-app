import type { Queryable } from "@kuutti/db";
import { expect, it } from "vitest";
import { attack } from "../test/attack.ts";
import { captureLogger } from "../test/harness.ts";
import { checked, scriptedModerator } from "../test/media.ts";
import { people } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { type Moderator, queueAllModerator, sweepPendingPhotos } from "./moderation.ts";
import { type MediaStore, memoryMediaStore, objectKey } from "./store.ts";

// moderate-pending-photos (#49, #380): the night's one more look at every
// pending photo the check never recorded. Each attack tries to make a night
// leave such a photo unlooked at, or look at one too soon. attack() hands on
// no `ctx`, so each part opens the harness's rolled-back transaction itself.

/** 04:00 in Helsinki, two October nights. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-17T01:00:00.000Z");
const MINUTE = 60_000;
const before = (at: Date, minutes: number) => new Date(at.getTime() - minutes * MINUTE);

/** `count` pending profile photos of one person, a second apart from `from`, oldest first; each card in the store unless `cards` is false. */
async function pending(
  db: Queryable,
  store: MediaStore,
  count: number,
  from: Date,
  cards = true,
): Promise<string[]> {
  const [owner] = await people(db, null, 1, { state: "active" });
  const { rows } = await db.query<{ id: string; key: string; position: number }>(
    `INSERT INTO photo (account_id, key, blurhash, width, height, state, position, created_at)
     SELECT $1::uuid, 'attack-pending-' || $1::text || '-' || n, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 800, 1067,
            'pending', n, $2::timestamptz + n * interval '1 second'
     FROM generate_series(0, $3::int - 1) n
     RETURNING id, key, position`,
    [owner, from, count],
  );
  const sorted = rows.sort((a, b) => a.position - b.position);
  if (cards) {
    for (const { key } of sorted) {
      await store.put(objectKey(key, "card"), new Uint8Array([1]), "image/webp");
    }
  }
  return sorted.map((row) => row.id);
}

async function night(db: Queryable, store: MediaStore, moderator: Moderator, at: Date) {
  const { logger } = await captureLogger();
  return sweepPendingPhotos({ db, logger, now: () => at, moderator, store });
}

const stillPending = async (db: Queryable, ids: readonly string[]) =>
  (await db.query("SELECT 1 FROM photo WHERE id = ANY($1::uuid[]) AND state = 'pending'", [ids]))
    .rows.length;

it("retries all 120 missed photos in one night", async () => {
  await rolledBack(async (db) => {
    const store = memoryMediaStore();
    const ids = await pending(db, store, 120, before(NIGHT, 60));
    expect(await night(db, store, queueAllModerator(), NIGHT)).toEqual({
      rechecked: 120,
      failed: 0,
    });
    expect(await stillPending(db, ids)).toBe(0);
  });
});

attack("moderate-pending-photos: of fifty-one photos the check missed, one is left unlooked at", {
  attempt: () =>
    rolledBack(async (db) => {
      const store = memoryMediaStore();
      const ids = await pending(db, store, 51, before(NIGHT, 60));
      await night(db, store, queueAllModerator(), NIGHT);
      return { left: await stillPending(db, ids) };
    }),
  // The fifty-first is uploaded five minutes before the night: not missed yet.
  control: () =>
    rolledBack(async (db) => {
      const store = memoryMediaStore();
      const ids = await pending(db, store, 50, before(NIGHT, 60));
      ids.push(...(await pending(db, store, 1, before(NIGHT, 5))));
      await night(db, store, queueAllModerator(), NIGHT);
      return { left: await stillPending(db, ids) };
    }),
  succeeds: (seen) => expect(seen.left).toBeGreaterThan(0),
});

/** Fifty photos whose card is gone, and behind them one with its card, uploaded at `last`; two nights. */
async function behindFifty(last: Date) {
  return rolledBack(async (db) => {
    const store = memoryMediaStore();
    await pending(db, store, 50, before(NIGHT, 120), false);
    const behind = await pending(db, store, 1, last);
    for (const at of [NIGHT, NEXT_NIGHT]) await night(db, store, queueAllModerator(), at);
    return { unlooked: (await stillPending(db, behind)) === 1 };
  });
}

attack(
  "moderate-pending-photos: behind fifty photos whose card is gone, a photo is never looked at, that night or the next",
  {
    attempt: () => behindFifty(before(NIGHT, 60)),
    // Uploaded five minutes before the second night: neither night may look at it yet.
    control: () => behindFifty(before(NEXT_NIGHT, 5)),
    succeeds: (seen) => expect(seen.unlooked).toBe(true),
  },
);

async function uploadedBefore(minutes: number) {
  return rolledBack(async (db) => {
    const store = memoryMediaStore();
    const ids = await pending(db, store, 1, before(NIGHT, minutes));
    await night(db, store, queueAllModerator(), NIGHT);
    return { looked: (await stillPending(db, ids)) === 0 };
  });
}

async function tiedFailures(lastIsDue: boolean) {
  return rolledBack(async (db) => {
    const store = memoryMediaStore();
    const failures = await pending(db, store, 51, before(NIGHT, 120), false);
    // Real PostgreSQL defaults carry microseconds; neither ties nor their
    // precision may send the cursor backwards through the same failed rows.
    await db.query(
      "UPDATE photo SET created_at = '2026-10-15 01:00:00.123456+00' WHERE id = ANY($1::uuid[])",
      [failures],
    );
    const behind = await pending(db, store, 1, before(NIGHT, lastIsDue ? 60 : 5));
    const result = await night(db, store, queueAllModerator(), NIGHT);
    expect(result.failed).toBe(51);
    return { unlooked: (await stillPending(db, behind)) === 1 };
  });
}

attack(
  "moderate-pending-photos: tied microsecond timestamps keep a later photo behind failed pages",
  {
    attempt: () => tiedFailures(true),
    control: () => tiedFailures(false),
    succeeds: (seen) => expect(seen.unlooked).toBe(true),
  },
);

attack(
  "moderate-pending-photos: a photo uploaded nine minutes before the night is looked at while its own check may still run",
  {
    attempt: () => uploadedBefore(9),
    control: () => uploadedBefore(11),
    succeeds: (seen) => expect(seen.looked).toBe(true),
  },
);

const UNAVAILABLE = "Rekognition unavailable";

/** Three photos the check missed, the first of which the check fails on; the two after it uploaded at `after`. */
async function afterAFailure(after: Date) {
  return rolledBack(async (db) => {
    const store = memoryMediaStore();
    await pending(db, store, 1, before(NIGHT, 60));
    const behind = await pending(db, store, 2, after);
    const failsFirst = scriptedModerator(new Error(UNAVAILABLE), checked(null));
    // The night's runner logs a job that throws; only the planted failure may be thrown here.
    await night(db, store, failsFirst, NIGHT).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === UNAVAILABLE)) throw error;
    });
    return { unlooked: await stillPending(db, behind) };
  });
}

attack(
  "moderate-pending-photos: the check failing on one photo leaves the photos after it unlooked at",
  {
    attempt: () => afterAFailure(before(NIGHT, 50)),
    // The two after it are uploaded five minutes before the night: not missed yet.
    control: () => afterAFailure(before(NIGHT, 5)),
    succeeds: (seen) => expect(seen.unlooked).toBeGreaterThan(0),
  },
);
