import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { captureLogger } from "../test/harness.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { copiedBeforeDrop } from "./copy.ts";
import type { CopyStore } from "./copy-store.ts";
import {
  ensureEventPartitions,
  eventPartitions,
  type MonthPartition,
  pruneEventPartitions,
  researchEventsJob,
} from "./partitions.ts";

// research-events-partitions (#50, ADR-011, ADR-029 §6, #380): the current
// and the next month exist after every night, a month whose range began
// ninety days ago or earlier is dropped whole, "so a row lives between about
// 60 and 90 days, never longer", and a copy that cannot be checked does not
// keep a month. Each attack tries to make a night drop a month too early,
// keep one past its days, or miss the month ahead. The months are 2018 and
// 2019, made inside the rolled-back transaction before anything touches
// `events`, where no partition of today's lies.

/** January 2019 began at 00:00 UTC on the 1st; its ninety days end at 00:00 UTC on 1 April. */
const JANUARY_ENDS = new Date("2019-04-01T00:00:00.000Z");
const SECOND = 1000;
const UNANSWERED = "the copy's store does not answer";

type BeforeDrop = (months: MonthPartition[]) => Promise<number>;

/** The months of `planted` and the one after; a night at `at`; whether `planted`'s month is still there. */
async function keptAfter(
  planted: string,
  at: Date,
  beforeDrop?: (db: Queryable) => BeforeDrop,
  exact = false,
) {
  return rolledBack(async (db) => {
    await ensureEventPartitions(db, new Date(`${planted}-10T00:00:00Z`));
    const check = beforeDrop?.(db);
    const job = researchEventsJob({ db, now: () => at, ...(check ? { beforeDrop: check } : {}) });
    // The night's runner logs a job that throws; only the planted failure may be thrown here.
    await (exact ? pruneEventPartitions(db, at) : job.run()).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === UNANSWERED)) throw error;
    });
    return { kept: (await eventPartitions(db)).includes(`events_${planted.replace("-", "_")}`) };
  });
}

attack("partitions: a month that began ninety days ago to the second is kept", {
  attempt: () => keptAfter("2019-01", JANUARY_ENDS, undefined, true),
  control: () => keptAfter("2019-01", new Date(JANUARY_ENDS.getTime() - SECOND), undefined, true),
  succeeds: (seen) => expect(seen.kept).toBe(true),
});

attack("partitions: a month that began ninety days less a second ago is dropped", {
  attempt: () => keptAfter("2019-01", new Date(JANUARY_ENDS.getTime() - SECOND), undefined, true),
  control: () => keptAfter("2019-01", JANUARY_ENDS, undefined, true),
  succeeds: (seen) => expect(seen.kept).toBe(false),
});

// 04:00 in Helsinki on 31 March 2019, the first night of summer time; the next
// is at 01:00 UTC on 1 April, an hour after January's first row turns ninety
// days old. February's turns ninety on 2 May.
const TONIGHT = new Date("2019-03-31T01:00:00.000Z");

attack(
  "partitions: a month whose first row turns ninety days old before the next night is kept tonight",
  {
    attempt: () => keptAfter("2019-01", TONIGHT),
    control: () => keptAfter("2019-02", TONIGHT),
    succeeds: (seen) => expect(seen.kept).toBe(true),
  },
);

async function januaryAfter(night: Date) {
  return rolledBack(async (db) => {
    await researchEventsJob({ db, now: () => night }).run();
    return { januaryMissing: !(await eventPartitions(db)).includes("events_2019_01") };
  });
}

attack("partitions: after the night of the last day of December, January's month is missing", {
  attempt: () => januaryAfter(new Date("2018-12-31T02:00:00.000Z")),
  // The night of 30 November makes November and December: January is not due yet.
  control: () => januaryAfter(new Date("2018-11-30T02:00:00.000Z")),
  succeeds: (seen) => expect(seen.januaryMissing).toBe(true),
});

const unreachable = async (): Promise<never> => {
  throw new Error(UNANSWERED);
};
const BROKEN: CopyStore = { days: unreachable, get: unreachable, putNew: unreachable };

/** The night checks the copy first through a store that does not answer, as boot.ts wires it. */
const brokenCopy =
  (at: Date) =>
  (db: Queryable): BeforeDrop =>
  async (months) =>
    copiedBeforeDrop(
      { db, now: () => at, store: BROKEN, logger: (await captureLogger()).logger },
      months,
    );

const MAY_NIGHT = new Date("2019-05-15T02:00:00.000Z");
const MARCH_NIGHT = new Date("2019-03-30T02:00:00.000Z");

attack(
  "partitions: a month past its ninety days is kept when its research copy cannot be checked",
  {
    attempt: () => keptAfter("2019-01", MAY_NIGHT, brokenCopy(MAY_NIGHT)),
    // On 30 March January is inside its ninety days: kept by right.
    control: () => keptAfter("2019-01", MARCH_NIGHT, brokenCopy(MARCH_NIGHT)),
    succeeds: (seen) => expect(seen.kept).toBe(true),
  },
);
