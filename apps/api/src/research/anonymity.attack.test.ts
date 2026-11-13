import { expect } from "vitest";
import { attack } from "../test/attack.ts";
import { STOPPED_CLOCK } from "../test/global-setup.ts";
import { captureLogger } from "../test/harness.ts";
import { rolledBack } from "../test/rolled-back.ts";
import { researchAnonymityJob } from "./anonymity.ts";

// research-anonymity (ADR-011 §9, #380): the census warns of cells under k
// with counts only, "never a cell's values", which are the quasi-identifiers
// of the few people in them. Each attack tries to make the night's census
// say a cell's value, or warn of a table with nothing in it. Its events go
// into the month the test setup made for STOPPED_CLOCK.

const POND = "attack-census-pond";
/** pino's number for warn. */
const WARN = 40;

/** `people` pseudonyms with one event each in one cell of POND; the census's lines, its logger bound to `bound` if given. */
async function census(people: number, bound?: Record<string, string>) {
  return rolledBack(async (db) => {
    await db.query(
      `INSERT INTO events (at, name, research_id, consent_version, pond, age_band, snapshot, props)
       SELECT $1, 'profile_saved', md5('attack-census-' || n)::uuid, 'v1', $2, '25-29',
              '{"gender": "woman", "fields": {"intent": "long_term"}}', '{}'
       FROM generate_series(1, $3::int) n`,
      [STOPPED_CLOCK, POND, people],
    );
    const { logger, lines } = await captureLogger();
    await researchAnonymityJob({ db, logger: bound ? logger.child(bound) : logger }).run();
    return {
      text: JSON.stringify(lines()),
      warnings: lines().filter((line) => line.level === WARN).length,
    };
  });
}

attack("research census: its warning names a small cell's pond", {
  attempt: () => census(2),
  // The same warning, through a logger that names the pond on every line.
  control: () => census(2, { planted: POND }),
  succeeds: (seen) => expect(seen.text).toContain(POND),
});

attack("research census: a table with no events in it is warned about", {
  attempt: () => census(0),
  control: () => census(2),
  succeeds: (seen) => expect(seen.warnings).toBeGreaterThan(0),
});
