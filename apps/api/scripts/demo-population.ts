/**
 * Writes the synthetic population of #73 (ADR-014) into a local database or a
 * pull request's own, replacing the one that was there.
 *
 *   pnpm demo:population                      three hundred people, the usual seed
 *   pnpm demo:population -- --size 5000       as many as the round builder must carry
 *   pnpm demo:population -- --seed 7          other people, the same ponds
 *   pnpm demo:population -- --photos          with faces of the release, drawn by seed, through the pipeline (#142)
 *   pnpm demo:population -- --remove          removes them and writes nobody
 *   pnpm demo:population -- --dry-run         counts per pond, nothing written, no connection
 *
 * After a write or a removal the public counter of #54 is counted anew over
 * what is in the database now. By itself it would not move: it counts once a
 * day and moves in steps, which is right among people and would leave a demo
 * showing yesterday's ponds. What may be said of a pond is decided as ever.
 *
 * It goes ahead only in development, test and preview, and on staging from
 * inside the API's container (`node dist/demo-population.js --env staging`,
 * ADR-018: the database is read from the environment's own parameter store,
 * never given); it understands every argument or refuses, and asks the
 * server it is connected to what it is before it writes or removes anything:
 * production is refused whatever the environment is called
 * (packages/db/src/seed/command.ts).
 * The ponds come from the seed (`pnpm --filter @kuutti/db seed`), which runs
 * first. It lives with the API because the consents name the version of the
 * wording in force, which the API knows from the message catalogue.
 *
 * The pictures (#142) go through the upload pipeline like anybody's, so they
 * need the object store: locally the stand-in on this computer (asked, as the
 * reset asks), on staging the environment's own. Where no check decides
 * (locally) the faces are approved as a moderator would; on staging
 * Rekognition decides. A write replaces the population that was there and a
 * removal takes it away, and either leaves the pictures' objects without a
 * row, so both delete the orphans through the media slice afterwards, and
 * both refuse while there are pictures and no store to delete from.
 */
import { networkInterfaces } from "node:os";
import { createPool, MATCHING_CONFIG_V1 } from "@kuutti/db";
import {
  assertDemoTarget,
  assertStagingProcess,
  assetsFor,
  DEMO_LABEL_PREFIX,
  DEMO_SUBJECT_PREFIX,
  DemoCommandError,
  type DemoEnvironment,
  describeTarget,
  facesForPopulation,
  generatePopulation,
  type PhotoAsset,
  parseDemoCommand,
  plannedPonds,
  removePopulation,
  uncrossed,
  writePopulation,
} from "@kuutti/db/demo";
import { CURRENT_CONSENT_VERSIONS } from "../src/identity/index.ts";
import { countGates } from "../src/jobs/pond-gate.ts";
import { takeSnapshot } from "../src/jobs/waitlist-snapshot.ts";
import { type Config, loadConfig, parseConfig } from "../src/lib/config.ts";
import { createLogger } from "../src/lib/logger.ts";
import { createMediaDeps, deleteOrphanedObjects, type MediaDeps } from "../src/media/index.ts";
import { SPECIAL_CATEGORY_CONSENT_VERSION } from "../src/profile/index.ts";
import { DemoError, whyNotTheLocalStore } from "./demo/bank.ts";
import { loadAssets, uploadFaces } from "./demo/photos.ts";

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
const { env, size, seed, action, photos } = command;

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

/**
 * The configuration, where the command needs more than an address: on
 * staging the container's own, read as the API reads it (ADR-018); locally
 * this process's environment and nothing else, never a parameter store.
 */
async function configOf(target: DemoEnvironment): Promise<Config> {
  if (target === "staging") {
    assertStagingProcess(process.env);
    return loadConfig();
  }
  return parseConfig({ ...process.env, SSM_PARAMETER_PREFIX: undefined });
}

/** The object store the pictures go to and the orphans go from: the environment's own, or the stand-in on this computer. */
function storeOf(
  target: DemoEnvironment,
  config: Config,
): { media: MediaDeps; moderation: string } {
  const media = createMediaDeps(config);
  if (media.setup.mode === "off" || !media.deps) {
    throw new DemoError(
      `no object store is configured (${media.setup.mode === "off" ? media.setup.reason : "no deps"}): the pictures need one (S3_ENDPOINT and S3_BUCKET of the stand-in, env.example)`,
    );
  }
  if (target !== "staging") {
    if (media.setup.mode === "cloudfront") {
      throw new DemoError("the object store of this configuration is a deployed one");
    }
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
    if (why) throw new DemoError(`the object store is not the stand-in on this computer: ${why}`);
  }
  return { media: media.deps, moderation: media.setup.moderation };
}

/** The content keys of the population's pictures: what a write or a removal would leave without a row. */
async function populationPhotoKeys(db: ReturnType<typeof createPool>): Promise<string[]> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT DISTINCT p.key FROM photo p
       JOIN account a ON a.id = p.account_id JOIN identity i ON i.id = a.identity_id
     WHERE i.broker_subject LIKE $1`,
    [`${DEMO_SUBJECT_PREFIX}${DEMO_LABEL_PREFIX}%`],
  );
  return rows.map((r) => r.key);
}

/** The accounts of the people by label, for the pictures. */
async function accountsByLabel(
  db: ReturnType<typeof createPool>,
  labels: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ subject: string; id: string }>(
    `SELECT i.broker_subject AS subject, a.id FROM identity i JOIN account a ON a.identity_id = i.id
     WHERE i.broker_subject = ANY($1)`,
    [labels.map((label) => `${DEMO_SUBJECT_PREFIX}${label}`)],
  );
  return new Map(rows.map((r) => [r.subject.slice(DEMO_SUBJECT_PREFIX.length), r.id]));
}

let url: string;
let config: Config | undefined;
try {
  // The store is needed for the pictures, and for the orphans a replacement or a removal leaves.
  const needsConfig = env === "staging" || photos || action === "remove";
  config = needsConfig ? await configOf(env) : undefined;
  url = config?.databaseUrl ?? process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
} catch (error) {
  if (error instanceof DemoCommandError) fail(error.message, 2);
  throw error;
}
const pool = createPool({ connectionString: url, max: 1, applicationName: "kuutti-demo" });
const logger = await createLogger({ level: "silent", pretty: false });
try {
  const target = await describeTarget(pool);
  // Where the rows go, before any goes: never the password, which is not asked for.
  console.log(JSON.stringify({ msg: "demo population: target", env, ...target }));
  assertDemoTarget(target, env);

  // The pictures of the population that is there go with it, rows now and
  // objects after: a store is needed for them, and asked for before anything.
  const keysBefore = await populationPhotoKeys(pool);
  const assets = photos ? loadAssets() : null;
  if (photos && !assets) {
    throw new DemoError(
      "no pictures yet: the manifest is empty until the release exists (docs/demo/photo-prompts.md)",
    );
  }
  const store =
    assets || keysBefore.length > 0 ? storeOf(env, config ?? (await configOf(env))) : null;

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
    if (assets && store) {
      const faces = facesForPopulation(people, assetsFor(assets.manifest, "pool"), seed);
      const accounts = await accountsByLabel(pool, [...faces.keys()]);
      const byAccount = new Map<string, readonly PhotoAsset[]>();
      for (const [label, own] of faces) {
        const accountId = accounts.get(label);
        if (accountId) byAccount.set(accountId, own);
      }
      const uploaded = await uploadFaces(
        { ...store.media, db: pool, logger, now: () => new Date() },
        assets,
        byAccount,
        // Where no check decides, the faces are approved as a moderator would; where one does, it decides.
        { approve: store.moderation === "queue" },
      );
      console.log(JSON.stringify({ msg: "demo population: pictures", env, ...uploaded }));
    }
  }
  if (store && keysBefore.length > 0) {
    const objects = await deleteOrphanedObjects(
      { db: pool, store: store.media.store, logger },
      keysBefore,
      { accountId: "demo-population" },
    );
    console.log(JSON.stringify({ msg: "demo population: orphaned objects deleted", objects }));
  }
  // The figures the counter stood on are of the ponds as they were: gone, and
  // counted anew. Only here, where the target has been asked what it is.
  await pool.query("DELETE FROM waitlist_snapshot");
  const counted = await takeSnapshot({ db: pool, logger, now: () => new Date() });
  console.log(JSON.stringify({ msg: "demo population: counter recounted", ...counted }));
  // And the gates (#94): who is let into each pond, and for whom matching is open.
  const gates = await countGates({ db: pool, logger, now: () => new Date() });
  console.log(JSON.stringify({ msg: "demo population: gates counted", ...gates }));
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
