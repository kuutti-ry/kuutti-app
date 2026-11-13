import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect } from "vitest";
import { MIGRATE_LOCK_KEY, migrate } from "../migrate.ts";
import { createPool, type Pool } from "../pool.ts";
import { attack } from "../test/attack.ts";
import { TEST_DATABASE_URL, withTemporaryDatabase } from "../test/temporary-database.ts";
import { run } from "./run-in-process.ts";

// Attacks on the package's command lines (#380): the seed, the staff roles and
// migrate made to go ahead where they must refuse. Nothing here can do harm
// when it succeeds: a command that gets past its guard meets a port where
// nothing listens, and what must really write does so in a temporary database.

/** Nothing listens on port 1 of this computer: a command that gets this far fails to connect. */
const CLOSED = "postgres://127.0.0.1:1/never";

/** One run against the closed port: whether it got as far as trying to connect. */
async function reach(
  command: Parameters<typeof run>[0],
  args: string[],
  appEnv?: string,
): Promise<{ connected: boolean }> {
  const said = await run(command, args, { DATABASE_URL: CLOSED, APP_ENV: appEnv }).then(
    (result) => result.err.join("\n"),
    // The staff roles' command has no catch of its own: its failure is the import's.
    (error: unknown) => String(error),
  );
  return { connected: /ECONNREFUSED|Failed query/.test(said) };
}
const connected = (seen: { connected: boolean }) => expect(seen.connected).toBe(true);

// What goes through today (#380): a hole, which its contract forbids, and a
// question, where no line says what should happen.
const HOLE = "#380";
const QUESTION = "#380, a question";

describe("the seed, where production is named (#250)", () => {
  // Each row names production in one spelling; its control names a preview the same way.
  // The seed reads --env only as a word of its own, and only the first one.
  for (const [how, spelt, open] of [
    ["in one word, --env=production", (env: string) => [`--env=${env}`], HOLE],
    [
      "second, after another environment",
      (env: string) => ["--env", "development", "--env", env],
      HOLE,
    ],
    ["after the separator pnpm hands through", (env: string) => ["--", "--env", env], undefined],
  ] as const) {
    attack(`seed: production named ${how}, is seeded`, {
      attempt: () => reach("seed", spelt("production")),
      control: () => reach("seed", spelt("preview")),
      succeeds: connected,
      open,
    });
  }
});

describe("the staff roles, where the process runs in production", () => {
  // The control is the same command line where APP_ENV is development.
  // The flag's value stands in for APP_ENV before the refusal asks, so any --env but production's passes.
  for (const [how, args, open] of [
    ["--env names another environment", ["list", "--env", "development"], HOLE],
    ["--env is given empty", ["list", "--env", ""], HOLE],
    ["--env is given last, with nothing after it", ["list", "--env"], undefined],
  ] as const) {
    attack(`moderator: production is entered without --env production when ${how}`, {
      attempt: () => reach("moderator", [...args], "production"),
      control: () => reach("moderator", [...args], "development"),
      succeeds: connected,
      open,
    });
  }
});

describe("a dry run asked of a command that has none", () => {
  const hmac = "a".repeat(64);
  for (const [command, args] of [
    ["seed", ["--env", "development"]],
    ["migrate", []],
    ["moderator", ["revoke", hmac]],
  ] as const) {
    // None of the three has a dry run or promises to refuse a word it does not know.
    attack(`${command}: with --dry-run it goes ahead all the same`, {
      attempt: () => reach(command, [...args, "--dry-run"]),
      control: () => reach(command, [...args]),
      succeeds: connected,
      open: QUESTION,
    });
  }
});

const MIGRATIONS = resolve(import.meta.dirname, "..", "..", "drizzle");

/** A database of its own for one run, dropped afterwards; `folder` is what it is migrated from, if anything. */
const database = <T>(fn: (pool: Pool, url: string) => Promise<T>, folder?: string) =>
  withTemporaryDatabase(async (url) => {
    const pool = createPool({ connectionString: url, max: 2 });
    try {
      if (folder) await migrate(pool, folder);
      return await fn(pool, url);
    } finally {
      await pool.end();
    }
  });

describe("the staff roles, revoked", () => {
  // Two hashes that differ in their last digit alone.
  const hmac = (n: number) => n.toString(16).padStart(64, "a");

  /** Two members of staff, each with a role and a live session; one is revoked. What is left of the second. */
  const revoked = (whose: number) =>
    database(async (pool, url) => {
      for (const n of [1, 2]) {
        const { rows } = await pool.query<{ id: string }>(
          "INSERT INTO identity (hetu_hmac) VALUES ($1) RETURNING id",
          [hmac(n)],
        );
        await pool.query(
          "INSERT INTO moderator_roles (identity_id, role, granted_by) VALUES ($1, 'moderator', 'test')",
          [rows[0]?.id],
        );
        await pool.query(
          `INSERT INTO admin_session (identity_id, role, access_hash, expires_at)
           VALUES ($1, 'moderator', $2, '2099-01-01T00:00:00Z')`,
          [rows[0]?.id, `session ${n}`],
        );
      }
      const result = await run("moderator", ["revoke", hmac(whose)], { DATABASE_URL: url });
      expect(result).toEqual({ code: 0, out: ["revoked"], err: [] });
      const { rows } = await pool.query<{ role: boolean; session: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM moderator_roles m WHERE m.identity_id = i.id) AS role,
                EXISTS (SELECT 1 FROM admin_session s
                        WHERE s.identity_id = i.id AND s.revoked_at IS NULL) AS session
         FROM identity i WHERE i.hetu_hmac = $1`,
        [hmac(2)],
      );
      return { secondIsStaff: rows[0]?.role === true && rows[0]?.session === true };
    }, MIGRATIONS);

  attack("moderator: revoking one person's role takes another's role or session with it", {
    attempt: () => revoked(1),
    control: () => revoked(2),
    succeeds: (seen) => expect(seen.secondIsStaff).toBe(false),
  });
});

describe("migrate, when a migration fails midway", () => {
  /** A folder of two migrations as drizzle-kit writes one; the second is the one under test. */
  function twoSteps(second: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kuutti-migrations-"));
    mkdirSync(join(dir, "meta"));
    const entries = ["0000_first", "0001_second"].map((tag, idx) => ({
      idx,
      version: "7",
      when: 1_700_000_000_000 + idx,
      tag,
      breakpoints: true,
    }));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
    writeFileSync(join(dir, "0000_first.sql"), "CREATE TABLE first_step (id integer);");
    writeFileSync(join(dir, "0001_second.sql"), second);
    return dir;
  }
  const FAILS = "SELECT 1 / 0;";

  /** Whether another session finds the migrations' lock taken. */
  async function lockHeld(url: string): Promise<boolean> {
    const witness = createPool({ connectionString: url, max: 1 });
    try {
      const { rows } = await witness.query<{ got: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS got",
        [MIGRATE_LOCK_KEY],
      );
      return rows[0]?.got !== true;
    } finally {
      await witness.end();
    }
  }

  const firstStepStands = (second: string, fails: boolean) =>
    database(async (pool) => {
      const dir = twoSteps(second);
      try {
        const done = migrate(pool, dir);
        if (fails) await expect(done).rejects.toThrow();
        else expect(await done).toEqual({ state: "applied", applied: 2 });
        const { rows } = await pool.query<{ stands: boolean }>(
          "SELECT to_regclass('public.first_step') IS NOT NULL AS stands",
        );
        return { stands: rows[0]?.stands === true };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

  attack(
    "migrate: the migration before the one that failed stays applied, with no line in the journal",
    {
      attempt: () => firstStepStands(FAILS, true),
      control: () => firstStepStands("CREATE TABLE second_step (id integer);", false),
      succeeds: (seen) => expect(seen.stands).toBe(true),
    },
  );

  attack("migrate: a run that failed keeps the lock, and the next start waits for it", {
    attempt: () =>
      database(async (pool, url) => {
        const dir = twoSteps(FAILS);
        try {
          await expect(migrate(pool, dir)).rejects.toThrow();
          return { held: await lockHeld(url) };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
    // Planted: a session that took the lock as migrate does, and has not let it go.
    control: () =>
      database(async (pool, url) => {
        const client = await pool.connect();
        try {
          await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
          return { held: await lockHeld(url) };
        } finally {
          client.release(true);
        }
      }),
    succeeds: (seen) => expect(seen.held).toBe(true),
  });
});

describe("what a failure prints", () => {
  const spawned = promisify(execFile);
  const MARK = "kuutti380mark";
  /** The local server's address with the mark as its password, or in the name of a database it has not. */
  const address = (where: "password" | "database"): string => {
    const url = new URL(TEST_DATABASE_URL);
    if (where === "password") url.password = MARK;
    url.pathname = where === "database" ? `/kuutti_no_such_${MARK}` : "/kuutti_no_such_database";
    return url.toString();
  };
  /** The command as a process of its own, as the maintainer runs it: everything it printed. */
  const printed = (script: string, args: readonly string[], databaseUrl: string) =>
    spawned(process.execPath, ["--import", "tsx", `src/cli/${script}.ts`, ...args], {
      cwd: resolve(import.meta.dirname, "..", ".."),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
    }).then(
      ({ stdout, stderr }) => `${stdout}${stderr}`,
      (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );

  // A failed connection names the database it asked for, which is no secret: the control.
  for (const [script, args] of [
    ["seed", ["--env", "development"]],
    ["migrate", []],
    ["moderator", ["list"]],
  ] as const) {
    attack(`${script}: a failed connection prints the password of the address`, {
      attempt: () => printed(script, args, address("password")),
      control: () => printed(script, args, address("database")),
      succeeds: (seen) => expect(seen).toContain(MARK),
    });
  }
});
