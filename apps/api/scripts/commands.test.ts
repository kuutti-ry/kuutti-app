import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEMO_SIZE_MAX, PHOTOS_MANIFEST } from "@kuutti/db/demo";
import { afterAll, describe, expect, it } from "vitest";

// The command lines' own refusals (#73, #141, #142, ADR-014, ADR-018), each in
// a process of its own as the maintainer runs them. Every case here stops
// before a database, an API, a parameter store or the network is asked
// anything: the environment is built from nothing (never this process's), a
// database address where one is needed points at a closed port, and nothing
// runs that would fetch, reset or populate. What the commands do after their
// checks is tested through the helpers under scripts/demo/.

const run = promisify(execFile);
const API_DIR = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "kuutti-commands-"));
// Nothing listens on port 1: were a check ever to let a command through, it would fail to connect, not write.
const NOWHERE = "postgres://nobody:nothing@127.0.0.1:1/never";
const LOCAL_BANK = "http://127.0.0.1:8080/ftn";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type Outcome = { code: number; stdout: string; stderr: string };

async function command(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Outcome> {
  return run(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
    cwd: API_DIR,
    // A home of its own: no cache of the user's is read.
    env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env },
    timeout: 30_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

const TIMEOUT = 60_000;

describe.concurrent("demo:assets refuses what it does not understand", () => {
  it.each([
    [["--tag", "v1", "--tag=v2"], "✖ --tag is given twice"],
    [["--tag"], "✖ --tag takes a release tag"],
    [["--check"], "✖ --check takes a directory"],
    [["--manifest"], "✖ --manifest takes a directory"],
    [["--force"], "✖ unknown argument --force: --tag, --check and --manifest are all there is"],
    [["--check", "a", "--manifest", "b"], "✖ --check and --manifest exclude each other"],
    // pnpm hands its separator through; it is dropped, and what follows is read.
    [["--", "--force"], "✖ unknown argument --force:"],
  ])(
    "%j: exit 2 and the reason, nothing fetched",
    async (args, reason) => {
      const { code, stdout, stderr } = await command("demo-assets.ts", args);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it(
    "--check names every listed picture that is missing and every picture that is not listed",
    async () => {
      const dir = join(scratch, "not-the-release");
      mkdirSync(join(dir, "faces", "pool"), { recursive: true });
      writeFileSync(join(dir, "faces", "pool", "stray.jpg"), "not a picture of the release");
      const { code, stdout, stderr } = await command("demo-assets.ts", ["--check", dir]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("✖ faces/pool/stray.jpg: unlisted");
      const first = PHOTOS_MANIFEST[0];
      if (first) expect(stderr).toContain(`✖ ${first.path}: missing`);
      expect(stderr).toContain(
        `✖ ${PHOTOS_MANIFEST.length + 1} of the pictures in ${dir} are not the release's; nothing of them is used`,
      );
    },
    TIMEOUT,
  );

  it(
    "--manifest of a directory with no pictures writes nothing",
    async () => {
      const manifestFile = resolve(API_DIR, "../../packages/db/src/seed/photos-manifest.ts");
      const before = readFileSync(manifestFile, "utf8");
      const dir = join(scratch, "empty");
      mkdirSync(dir, { recursive: true });
      const { code, stderr } = await command("demo-assets.ts", ["--manifest", dir]);
      expect(code).toBe(2);
      expect(stderr).toContain(
        `✖ no pictures under ${dir}: faces/<persona>/, faces/pool/, negatives/`,
      );
      expect(readFileSync(manifestFile, "utf8")).toBe(before);
    },
    TIMEOUT,
  );
});

describe.concurrent("demo:population", () => {
  it(
    "--dry-run counts per pond and connects to nothing: no database is even named",
    async () => {
      const { code, stdout } = await command("demo-population.ts", [
        "--dry-run",
        "--size",
        "40",
        "--seed=7",
      ]);
      expect(code).toBe(0);
      const plan = JSON.parse(stdout) as Record<string, unknown>;
      expect(plan).toMatchObject({
        msg: "demo population (dry run)",
        env: "development",
        size: 40,
        seed: 7,
      });
      expect(Object.keys(plan.ponds as object).length).toBeGreaterThan(0);
      expect(plan.notShown).toEqual(expect.any(Array));
    },
    TIMEOUT,
  );

  it.each([
    [["--size", "1", "--size=2"], {}, "✖ --size is given twice"],
    [["--size", "0"], {}, `✖ a population is 1 to ${DEMO_SIZE_MAX} people, not 0`],
    [["--seed", "seven"], {}, "✖ --seed takes a whole number, not seven"],
    [["--remove", "--dry-run"], {}, "✖ --remove and --dry-run exclude each other"],
    [["--photos", "--remove"], {}, "✖ --photos is for writing"],
    [["--dry-run=yes"], {}, "✖ --dry-run takes no value"],
    [["--wipe"], {}, "✖ unknown argument --wipe:"],
    [["--env", "production"], {}, '✖ refusing: --env is "production"'],
    // Both names must be allowed: a development flag does not talk production's APP_ENV away.
    [["--env", "development"], { APP_ENV: "production" }, '✖ refusing: APP_ENV is "production"'],
  ])(
    "%j with %j: exit 2 and the reason",
    async (args, env, reason) => {
      const { code, stdout, stderr } = await command("demo-population.ts", args, env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it.each([
    [["--env", "staging"], {}, '✖ refusing: APP_ENV is "unset", and the demo runs on staging only'],
    [[], { APP_ENV: "staging", DATABASE_URL: NOWHERE }, "✖ refusing: DATABASE_URL given"],
    [[], { APP_ENV: "staging", SSM_PARAMETER_PREFIX: "/kuutti/prod/" }, "SSM_PARAMETER_PREFIX"],
  ])(
    "staging outside its container (%j with %j) is refused before its parameters are read",
    async (args, env, reason) => {
      const { code, stdout, stderr } = await command("demo-population.ts", args, env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it(
    "a write without DATABASE_URL stops before any connection",
    async () => {
      const { code, stdout, stderr } = await command("demo-population.ts", []);
      expect(code).toBe(1);
      expect(stderr).toContain("✖ DATABASE_URL is not set");
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );
});

describe.concurrent("demo:reset", () => {
  it.each([
    [["--bare", "--bare"], {}, "✖ --bare is given twice"],
    [
      ["--api", "http://localhost:3000", "--api=http://127.0.0.1:3000"],
      {},
      "✖ --api is given twice",
    ],
    [["--api"], {}, "✖ --api takes the address of the API"],
    [["--env"], {}, "✖ --env takes the name of the environment"],
    [
      ["--hard"],
      {},
      "✖ unknown argument --hard: --bare, --api, --env and --objects-lost are all there is",
    ],
    [
      ["--env", "staging"],
      { APP_ENV: "development" },
      '✖ refusing: --env is "staging" and APP_ENV is "development"',
    ],
    [["--api", "nonsense"], {}, "✖ --api is no address: nonsense"],
    [
      ["--api", "http://192.0.2.10:3000"],
      {},
      "✖ refusing: the personas get their histories from a local API, not from 192.0.2.10:3000",
    ],
    [[], { NODE_USE_ENV_PROXY: "1" }, "✖ refusing: NODE_USE_ENV_PROXY is set"],
    [
      [],
      { APP_ENV: "preview" },
      '✖ refusing: APP_ENV is "preview", and the personas are reset in development and test only',
    ],
    [["--env=preview"], {}, '✖ refusing: APP_ENV is "preview"'],
  ])(
    "%j with %j: exit 2 and the reason",
    async (args, env, reason) => {
      const { code, stdout, stderr } = await command("demo-reset.ts", args, env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  it(
    "without a database in its configuration it stops before anything is asked",
    async () => {
      const { code, stdout, stderr } = await command("demo-reset.ts", ["--bare"]);
      expect(code).toBe(1);
      expect(stderr).toContain("ConfigError");
      expect(stderr).toContain("DATABASE_URL");
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );

  // A database is named (at a port where nothing listens); each check below stops the reset before it is reached.
  const local = { APP_ENV: "development", DATABASE_URL: NOWHERE, OIDC_ISSUER: LOCAL_BANK };
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

  it.each([
    [
      "no bank",
      { OIDC_ISSUER: "" },
      "✖ refusing: the bank of this configuration is not set, not the mock bank on this computer",
    ],
    [
      "Telia's bank",
      { OIDC_ISSUER: "https://tunnistus-pp.telia.fi/uas" },
      "✖ refusing: the bank of this configuration is tunnistus-pp.telia.fi, not the mock bank on this computer",
    ],
    [
      "an object store elsewhere",
      { S3_ENDPOINT: "http://192.0.2.10:9000", S3_FORCE_PATH_STYLE: "true" },
      "✖ refusing: the object store of this configuration is not the stand-in on this computer: it is at 192.0.2.10:9000",
    ],
    [
      "a local store addressed by host",
      { S3_ENDPOINT: "http://127.0.0.1:9000" },
      "✖ refusing: the object store of this configuration is not the stand-in on this computer: S3_FORCE_PATH_STYLE is not true",
    ],
    [
      "a CloudFront distribution",
      {
        MEDIA_URL_BASE: "https://api.staging.kuutti.app",
        CLOUDFRONT_KEY_PAIR_ID: "K2JCJMDEHXQW5F",
        CLOUDFRONT_SIGNING_KEY: signingKey,
      },
      "✖ refusing: the object store of this configuration is a deployed one",
    ],
  ] as const)(
    "a configuration with %s is refused before the database is asked",
    async (_, override, reason) => {
      const env: Record<string, string> = { ...local };
      for (const [key, value] of Object.entries(override)) {
        if (value === "") delete env[key];
        else env[key] = value;
      }
      const { code, stdout, stderr } = await command("demo-reset.ts", ["--bare"], env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
      expect(stderr).not.toContain("PRIVATE KEY");
    },
    TIMEOUT,
  );

  it.each([
    [
      ["--env", "staging", "--api", "http://localhost:4000"],
      {},
      "✖ refusing: --api is for the local environment; on staging there is no API to call",
    ],
    [["--env", "staging"], {}, '✖ refusing: APP_ENV is "unset", and the demo runs on staging only'],
    [
      [],
      { APP_ENV: "staging", HETU_HMAC_KEY: "1f".repeat(32) },
      "✖ refusing: HETU_HMAC_KEY given to the process",
    ],
  ])(
    "staging outside its container (%j with %j) is refused before its parameters are read",
    async (args, env, reason) => {
      const { code, stdout, stderr } = await command("demo-reset.ts", args, env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );
});

describe.concurrent("demo:stories", () => {
  it.each([
    [["--env", "staging"], {}, "✖ the stories take no argument"],
    [["--", "--bare"], {}, "✖ the stories take no argument"],
    // The separator alone is no argument: the next refusal is the environment's.
    [["--"], {}, '✖ refusing: APP_ENV is "unset", and the demo runs on staging only'],
    [[], { APP_ENV: "development" }, '✖ refusing: APP_ENV is "development"'],
    [
      [],
      { APP_ENV: "staging", HETU_HMAC_KEY: "1f".repeat(32) },
      "✖ refusing: HETU_HMAC_KEY given to the process",
    ],
    [
      [],
      { APP_ENV: "staging", DB_HOST: "127.0.0.1", DB_NAME: "never" },
      "✖ refusing: DB_HOST, DB_NAME given to the process",
    ],
  ])(
    "%j with %j: exit 2 before its parameters are read",
    async (args, env, reason) => {
      const { code, stdout, stderr } = await command("demo-stories.ts", args, env);
      expect(code).toBe(2);
      expect(stderr).toContain(reason);
      expect(stdout).toBe("");
    },
    TIMEOUT,
  );
});
