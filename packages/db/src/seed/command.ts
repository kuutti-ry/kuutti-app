import type { Queryable } from "../pool.ts";
import { DEMO_SEED, DEMO_SIZE, DEMO_SIZE_MAX } from "./population.ts";

/**
 * What `pnpm demo:population` may do and where (#73, ADR-014 §10). Three
 * hundred accounts that look bank-verified, in a database real people use,
 * would enter the public counter, count toward the gate and appear on
 * people's cards. So the command is stricter than the seed:
 *
 * - it goes ahead only in an environment that is named and allowed, never in
 *   one that merely is not called "production";
 * - it understands every argument or refuses: a mistyped `--dryrun` must not
 *   become a write;
 * - and it does not believe the name. Where the rows go is decided by
 *   `DATABASE_URL` alone, and a deployed database is reached through a tunnel
 *   on 127.0.0.1 under the same database name as the local one (the
 *   moderator's command line of infra/README.md is used that way). So after
 *   connecting it asks the server what it is, and refuses a managed one
 *   unless it is a pull request's own preview database.
 */

export const DEMO_ENVIRONMENTS = ["development", "test", "preview", "staging"] as const;
export type DemoEnvironment = (typeof DEMO_ENVIRONMENTS)[number];

export class DemoCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoCommandError";
  }
}

export type DemoCommand = {
  env: DemoEnvironment;
  size: number;
  seed: number;
  action: "write" | "remove" | "dry-run";
};

const allowed = (env: string): env is DemoEnvironment =>
  (DEMO_ENVIRONMENTS as readonly string[]).includes(env);

function wholeNumber(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) {
    throw new DemoCommandError(`${flag} takes a whole number, not ${raw ?? "nothing"}`);
  }
  return Number(raw);
}

/** The arguments as given after the script's name, and `APP_ENV` as the process has it. */
export function parseDemoCommand(argv: readonly string[], appEnv: string | undefined): DemoCommand {
  // pnpm hands the separator through.
  const args = argv.filter((arg, i) => !(arg === "--" && i === 0));
  let env: string | undefined;
  let size = DEMO_SIZE;
  let seed = DEMO_SEED;
  const actions = new Set<"remove" | "dry-run">();

  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    // Twice is refused, not the last one taken: `--env production --env
    // development` must not talk its own first word away.
    if (seen.has(flag)) throw new DemoCommandError(`${flag} is given twice`);
    seen.add(flag);
    const value = () => {
      if (equals > 0) return arg.slice(equals + 1);
      i += 1;
      return args[i];
    };
    switch (flag) {
      case "--env":
        env = value() ?? "";
        break;
      case "--size":
        size = wholeNumber(flag, value());
        break;
      case "--seed":
        seed = wholeNumber(flag, value());
        break;
      case "--remove":
      case "--dry-run":
        if (equals > 0) throw new DemoCommandError(`${flag} takes no value`);
        actions.add(flag === "--remove" ? "remove" : "dry-run");
        break;
      default:
        throw new DemoCommandError(
          `unknown argument ${arg}: --env, --size, --seed, --dry-run and --remove are all there is`,
        );
    }
  }

  // Both names must be allowed when both are given: the stricter one wins.
  for (const [name, given] of [
    ["--env", env],
    ["APP_ENV", appEnv],
  ] as const) {
    if (given !== undefined && !allowed(given)) {
      throw new DemoCommandError(
        `refusing: ${name} is "${given}", and synthetic people are written into ${DEMO_ENVIRONMENTS.join(", ")} only (TD-19)`,
      );
    }
  }
  if (size < 1 || size > DEMO_SIZE_MAX) {
    throw new DemoCommandError(`a population is 1 to ${DEMO_SIZE_MAX} people, not ${size}`);
  }
  if (actions.size > 1) throw new DemoCommandError("--remove and --dry-run exclude each other");

  return {
    env: (env ?? appEnv ?? "development") as DemoEnvironment,
    size,
    seed,
    action: actions.has("remove") ? "remove" : actions.has("dry-run") ? "dry-run" : "write",
  };
}

export type DemoTarget = {
  database: string;
  user: string;
  /** Null over a Unix socket. */
  host: string | null;
  port: number | null;
  /** Whether the server is a managed one (RDS): it has the role only RDS has. */
  managed: boolean;
};

/** What the server says it is. Asked of the connection the rows would go through. */
export async function describeTarget(db: Queryable): Promise<DemoTarget> {
  const { rows } = await db.query<{
    database: string;
    user: string;
    host: string | null;
    port: number | null;
    managed: boolean;
  }>(
    `SELECT current_database() AS database, current_user AS "user",
            host(inet_server_addr()) AS host, inet_server_port() AS port,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rdsadmin') AS managed`,
  );
  const row = rows[0];
  if (!row) throw new DemoCommandError("the server did not say what it is");
  return row;
}

const PREVIEW_DATABASE = /^kuutti_pr_\d+$/;

/**
 * Refuses a managed server unless it is a pull request's own database, asked
 * for as a preview, or staging's, asked for as staging. Staging and
 * production are both managed and both called `kuutti`, and no question to
 * the server tells them apart: what does is where the command runs
 * (`assertStagingProcess`, ADR-018), inside staging's own container with
 * staging's own parameters.
 */
export function assertDemoTarget(target: DemoTarget, env: DemoEnvironment): void {
  if (env === "staging") {
    if (target.managed) return;
    throw new DemoCommandError(
      `refusing: --env staging names a managed server (RDS), and "${target.database}" is not on one`,
    );
  }
  if (!target.managed) return;
  if (env === "preview" && PREVIEW_DATABASE.test(target.database)) return;
  throw new DemoCommandError(
    `refusing: database "${target.database}" is on a managed server (RDS). Synthetic people go into a local database, a pull request's own (kuutti_pr_<n>, with --env preview) or staging from inside its container (--env staging, ADR-018), never into production`,
  );
}

/**
 * What a demo command on staging may not be given (ADR-018): the database
 * and the key come from staging's own parameter store, read as the API reads
 * them, through the instance role, inside the container. A value given to
 * the process would be a tunnel to somewhere, or a key from somewhere, and
 * is refused before anything is read. The guard is against accidents (a
 * tunnel, a pasted key, the wrong window), not against a holder of the
 * maintainer's own cloud session, who can read the parameters anyway.
 */
export const NEVER_GIVEN_ON_STAGING = [
  "DATABASE_URL",
  "DB_HOST",
  "DB_NAME",
  "DB_USER",
  "DB_APP_PASSWORD",
  "HETU_HMAC_KEY",
  "SSM_PARAMETER_PREFIX",
] as const;

/** The process is staging's container and nothing else: the name says so, and nothing was given by hand. */
export function assertStagingProcess(env: Readonly<Record<string, string | undefined>>): void {
  if (env.APP_ENV !== "staging") {
    throw new DemoCommandError(
      `refusing: APP_ENV is "${env.APP_ENV ?? "unset"}", and the demo runs on staging only, from inside its container (ADR-018)`,
    );
  }
  const given = NEVER_GIVEN_ON_STAGING.filter((key) => env[key] !== undefined);
  if (given.length > 0) {
    throw new DemoCommandError(
      `refusing: ${given.join(", ")} given to the process. On staging the database and the key come from the environment's own parameter store, which the container reads through its role; nothing of them is given by hand (ADR-018)`,
    );
  }
}
