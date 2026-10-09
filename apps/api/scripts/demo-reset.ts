/**
 * Returns the twelve personas to where they begin (#73, ADR-014 §12; on
 * staging #141, ADR-018): everybody erased through the erasure path and
 * forgotten, then the six with a history given it anew.
 *
 *   pnpm demo:reset                  reset, then the histories
 *   pnpm demo:reset -- --bare        reset only: all twelve are newcomers
 *   pnpm demo:reset -- --api http://localhost:3000
 *   pnpm demo:reset -- --objects-lost   although the store does not hold the photos
 *   node dist/demo-reset.js --env staging   inside the API's container on staging
 *
 * Locally it needs the environment running (`pnpm env:up`): the histories
 * log in at the mock bank and talk to the API through its own routes.
 * Everything it touches is on this computer, and it looks before it acts:
 * development or test, an API and a bank on a loopback address,
 * configuration from this process alone (never from a parameter store), no
 * proxy, a database server that is not a deployed one, an object store at an
 * address of this computer (or none, while no persona has a photo), and,
 * where histories are to be given, an API that answers as ours, from this
 * database, before anybody is erased.
 *
 * On staging there is no mock bank and no API to call: the personas are the
 * test persons of Telia's bed, known by the hash the container derives from
 * their artificial codes with its own key, and the histories are given
 * through the service functions (demo-stories.ts). The command refuses
 * unless the process is staging's container (APP_ENV, and nothing of the
 * database or the key given by hand), reads its configuration as the API
 * does, and asks the server that it is a managed one; the object store is
 * the environment's own.
 */
import { networkInterfaces } from "node:os";
import { createPool } from "@kuutti/db";
import {
  assertDemoTarget,
  assertStagingProcess,
  DemoCommandError,
  describeTarget,
  PERSONA_HISTORIES,
} from "@kuutti/db/demo";
import { hmacKeyFromHex } from "../src/identity/index.ts";
import { countGates } from "../src/jobs/pond-gate.ts";
import { takeSnapshot } from "../src/jobs/waitlist-snapshot.ts";
import { loadConfig, parseConfig } from "../src/lib/config.ts";
import { createLogger, type Logger } from "../src/lib/logger.ts";
import { createMediaDeps } from "../src/media/index.ts";
import { DemoError, lookAtApi, onThisComputer, whyNotTheLocalStore } from "./demo/bank.ts";
import { giveHistory, viaRoutes } from "./demo/histories.ts";
import { type ResetResult, resetPersonas } from "./demo/reset.ts";
import { giveStories, personaHashes, viaServices } from "./demo/services.ts";

function fail(message: string, code = 2): never {
  console.error(`✖ ${message}`);
  process.exit(code);
}

const DEFAULT_API = "http://localhost:3000";

// pnpm hands the separator through.
const args = process.argv.slice(2).filter((arg, i) => !(arg === "--" && i === 0));
let api = DEFAULT_API;
let envArg: string | undefined;
let bare = false;
let objectsLost = false;
const seen = new Set<string>();
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i] as string;
  const equals = arg.indexOf("=");
  const flag = equals > 0 ? arg.slice(0, equals) : arg;
  if (seen.has(flag)) fail(`${flag} is given twice`);
  seen.add(flag);
  const value = () => {
    if (equals > 0) return arg.slice(equals + 1);
    i += 1;
    return args[i];
  };
  if (arg === "--bare") bare = true;
  else if (arg === "--objects-lost") objectsLost = true;
  else if (flag === "--api") api = value() ?? fail("--api takes the address of the API");
  else if (flag === "--env") envArg = value() ?? fail("--env takes the name of the environment");
  else fail(`unknown argument ${arg}: --bare, --api, --env and --objects-lost are all there is`);
}

const env = envArg ?? process.env.APP_ENV ?? "development";
if (envArg !== undefined && process.env.APP_ENV !== undefined && envArg !== process.env.APP_ENV) {
  fail(`refusing: --env is "${envArg}" and APP_ENV is "${process.env.APP_ENV}"`);
}

/** The counter and the gates after the people changed: the same two steps locally and on staging. */
async function recount(pool: ReturnType<typeof createPool>, logger: Logger, now: () => Date) {
  // The ponds have other people in them now: the counter of #54 is counted
  // anew, as after a write of the population (demo-population.ts says why).
  await pool.query("DELETE FROM waitlist_snapshot");
  const counted = await takeSnapshot({ db: pool, logger, now });
  console.log(JSON.stringify({ msg: "demo reset: counter recounted", ...counted }));
  // And the gates (#94): who is let into each pond, and for whom matching is open.
  const gates = await countGates({ db: pool, logger, now });
  console.log(JSON.stringify({ msg: "demo reset: gates counted", ...gates }));
}

function sparedOrThrow(reset: ResetResult): void {
  if (reset.spared.length > 0) {
    throw new DemoError(
      `left alone, because they hold a staff row on this machine: ${reset.spared.join(", ")}. Take the role away (pnpm --filter @kuutti/db moderator -- revoke), which ends the staff sessions too, and reset again; a persona that has looked at a photo or decided on one as a moderator is in the audit log and stays until the database is made anew`,
    );
  }
}

async function localReset(): Promise<void> {
  const apiUrl = URL.canParse(api) ? new URL(api) : fail(`--api is no address: ${api}`);
  if (!onThisComputer(apiUrl)) {
    fail(`refusing: the personas get their histories from a local API, not from ${apiUrl.host}`);
  }

  // Node sends fetch through a proxy when it is told to, loopback addresses
  // included unless NO_PROXY names them: a persona's claims and a session's
  // token would then pass through somebody else.
  if (process.env.NODE_USE_ENV_PROXY) {
    fail("refusing: NODE_USE_ENV_PROXY is set, and nothing of this goes through a proxy; unset it");
  }

  if (env !== "development" && env !== "test") {
    fail(
      `refusing: APP_ENV is "${env}", and the personas are reset in development and test only: nothing else has a mock bank`,
    );
  }

  // From this process's environment and nothing else: `loadConfig` would read a
  // parameter store when a prefix is set, and a deployed environment's
  // configuration has no business here.
  const config = parseConfig({ ...process.env, SSM_PARAMETER_PREFIX: undefined });
  const issuer = config.OIDC_ISSUER && URL.canParse(config.OIDC_ISSUER) ? config.OIDC_ISSUER : null;
  if (!issuer || !onThisComputer(new URL(issuer))) {
    fail(
      `refusing: the bank of this configuration is ${issuer ? new URL(issuer).host : "not set"}, not the mock bank on this computer`,
    );
  }
  // Erasure deletes a photo's objects. The local stand-in's, or nobody's: a
  // bucket behind a distribution is a deployed one, and an endpoint is any
  // address somebody wrote into the configuration, so the store is asked where
  // it is: on this computer, by a loopback address or by one of the computer's
  // own (a phone on the network reaches the stand-in by that one, env.example),
  // addressed by path, in a bucket that is a name.
  const media = createMediaDeps(config);
  if (media.setup.mode === "cloudfront") {
    fail("refusing: the object store of this configuration is a deployed one");
  }
  if (media.setup.mode === "presigned") {
    const own = Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).map((a) => a.address),
    );
    const why = whyNotTheLocalStore(
      {
        endpoint: media.setup.endpoint,
        bucket: media.setup.bucket,
        pathStyle: config.S3_FORCE_PATH_STYLE,
      },
      own,
    );
    if (why) {
      fail(
        `refusing: the object store of this configuration is not the stand-in on this computer: ${why}`,
      );
    }
  }
  const store = media.setup.mode === "presigned" ? media.deps : undefined;

  const logger = await createLogger({ level: "warn", pretty: false });
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 2,
    applicationName: "kuutti-demo-reset",
  });
  try {
    const target = await describeTarget(pool);
    console.log(
      JSON.stringify({
        msg: "demo reset: target",
        env,
        api: apiUrl.origin,
        bank: new URL(issuer).origin,
        objects: media.setup.mode,
        ...target,
      }),
    );
    assertDemoTarget(target, env);

    const now = () => new Date();
    // Before anybody is erased: an API that is not there, or not ours, or not
    // ready, or of another database than this one, would leave the six
    // without the history they were erased for.
    if (!bare) {
      const looked = await lookAtApi({ api: apiUrl.origin, fetch, now, db: pool });
      console.log(JSON.stringify({ msg: "demo reset: the API", api: apiUrl.origin, ...looked }));
    }
    const reset = await resetPersonas({
      db: pool,
      logger,
      now,
      objectsLost,
      ...(store ? { media: store } : {}),
    });
    console.log(JSON.stringify({ msg: "demo reset: personas forgotten", ...reset }));

    if (!bare) {
      const writer = viaRoutes({ api: apiUrl.origin, fetch, now, db: pool });
      for (const history of PERSONA_HISTORIES) {
        if (reset.spared.includes(history.key)) continue;
        const given = await giveHistory(history, writer);
        console.log(JSON.stringify({ msg: "demo reset: history", ...given }));
      }
    }
    await recount(pool, logger, now);
    sparedOrThrow(reset);
  } finally {
    await pool.end();
  }
}

async function stagingReset(): Promise<void> {
  if (api !== DEFAULT_API) {
    fail("refusing: --api is for the local environment; on staging there is no API to call");
  }
  assertStagingProcess(process.env);
  const config = await loadConfig();
  const hmacKey = config.HETU_HMAC_KEY
    ? hmacKeyFromHex(config.HETU_HMAC_KEY)
    : fail("the parameter store has no hetu-hmac-key: the login does not run either");
  // The environment's own store, read from its parameters: where the API put the photos.
  const media = createMediaDeps(config);
  const logger = await createLogger({ level: "warn", pretty: false });
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: 2,
    applicationName: "kuutti-demo-reset",
  });
  try {
    const target = await describeTarget(pool);
    console.log(
      JSON.stringify({ msg: "demo reset: target", env, objects: media.setup.mode, ...target }),
    );
    assertDemoTarget(target, "staging");

    const now = () => new Date();
    const personas = personaHashes(hmacKey, now());
    const reset = await resetPersonas({
      db: pool,
      logger,
      now,
      objectsLost,
      media: media.deps,
      personas,
    });
    console.log(JSON.stringify({ msg: "demo reset: personas forgotten", ...reset }));
    if (!bare) {
      const writer = viaServices({ db: pool, logger, now, hmacKey, media: media.deps });
      for (const given of await giveStories(writer, reset.spared)) {
        console.log(JSON.stringify({ msg: "demo reset: history", ...given }));
      }
    }
    await recount(pool, logger, now);
    sparedOrThrow(reset);
  } finally {
    await pool.end();
  }
}

try {
  if (env === "staging") await stagingReset();
  else await localReset();
} catch (error) {
  if (error instanceof DemoCommandError || error instanceof DemoError) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
