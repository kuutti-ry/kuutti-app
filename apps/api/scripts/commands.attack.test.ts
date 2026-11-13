import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPool, migrate, withTemporaryDatabase } from "@kuutti/db";
import { DEMO_SUBJECT_PREFIX, demoHetuHmac, PLACEHOLDER_PHOTO_PREFIX } from "@kuutti/db/demo";
import { describe, expect } from "vitest";
import { attack } from "../src/test/attack.ts";
import { MIGRATIONS } from "../src/test/global-setup.ts";
import { TEST_DATABASE_URL } from "../src/test/harness.ts";
import { command, type Outcome, scratch } from "./run-command.ts";

// Attacks on the demo command lines (#380; #73, #141, #142, ADR-014, ADR-018),
// each in a process of its own as the maintainer runs them. Nothing here can
// do harm when it succeeds: the database of a run that gets past its checks is
// a port where nothing listens, a release is fetched through a proxy that is
// not there, and a home of its own takes whatever is written.

/** Nothing listens on port 1 of this computer. */
const CLOSED = "postgres://127.0.0.1:1/never";
const DEAD_PROXY = "http://127.0.0.1:1";
/** A local reset's environment, up to the database: every check before it passes. */
const BANK = { DATABASE_URL: CLOSED, OIDC_ISSUER: "http://127.0.0.1:8080/ftn" };
const LOCAL = { APP_ENV: "development", ...BANK };
/** Node told to send fetch through a proxy, and the proxy a closed port: nothing leaves this computer. */
const NO_NETWORK = {
  NODE_OPTIONS: "--use-env-proxy",
  HTTPS_PROXY: DEAD_PROXY,
  HTTP_PROXY: DEAD_PROXY,
};
const MARK = "kuutti380mark";
/**
 * Node takes --use-env-proxy from NODE_OPTIONS since 22.21. An older one stops at the flag before
 * the script, so the runs that are kept off the network by it are left out there.
 */
const proxied = process.allowedNodeEnvironmentFlags.has("--use-env-proxy");

const reset = (args: readonly string[], env: Record<string, string> = LOCAL) =>
  command("demo-reset.ts", args, env);
/** Past every check of the local reset: the database was asked, at the closed port. */
const askedTheDatabase = (seen: Outcome) => expect(seen.stderr).toContain("ECONNREFUSED");
const printed = (seen: Outcome) => expect(`${seen.stdout}${seen.stderr}`).toContain(MARK);

describe("demo:reset, made to go ahead", { concurrent: true, timeout: 60_000 }, () => {
  attack("demo:reset: an API that is not on this computer, named in one word with =, is taken", {
    attempt: () => reset(["--bare", "--api=http://192.0.2.10:3000"]),
    control: () => reset(["--bare", "--api=http://127.0.0.1:3000"]),
    succeeds: askedTheDatabase,
  });

  for (const [how, run] of [
    ["by --env, in one word", (env: string) => reset(["--bare", `--env=${env}`], BANK)],
    ["by APP_ENV alone", (env: string) => reset(["--bare"], { ...BANK, APP_ENV: env })],
  ] as const) {
    attack(`demo:reset: production, named ${how}, has its personas reset`, {
      attempt: () => run("production"),
      control: () => run("test"),
      succeeds: askedTheDatabase,
    });
  }

  if (proxied)
    attack(
      "demo:reset: told through NODE_OPTIONS to send everything through a proxy, it goes ahead",
      {
        attempt: async () => {
          const seen = await reset(["--bare"], {
            ...LOCAL,
            HTTP_PROXY: DEAD_PROXY,
            NODE_OPTIONS: "--use-env-proxy",
          });
          // A Node that does not know the flag stops before the script: that is no refusal of the reset's.
          expect(seen.stderr).not.toMatch(/bad option|not allowed in NODE_OPTIONS/);
          return seen;
        },
        // A proxy that is named and that Node was not told to use: nothing goes through it.
        control: () => reset(["--bare"], { ...LOCAL, HTTP_PROXY: DEAD_PROXY }),
        succeeds: askedTheDatabase,
        // Goes through today: the reset refuses NODE_USE_ENV_PROXY and does not ask NODE_OPTIONS.
        open: "#380",
      },
    );

  // Each row is a word the reset does not know; its control is the word it stands for.
  for (const [how, attempt, control] of [
    ["--bare without its dashes", ["bare"], ["--bare"]],
    ["--bare with a value", ["--bare=yes"], ["--bare"]],
    [
      "--objects-lost with an underscore",
      ["--bare", "--objects_lost"],
      ["--bare", "--objects-lost"],
    ],
    ["a dry run, which it has not", ["--bare", "--dry-run"], ["--bare"]],
  ] as const) {
    attack(`demo:reset: ${how} is passed over, and the reset goes ahead`, {
      attempt: () => reset(attempt),
      control: () => reset(control),
      succeeds: askedTheDatabase,
    });
  }
});

describe("demo:stories and demo:assets, made to go ahead", {
  concurrent: true,
  timeout: 60_000,
}, () => {
  attack("demo:stories: an empty word is no argument, and the job goes on", {
    attempt: () => command("demo-stories.ts", [""]),
    control: () => command("demo-stories.ts", []),
    // The check after the arguments' own: where the process runs.
    succeeds: (seen) => expect(seen.stderr).toContain('refusing: APP_ENV is "unset"'),
  });

  /** One fetch of a release into the run's own home, through the proxy that is not there. */
  const fetched = async (tag: string) => {
    const seen = await command("demo-assets.ts", ["--tag", tag], NO_NETWORK);
    expect(seen.stderr).toContain(`fetching ${tag} of`);
    return { made: existsSync(join(scratch, ".cache", "kuutti-demo-photos", tag)) };
  };
  if (proxied)
    attack("demo:assets: a tag that leads out of the cache has its directory made where it leads", {
      attempt: () => fetched("../../outside-the-cache"),
      control: () => fetched("v0-attack"),
      succeeds: (seen) => expect(seen.made).toBe(true),
      // Goes through today: the tag is the maintainer's own word, and no line says it is checked.
      open: "#380, a question",
    });

  // The control is the command with no word at all, which is the fetch.
  for (const [how, flag] of [
    ["a long dash a pasted line carries", "—check"],
    ["capitals", "--CHECK"],
  ] as const) {
    if (proxied)
      attack(`demo:assets: a check of a directory asked for with ${how} fetches the release`, {
        attempt: () =>
          command("demo-assets.ts", [flag, join(scratch, "no-such-release")], NO_NETWORK),
        control: () => command("demo-assets.ts", [], NO_NETWORK),
        succeeds: (seen) => expect(seen.stderr).toContain("fetching"),
      });
  }
});

describe("demo:population, asked to remove", { timeout: 60_000 }, () => {
  /**
   * One synthetic person with a picture, in a migrated database of its own, and the population
   * removed with no object store configured: whether the person went.
   */
  const removed = (picture: string) =>
    withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        const identity = await pool.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac, broker_subject) VALUES ($1, $2) RETURNING id",
          [demoHetuHmac("demo-0001"), `${DEMO_SUBJECT_PREFIX}demo-0001`],
        );
        const account = await pool.query<{ id: string }>(
          `INSERT INTO account (identity_id, state, birth_year, birth_month)
           VALUES ($1, 'active', 1990, 6) RETURNING id`,
          [identity.rows[0]?.id],
        );
        await pool.query(
          `INSERT INTO photo (account_id, key, blurhash, width, height, position)
           VALUES ($1, $2, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 1200, 1600, 0)`,
          [account.rows[0]?.id, picture],
        );
        await command("demo-population.ts", ["--remove"], { DATABASE_URL: url });
        const left = await pool.query("SELECT 1 FROM identity WHERE id = $1", [
          identity.rows[0]?.id,
        ]);
        return { removed: left.rowCount === 0 };
      } finally {
        await pool.end();
      }
    });

  attack(
    "demo:population: people are removed where no object store takes their pictures, whose objects then stay with no row to find them by",
    {
      attempt: () => removed("e".repeat(64)),
      // A picture with no object behind it leaves nothing, and its removal needs no store.
      control: () => removed(`${PLACEHOLDER_PHOTO_PREFIX}1`),
      succeeds: (seen) => expect(seen.removed).toBe(true),
    },
  );
});

describe("what the demo commands print", { concurrent: true, timeout: 60_000 }, () => {
  /** The local server's address with the mark as its password, or in the name of a database it has not. */
  const address = (where: "password" | "database"): string => {
    const url = new URL(TEST_DATABASE_URL);
    if (where === "password") url.password = MARK;
    url.pathname = where === "database" ? `/kuutti_no_such_${MARK}` : "/kuutti_no_such_database";
    return url.toString();
  };

  attack("demo:reset: a failed connection prints the password of the database's address", {
    attempt: () => reset(["--bare"], { ...LOCAL, DATABASE_URL: address("password") }),
    // A failed connection names the database it asked for, which is no secret.
    control: () => reset(["--bare"], { ...LOCAL, DATABASE_URL: address("database") }),
    succeeds: printed,
  });

  attack("demo:reset: a key that is no key is printed with the refusal of it", {
    attempt: () => reset(["--bare"], { ...LOCAL, HETU_HMAC_KEY: MARK }),
    // The environment's name is no secret, and its refusal says it.
    control: () => reset(["--bare"], { ...LOCAL, APP_ENV: MARK }),
    succeeds: printed,
  });

  // On staging what was given by hand is refused by its name; a refusal past it would read the
  // parameter store, so that is pointed at the closed port too.
  const STAGING = {
    APP_ENV: "staging",
    AWS_ENDPOINT_URL: DEAD_PROXY,
    AWS_EC2_METADATA_DISABLED: "true",
  };
  for (const [script, given] of [
    ["demo-stories.ts", { HETU_HMAC_KEY: MARK }],
    ["demo-reset.ts", { DATABASE_URL: address("password") }],
    ["demo-population.ts", { DB_APP_PASSWORD: MARK }],
  ] as const) {
    attack(`${script}: what was given by hand on staging is printed with the refusal of it`, {
      attempt: () => command(script, [], { ...STAGING, ...given }),
      control: () => command(script, [], { ...STAGING, APP_ENV: MARK }),
      succeeds: printed,
    });
  }
});
