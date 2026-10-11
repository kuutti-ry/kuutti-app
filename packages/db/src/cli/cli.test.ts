import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../migrate.ts";
import { createPool, type Pool } from "../pool.ts";
import { SEED_PONDS } from "../seed.ts";
import { TEST_DATABASE_URL, withTemporaryDatabase } from "../test/temporary-database.ts";

// The command lines of the package, run in this process against a temporary
// database of the local server (#5, #34, #49): migrate, the seed and the
// staff roles. Every refusal is tried before anything else, and the seed's
// refusal of production happens before it reads DATABASE_URL at all.
// migrate.test.ts runs migrate as two real processes for the advisory lock.

const MIGRATIONS = resolve(import.meta.dirname, "..", "..", "drizzle");

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const COMMANDS = {
  migrate: () => import("./migrate.ts"),
  seed: () => import("./seed.ts"),
  moderator: () => import("./moderator.ts"),
};

type Run = { code: number | undefined; out: string[]; err: string[] };

/** Runs `node src/cli/<command>.ts ...args` in this process, with exactly the environment given. */
async function run(
  command: keyof typeof COMMANDS,
  args: string[],
  env: { DATABASE_URL?: string; APP_ENV?: string },
): Promise<Run> {
  vi.resetModules();
  const result: Run = { code: 0, out: [], err: [] };
  const saved = { argv: process.argv, url: process.env.DATABASE_URL, app: process.env.APP_ENV };
  process.argv = [process.execPath, resolve(import.meta.dirname, `${command}.ts`), ...args];
  for (const [name, value] of Object.entries({
    DATABASE_URL: env.DATABASE_URL,
    APP_ENV: env.APP_ENV,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      result.out.push(parts.map(String).join(" "));
    }),
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      result.err.push(parts.map(String).join(" "));
    }),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Exit(code);
    }) as never),
  ];
  try {
    await COMMANDS[command]();
    result.code = Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    result.code = error.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.exitCode = undefined;
    process.argv = saved.argv;
    for (const [name, value] of Object.entries({ DATABASE_URL: saved.url, APP_ENV: saved.app })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return result;
}

/** A database of the local server that does not exist: the connection fails, nothing is created. */
const NOWHERE = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/kuutti_no_such_database";
  return url.toString();
})();

describe("pnpm --filter @kuutti/db migrate", () => {
  it("refuses to start without DATABASE_URL", async () => {
    expect(await run("migrate", [], {})).toEqual({
      code: 1,
      out: [],
      err: ["DATABASE_URL is not set"],
    });
  });

  it("applies the migrations once, then has nothing to do", async () => {
    await withTemporaryDatabase(async (url) => {
      const first = await run("migrate", [], { DATABASE_URL: url });
      expect(first.code).toBe(0);
      expect(JSON.parse(first.out[0] ?? "{}")).toMatchObject({ msg: "migrate", state: "applied" });
      const second = await run("migrate", [], { DATABASE_URL: url });
      expect(JSON.parse(second.out[0] ?? "{}")).toEqual({
        msg: "migrate",
        state: "nothing-to-do",
        applied: 0,
      });
    });
  });

  it("ends with 1 when the database cannot be reached, and says why", async () => {
    const result = await run("migrate", [], { DATABASE_URL: NOWHERE });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/kuutti_no_such_database/);
  });
});

describe("pnpm --filter @kuutti/db seed", () => {
  it.each([
    ["--env production", ["--env", "production"], undefined],
    ["APP_ENV=production", [], "production"],
    ["--env production over APP_ENV=development", ["--env", "production"], "development"],
  ])("refuses production (%s) before it reads DATABASE_URL", async (_, args, appEnv) => {
    // No DATABASE_URL: a refusal after reading it would say so with exit 1.
    expect(await run("seed", args, { APP_ENV: appEnv })).toEqual({
      code: 2,
      out: [],
      err: ["refusing to seed production: previews and local databases only (TD-19)"],
    });
  });

  it("needs DATABASE_URL outside production", async () => {
    expect(await run("seed", ["--env", "preview"], {})).toMatchObject({
      code: 1,
      err: ["DATABASE_URL is not set"],
    });
  });

  it("seeds a migrated database, naming the environment, from --env, APP_ENV or the default", async () => {
    await withTemporaryDatabase(async (url) => {
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
      } finally {
        await pool.end();
      }
      for (const [args, appEnv, env] of [
        [["--env", "preview"], undefined, "preview"],
        [[], "test", "test"],
        [[], undefined, "development"],
        [["--env"], "test", "test"],
      ] as const) {
        const result = await run("seed", [...args], { DATABASE_URL: url, APP_ENV: appEnv });
        expect(result.code, env).toBe(0);
        expect(JSON.parse(result.out[0] ?? "{}")).toEqual({
          msg: "seed",
          env,
          ponds: SEED_PONDS.length,
          matchingConfig: expect.any(Number),
          identities: 3,
        });
      }
    });
  });

  it("ends with 1 when the database has no tables to seed", async () => {
    await withTemporaryDatabase(async (url) => {
      const result = await run("seed", [], { DATABASE_URL: url });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(/Failed query: insert into "ponds"/);
    });
  });
});

describe("pnpm --filter @kuutti/db moderator", () => {
  let url = "";
  let pool: Pool;
  let release: () => void = () => undefined;
  let dropped: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    // One temporary database for the block, dropped when it ends.
    await new Promise<void>((ready) => {
      dropped = withTemporaryDatabase(async (temporary) => {
        url = temporary;
        ready();
        await new Promise<void>((done) => {
          release = done;
        });
      });
    });
    pool = createPool({ connectionString: url, max: 2 });
    await migrate(pool, MIGRATIONS);
  });

  afterAll(async () => {
    await pool.end();
    release();
    await dropped;
  });

  beforeEach(async () => {
    // audit_log refuses TRUNCATE (append-only), so the rows go one table at a time.
    await pool.query("DELETE FROM admin_session");
    await pool.query("DELETE FROM moderator_roles");
    await pool.query("DELETE FROM identity");
  });

  const hmac = (n: number) => n.toString(16).padStart(64, "a");
  const identity = async (n: number, fields: { standing?: string; at?: string | null } = {}) => {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO identity (hetu_hmac, standing, authenticated_at) VALUES ($1, $2, $3) RETURNING id",
      [hmac(n), fields.standing ?? "ok", fields.at ?? null],
    );
    return rows[0]?.id as string;
  };
  const moderator = (args: string[], appEnv?: string) =>
    run("moderator", args, { DATABASE_URL: url, APP_ENV: appEnv });

  it("refuses to start without DATABASE_URL", async () => {
    expect(await run("moderator", ["list"], {})).toMatchObject({
      code: 2,
      err: ["DATABASE_URL is not set"],
    });
  });

  it("refuses production unless --env production is given on purpose", async () => {
    expect(await moderator(["list"], "production")).toMatchObject({
      code: 2,
      err: ["refusing production without --env production"],
    });
    expect(await moderator(["list", "--env", "production"], "production")).toEqual({
      code: 0,
      out: ["no staff roles"],
      err: [],
    });
  });

  it("lists the identities that logged in last, newest first, at most five", async () => {
    expect((await moderator(["recent"])).out).toEqual(["no identities"]);
    await identity(1, { at: null, standing: "banned" });
    for (let n = 2; n <= 7; n += 1) await identity(n, { at: `2026-10-0${n}T12:00:00Z` });
    expect((await moderator(["recent"])).out).toEqual(
      [7, 6, 5, 4, 3].map((n) => `${hmac(n)} 2026-10-0${n}T12:00:00.000Z ok`),
    );
    await pool.query("DELETE FROM identity WHERE hetu_hmac <> $1", [hmac(1)]);
    expect((await moderator(["recent"])).out).toEqual([`${hmac(1)} never banned`]);
  });

  it("grants a role to an identity in good standing, and changes it when granted again", async () => {
    const id = await identity(1);
    expect(await moderator(["grant", hmac(1), "moderator", "--by", "Maintainer"])).toEqual({
      code: 0,
      out: ["granted moderator"],
      err: [],
    });
    expect((await moderator(["grant", hmac(1), "admin", "--by", "Maintainer"])).out).toEqual([
      "granted admin",
    ]);
    const { rows } = await pool.query<{ role: string; granted_by: string }>(
      "SELECT role, granted_by FROM moderator_roles WHERE identity_id = $1",
      [id],
    );
    expect(rows).toEqual([{ role: "admin", granted_by: "Maintainer" }]);
    const listed = await moderator(["list"]);
    expect(listed.out).toEqual([
      expect.stringMatching(new RegExp(`^admin {6}${hmac(1)} granted \\S+Z by Maintainer$`)),
    ]);
  });

  it.each([
    ["no role", ["grant", "HMAC", "--by", "Maintainer"]],
    ["a role that does not exist", ["grant", "HMAC", "owner", "--by", "Maintainer"]],
    ["no name of who grants it", ["grant", "HMAC", "moderator"]],
    ["--by without a name", ["grant", "HMAC", "moderator", "--by"]],
  ])("refuses a grant with %s", async (_, args) => {
    await identity(1);
    const result = await moderator(args.map((arg) => (arg === "HMAC" ? hmac(1) : arg)));
    expect(result).toMatchObject({
      code: 2,
      err: ["usage: moderator grant <hetu_hmac> <moderator|admin|researcher> --by <name>"],
    });
    expect((await pool.query("SELECT 1 FROM moderator_roles")).rowCount).toBe(0);
  });

  it.each(["suspended", "banned"])("refuses a role to a %s identity", async (standing) => {
    await identity(1, { standing });
    expect(await moderator(["grant", hmac(1), "moderator", "--by", "Maintainer"])).toMatchObject({
      code: 1,
      err: [`identity standing is ${standing}; not granting`],
    });
  });

  it.each([
    ["no hetu_hmac", ["grant"]],
    ["a hetu_hmac that is not 64 hex digits", ["revoke", "a".repeat(63)]],
    ["a hetu_hmac with a letter outside hex", ["revoke", `${"a".repeat(63)}g`]],
  ])("answers with the usage for %s", async (_, args) => {
    expect(await moderator(args)).toMatchObject({
      code: 2,
      err: ["usage: moderator grant <hetu_hmac> <role> --by <name> | revoke <hetu_hmac> | list"],
    });
  });

  it("names an identity that never logged in, and a command it does not know", async () => {
    expect(await moderator(["revoke", hmac(9)])).toMatchObject({
      code: 1,
      err: ["no identity with that hetu_hmac: the person has to have logged in once"],
    });
    await identity(9);
    expect(await moderator(["promote", hmac(9)])).toMatchObject({
      code: 2,
      err: ["usage: moderator grant <hetu_hmac> <role> --by <name> | revoke <hetu_hmac> | list"],
    });
  });

  it("takes an upper-case hetu_hmac as given", async () => {
    await pool.query("INSERT INTO identity (hetu_hmac) VALUES ($1)", ["F".repeat(64)]);
    expect((await moderator(["grant", "F".repeat(64), "researcher", "--by", "M"])).out).toEqual([
      "granted researcher",
    ]);
  });

  it("revokes a role and ends the identity's live admin sessions, and says when there was none", async () => {
    const id = await identity(1);
    await moderator(["grant", hmac(1), "moderator", "--by", "Maintainer"]);
    await pool.query(
      `INSERT INTO admin_session (identity_id, role, access_hash, expires_at, revoked_at) VALUES
       ($1, 'moderator', 'live', now() + interval '8 hours', NULL),
       ($1, 'moderator', 'ended', now() + interval '8 hours', '2026-01-01T00:00:00Z')`,
      [id],
    );
    expect(await moderator(["revoke", hmac(1)])).toEqual({ code: 0, out: ["revoked"], err: [] });
    const sessions = await pool.query<{ access_hash: string; revoked_at: Date }>(
      "SELECT access_hash, revoked_at FROM admin_session ORDER BY access_hash",
    );
    expect(sessions.rows.map((row) => row.access_hash)).toEqual(["ended", "live"]);
    expect(sessions.rows.every((row) => row.revoked_at instanceof Date)).toBe(true);
    // The session revoked earlier keeps its own time.
    expect(sessions.rows[0]?.revoked_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect((await moderator(["revoke", hmac(1)])).out).toEqual(["no role to revoke"]);
    expect((await moderator(["list"])).out).toEqual(["no staff roles"]);
  });
});
