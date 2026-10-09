/**
 * Gives the personas their stories on staging (#141, ADR-018), from inside
 * the API's container:
 *
 *   node dist/demo-stories.js       (infra/README.md says how to reach the container)
 *
 * Staging's bank is Telia's bed, which no script drives, so the job does what
 * a registration does, in the one place that holds the key: it derives each
 * persona's hash from its artificial code with the container's own
 * configuration, creates the identity and the account as the callback would,
 * and gives the story through the service functions the routes call. The
 * persona's first real login at a test bank then finds the identity by the
 * same hash and resumes the live account. Run again, it resumes everybody
 * and changes nothing; a story that ends in a ban or a deletion is told
 * already, and is left so.
 *
 * It refuses unless the process is staging's container: APP_ENV is staging
 * and nothing of the database or the key was given by hand (the parameter
 * store is read through the container's role, as the API reads it); the
 * server is asked that it is a managed one; every persona's code is
 * artificial. Its lines carry keys and counts, never a code, a name or whom
 * one seeks. `pnpm demo:stories` runs the same file on a laptop, where it
 * refuses. The photos of the stories come with #142.
 */
import { createPool } from "@kuutti/db";
import {
  assertArtificial,
  assertDemoTarget,
  assertStagingProcess,
  DEMO_PERSONAS,
  DemoCommandError,
  describeTarget,
} from "@kuutti/db/demo";
import { hmacKeyFromHex } from "../src/identity/index.ts";
import { countGates } from "../src/jobs/pond-gate.ts";
import { takeSnapshot } from "../src/jobs/waitlist-snapshot.ts";
import { loadConfig } from "../src/lib/config.ts";
import { createLogger } from "../src/lib/logger.ts";
import { createMediaDeps } from "../src/media/index.ts";
import { DemoError } from "./demo/bank.ts";
import { giveStories, viaServices } from "./demo/services.ts";

function fail(message: string, code = 2): never {
  console.error(`✖ ${message}`);
  process.exit(code);
}

if (process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0)).length > 0) {
  fail("the stories take no argument");
}

try {
  assertStagingProcess(process.env);
} catch (error) {
  if (error instanceof DemoCommandError) fail(error.message);
  throw error;
}
for (const persona of DEMO_PERSONAS) assertArtificial(persona);

const config = await loadConfig();
const hmacKey = config.HETU_HMAC_KEY
  ? hmacKeyFromHex(config.HETU_HMAC_KEY)
  : fail("the parameter store has no hetu-hmac-key: the login does not run either");
const media = createMediaDeps(config);
const logger = await createLogger({ level: "warn", pretty: false });
const pool = createPool({
  connectionString: config.databaseUrl,
  max: 2,
  applicationName: "kuutti-demo-stories",
});
try {
  const target = await describeTarget(pool);
  console.log(
    JSON.stringify({
      msg: "demo stories: target",
      env: config.APP_ENV,
      objects: media.setup.mode,
      ...target,
    }),
  );
  assertDemoTarget(target, "staging");

  const now = () => new Date();
  const writer = viaServices({ db: pool, logger, now, hmacKey, media: media.deps });
  for (const given of await giveStories(writer)) {
    console.log(JSON.stringify({ msg: "demo stories: history", ...given }));
  }
  // The pond has other people in it now (ADR-018: nobody on staging is
  // anybody, so the counter of #54 is counted anew, as the population does).
  await pool.query("DELETE FROM waitlist_snapshot");
  const counted = await takeSnapshot({ db: pool, logger, now });
  console.log(JSON.stringify({ msg: "demo stories: counter recounted", ...counted }));
  const gates = await countGates({ db: pool, logger, now });
  console.log(JSON.stringify({ msg: "demo stories: gates counted", ...gates }));
} catch (error) {
  if (error instanceof DemoCommandError || error instanceof DemoError) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
