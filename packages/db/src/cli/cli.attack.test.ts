import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MIGRATE_LOCK_KEY, migrate } from "../migrate.ts";
import { createPool, type Pool } from "../pool.ts";
import { attack } from "../test/attack.ts";
import { TEST_DATABASE_URL, withTemporaryDatabase } from "../test/temporary-database.ts";
import * as commandRunner from "./run-in-process.ts";

// Attacks on the package's command lines (#380): the seed, the staff roles and
// migrate made to go ahead where they must refuse. Nothing here can do harm
// when it succeeds: a command that gets past its guard meets a port where
// nothing listens, and what must really write does so in a temporary database.

/** Nothing listens on port 1 of this computer: a command that gets this far fails to connect. */
const CLOSED = "postgres://127.0.0.1:1/never";

/** Only a connection to the deliberately closed port proves the command got past its guards. */
function refusedConnection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error &&
      error.code === "ECONNREFUSED" &&
      "address" in error &&
      error.address === "127.0.0.1" &&
      "port" in error &&
      error.port === 1) ||
    refusedConnection(error.cause)
  );
}

/** One run against the closed port: whether it got as far as trying to connect. */
async function reach(
  command: Parameters<typeof commandRunner.run>[0],
  args: string[],
  appEnv?: string,
  expectedRefusal?: string | readonly string[],
): Promise<{ connected: boolean }> {
  let result: Awaited<ReturnType<typeof commandRunner.run>>;
  try {
    result = await commandRunner.run(command, args, { DATABASE_URL: CLOSED, APP_ENV: appEnv });
  } catch (error) {
    // The staff roles' command leaves its connection failure to the import's caller.
    if (!refusedConnection(error)) throw error;
    return { connected: true };
  }
  for (const error of result.err) {
    if (error instanceof Error && !refusedConnection(error)) throw error;
  }
  if (result.err.some(refusedConnection)) {
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    return { connected: true };
  }
  // A missing import, an unrelated refusal or a command that stopped silently is
  // a broken attempt, never evidence that the production guard held.
  if (command === "migrate" && expectedRefusal === undefined)
    throw new Error("migrate stopped before asking its database");
  const refusal =
    expectedRefusal ??
    (command === "seed"
      ? "refusing to seed production: previews and local databases only (TD-19)"
      : "refusing production without --env production");
  const allowed = typeof refusal === "string" ? [refusal] : refusal;
  expect(result).toMatchObject({ code: 2, out: [] });
  expect(result.err).toHaveLength(1);
  expect(allowed).toContain(result.err[0]);
  return { connected: false };
}
const connected = (seen: { connected: boolean }) => expect(seen.connected).toBe(true);

describe("the command attack's driver", () => {
  it.each([new TypeError("broken command"), new Error("Cannot find module seed.ts")])(
    "rethrows an unexpected command failure: %s",
    async (error) => {
      const spy = vi.spyOn(commandRunner, "run").mockRejectedValueOnce(error);
      try {
        await expect(reach("seed", ["--env", "production"])).rejects.toBe(error);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([new TypeError("broken seed"), new Error("Failed query: no connection was attempted")])(
    "rethrows an error caught and logged by the command: %s",
    async (error) => {
      const spy = vi
        .spyOn(commandRunner, "run")
        .mockResolvedValueOnce({ code: 1, out: [], err: [error] });
      try {
        await expect(reach("seed", ["--env", "production"])).rejects.toBe(error);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("does not take another refusal for the production guard", async () => {
    const spy = vi.spyOn(commandRunner, "run").mockResolvedValueOnce({
      code: 2,
      out: [],
      err: ["DATABASE_URL is not set"],
    });
    try {
      await expect(reach("seed", ["--env", "production"])).rejects.toMatchObject({
        name: "AssertionError",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the seed, where production is named (#250)", () => {
  // A production target is refused even among duplicate flags; the control uses one preview.
  for (const [how, args, refusal] of [
    ["in one word, --env=production", ["--env=production"], undefined],
    [
      "second, after another environment",
      ["--env", "development", "--env", "production"],
      undefined,
    ],
    ["after the separator pnpm hands through", ["--", "--env", "production"], undefined],
  ] as const) {
    attack(`seed: production named ${how}, is seeded`, {
      attempt: () => reach("seed", [...args], undefined, refusal),
      control: () => reach("seed", ["--env=preview"]),
      succeeds: connected,
    });
  }
});

describe("the staff roles, where the process runs in production", () => {
  // Only an explicit production flag is a control for a process in production.
  for (const [how, args, refusal] of [
    ["--env names another environment", ["list", "--env", "development"], undefined],
    ["--env is given empty", ["list", "--env", ""], "--env takes a value"],
    [
      "--env is given last, with nothing after it",
      ["list", "--env"],
      ["--env takes a value", "refusing production without --env production"],
    ],
  ] as const) {
    attack(`moderator: production is entered without --env production when ${how}`, {
      attempt: () => reach("moderator", [...args], "production", refusal),
      control: () => reach("moderator", ["list", "--env", "production"], "production"),
      succeeds: connected,
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
    // None has a dry run: asking for one must never become a real write.
    attack(`${command}: with --dry-run it goes ahead all the same`, {
      attempt: () =>
        reach(command, [...args, "--dry-run"], undefined, "unknown argument --dry-run"),
      control: () => reach(command, [...args]),
      succeeds: connected,
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
      const result = await commandRunner.run("moderator", ["revoke", hmac(whose)], {
        DATABASE_URL: url,
      });
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
      () => {
        throw new Error("the nonexistent database unexpectedly accepted the command");
      },
      (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== 1 ||
          ("killed" in error && error.killed) ||
          ("signal" in error && error.signal != null) ||
          !("stderr" in error) ||
          typeof error.stderr !== "string"
        ) {
          throw error;
        }
        // A loader failure or a runtime exception that prints no password is
        // not a successful redaction. The fixture must have reached Postgres.
        expect(error.stderr).toMatch(
          /database "kuutti_no_such_[^"]+" does not exist|password authentication failed for user/,
        );
        const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
        return `${stdout}${error.stderr}`;
      },
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
