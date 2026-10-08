/**
 * Writes the synthetic population of #73 (ADR-014) into a local database or a
 * pull request's own, replacing the one that was there.
 *
 *   pnpm demo:population                      three hundred people, the usual seed
 *   pnpm demo:population -- --size 5000       as many as the round builder must carry
 *   pnpm demo:population -- --seed 7          other people, the same ponds
 *   pnpm demo:population -- --remove          removes them and writes nobody
 *   pnpm demo:population -- --dry-run         counts per pond, nothing written, no connection
 *
 * After a write or a removal the public counter of #54 is counted anew over
 * what is in the database now. By itself it would not move: it counts once a
 * day and moves in steps, which is right among people and would leave a demo
 * showing yesterday's ponds. What may be said of a pond is decided as ever.
 *
 * It goes ahead only in development, test and preview, understands every
 * argument or refuses, and asks the server it is connected to what it is
 * before it writes or removes anything: staging and production are refused
 * whatever the environment is called (packages/db/src/seed/command.ts).
 * The ponds come from the seed (`pnpm --filter @kuutti/db seed`), which runs
 * first. It lives with the API because the consents name the version of the
 * wording in force, which the API knows from the message catalogue.
 */
import { createPool, MATCHING_CONFIG_V1 } from "@kuutti/db";
import {
  assertDemoTarget,
  DemoCommandError,
  describeTarget,
  generatePopulation,
  parseDemoCommand,
  plannedPonds,
  removePopulation,
  uncrossed,
  writePopulation,
} from "@kuutti/db/demo";
import { CURRENT_CONSENT_VERSIONS } from "../src/identity/index.ts";
import { countGates } from "../src/jobs/pond-gate.ts";
import { takeSnapshot } from "../src/jobs/waitlist-snapshot.ts";
import { createLogger } from "../src/lib/logger.ts";
import { SPECIAL_CATEGORY_CONSENT_VERSION } from "../src/profile/index.ts";

function fail(message: string, code = 1): never {
  console.error(`✖ ${message}`);
  process.exit(code);
}

const command = (() => {
  try {
    return parseDemoCommand(process.argv.slice(2), process.env.APP_ENV);
  } catch (error) {
    if (error instanceof DemoCommandError) return fail(error.message, 2);
    throw error;
  }
})();
const { env, size, seed, action } = command;

const ponds = plannedPonds(size);
// What this size does not show, against the first version of the config: a
// small population is allowed, it is only said what it is too small for.
const notShown = uncrossed(ponds, {
  gateK: MATCHING_CONFIG_V1.gate_k,
  majorityShareMax: MATCHING_CONFIG_V1.majority_share_max,
  counterK: MATCHING_CONFIG_V1.waitlist_k,
});

if (action === "dry-run") {
  console.log(
    JSON.stringify({ msg: "demo population (dry run)", env, size, seed, ponds, notShown }, null, 2),
  );
  process.exit(0);
}

const url = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
const pool = createPool({ connectionString: url, max: 1, applicationName: "kuutti-demo" });
try {
  const target = await describeTarget(pool);
  // Where the rows go, before any goes: never the password, which is not asked for.
  console.log(JSON.stringify({ msg: "demo population: target", env, ...target }));
  assertDemoTarget(target, env);
  if (action === "remove") {
    const result = await removePopulation(pool);
    console.log(JSON.stringify({ msg: "demo population removed", env, ...result }));
  } else {
    const people = generatePopulation({ size, seed });
    const result = await writePopulation(pool, people, {
      ...CURRENT_CONSENT_VERSIONS,
      special_category: SPECIAL_CATEGORY_CONSENT_VERSION,
    });
    console.log(JSON.stringify({ msg: "demo population", env, size, seed, ...result, notShown }));
  }
  // The figures the counter stood on are of the ponds as they were: gone, and
  // counted anew. Only here, where the target has been asked what it is.
  await pool.query("DELETE FROM waitlist_snapshot");
  const logger = await createLogger({ level: "silent", pretty: false });
  const counted = await takeSnapshot({ db: pool, logger, now: () => new Date() });
  console.log(JSON.stringify({ msg: "demo population: counter recounted", ...counted }));
  // And the gates (#94): who is let into each pond, and for whom matching is open.
  const gates = await countGates({ db: pool, logger, now: () => new Date() });
  console.log(JSON.stringify({ msg: "demo population: gates counted", ...gates }));
} catch (error) {
  if (error instanceof DemoCommandError) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
