import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { captureLogger } from "../test/harness.ts";
import { people, pondNamed } from "../test/people.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { pondCounterJob } from "./pond-counter.ts";

// pond-counter (#54, ADR-013, #380): at most one count a Finnish calendar day,
// whichever process asks, and a shadow-banned account counts exactly like an
// active one. Each attack tries to make a second count of the same day move
// the figures, or a shadow ban show in them. A pond's first figures are its
// exact count; ten more people move them (the step of pond_counter_k).

/** 04:00 in Helsinki on 16.10.2026, and the next night. */
const NIGHT = new Date("2026-10-16T01:00:00.000Z");
const NEXT_NIGHT = new Date("2026-10-17T01:00:00.000Z");

const count = async (db: Queryable, at: Date) =>
  pondCounterJob({ db, logger: (await captureLogger()).logger, now: () => at }).run();

const figureOf = async (db: Queryable, pond: string) =>
  (
    await db.query<{ finished: number }>("SELECT finished FROM pond_counter WHERE pond_id = $1", [
      pond,
    ])
  ).rows[0]?.finished;

/** Twenty-five people counted at `first`, ten more finished, counted again at `second`. */
async function figureAfter(slug: string, first: Date, second: Date) {
  return rolledBack(async (db) => {
    const pond = await pondNamed(db, slug);
    await people(db, pond, 25, { complete: true });
    await count(db, first);
    await people(db, pond, 10, { complete: true });
    await count(db, second);
    return { finished: await figureOf(db, pond) };
  });
}

attack("pond-counter: a second count on the same Finnish day, a UTC day later, moves the figures", {
  // 00:30 and 04:00 of 16.10 in Helsinki: the 15th and the 16th by the clock of Greenwich.
  attempt: () => figureAfter("attack-counter-utc", new Date("2026-10-15T21:30:00.000Z"), NIGHT),
  // 23:30 of 15.10 in Helsinki, then 04:00 of the 16th: two Finnish days.
  control: () => figureAfter("attack-counter-utc", new Date("2026-10-15T20:30:00.000Z"), NIGHT),
  succeeds: (seen) => expect(seen.finished).toBe(35),
});

attack("pond-counter: a second run the same night moves the figures", {
  attempt: () => figureAfter("attack-counter-again", NIGHT, new Date(NIGHT.getTime() + 60_000)),
  control: () => figureAfter("attack-counter-again", NIGHT, NEXT_NIGHT),
  succeeds: (seen) => expect(seen.finished).toBe(35),
});

/** Twelve people and one more in `state`, counted once. */
async function countedWith(state: "shadow_banned" | "paused") {
  return rolledBack(async (db) => {
    const pond = await pondNamed(db, "attack-counter-shadow");
    await people(db, pond, 12, { complete: true });
    const [other] = await people(db, pond, 1, { complete: true });
    await db.query("UPDATE account SET state = $2::account_state WHERE id = $1", [other, state]);
    await count(db, NIGHT);
    return { finished: await figureOf(db, pond) };
  });
}

attack("pond-counter: a shadow-banned person is left out of the count", {
  attempt: () => countedWith("shadow_banned"),
  // A person on a break is not counted by right.
  control: () => countedWith("paused"),
  succeeds: (seen) => expect(seen.finished).toBe(12),
});
