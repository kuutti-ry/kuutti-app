import { describe, expect, it } from "vitest";
import { createPool } from "../pool.ts";
import { TEST_DATABASE_URL } from "../test/temporary-database.ts";
import {
  assertDemoTarget,
  assertStagingProcess,
  DemoCommandError,
  type DemoTarget,
  describeTarget,
  NEVER_GIVEN_ON_STAGING,
  parseDemoCommand,
} from "./command.ts";

// Where the synthetic population may be written (#73, ADR-014 §10): a named
// and allowed environment, every argument understood, and a server that is
// not a deployed one, whatever anything is called.

describe("the command's arguments", () => {
  it("are three hundred people with the usual seed in development, when nothing is said", () => {
    expect(parseDemoCommand([], undefined)).toEqual({
      env: "development",
      size: 300,
      seed: 73,
      action: "write",
      photos: false,
    });
    // pnpm hands the separator through.
    expect(parseDemoCommand(["--", "--dry-run"], "development").action).toBe("dry-run");
  });

  it("take both forms of a value", () => {
    expect(parseDemoCommand(["--size", "5000", "--seed=7", "--env", "test"], undefined)).toEqual({
      env: "test",
      size: 5000,
      seed: 7,
      action: "write",
      photos: false,
    });
    expect(parseDemoCommand(["--env=preview", "--remove"], "preview")).toMatchObject({
      env: "preview",
      action: "remove",
      photos: false,
    });
  });

  it("go ahead only in an environment that is named and allowed", () => {
    for (const env of ["production", "Production", "prod", "Staging", "", " development", "demo"]) {
      expect(() => parseDemoCommand(["--env", env], undefined), `--env ${env}`).toThrow(
        DemoCommandError,
      );
      expect(() => parseDemoCommand([`--env=${env}`], undefined), `--env=${env}`).toThrow(
        DemoCommandError,
      );
      expect(() => parseDemoCommand([], env), `APP_ENV=${env}`).toThrow(DemoCommandError);
      // The flag does not talk the process's own environment away.
      expect(() => parseDemoCommand(["--env", "development"], env)).toThrow(DemoCommandError);
      expect(() => parseDemoCommand(["--dry-run"], env)).toThrow(DemoCommandError);
    }
    expect(() => parseDemoCommand(["--env", "production"], "development")).toThrow(/refusing/);
  });

  it("are understood, every one, or nothing happens", () => {
    for (const args of [
      ["--dryrun"],
      ["--dry_run"],
      ["-n"],
      ["remove"],
      ["--size"],
      ["--size", "abc"],
      ["--size", "-5"],
      ["--size", "1.5"],
      ["--size=0"],
      ["--size", "5001"],
      ["--seed", ""],
      ["--remove=yes"],
      ["--remove", "--dry-run"],
      ["--env", "production", "--env", "development"],
      ["--env=development", "--env", "development"],
      ["--size", "300", "--size=5000"],
      ["--seed", "1", "--seed", "1"],
      ["--dry-run", "--dry-run"],
      ["--dry-run", "--", "--remove"],
      ["--size", "300", "extra"],
    ]) {
      expect(() => parseDemoCommand(args, undefined), args.join(" ")).toThrow(DemoCommandError);
    }
  });
});

describe("the server the rows would go to", () => {
  const local: DemoTarget = {
    database: "kuutti",
    user: "kuutti",
    host: "127.0.0.1",
    port: 5432,
    managed: false,
  };

  it("says what it is: the local one is no managed server", async () => {
    const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const target = await describeTarget(pool);
      expect(target).toMatchObject({ managed: false, user: expect.any(String) });
      expect(target.database).toBe(new URL(TEST_DATABASE_URL).pathname.slice(1));
      expect(Object.keys(target).sort()).toEqual(["database", "host", "managed", "port", "user"]);
      expect(() => assertDemoTarget(target, "test")).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it("allows staging by name since ADR-018, and asks where the command runs afterwards", () => {
    expect(parseDemoCommand(["--env", "staging"], "staging").env).toBe("staging");
    expect(() => parseDemoCommand(["--env", "staging"], "production")).toThrow(DemoCommandError);
    // Staging names a managed server, from inside its container (assertStagingProcess); a local one is not it.
    const tunnel: DemoTarget = { ...local, port: 15432, user: "kuutti_app", managed: true };
    expect(() => assertDemoTarget(tunnel, "staging")).not.toThrow();
    expect(() => assertDemoTarget(local, "staging")).toThrow(/managed server/);
  });

  it("is refused when it is a deployed one, whatever the environment is called", () => {
    // Staging and production through the tunnel: 127.0.0.1, database kuutti, and managed.
    const tunnel: DemoTarget = { ...local, port: 15432, user: "kuutti_app", managed: true };
    for (const env of ["development", "test", "preview"] as const) {
      expect(() => assertDemoTarget(tunnel, env), env).toThrow(/managed server/);
      expect(() => assertDemoTarget(local, env), env).not.toThrow();
    }
  });

  it("is a pull request's own database only when asked for as a preview", () => {
    const preview: DemoTarget = { ...local, database: "kuutti_pr_88", managed: true };
    expect(() => assertDemoTarget(preview, "preview")).not.toThrow();
    expect(() => assertDemoTarget(preview, "development")).toThrow(DemoCommandError);
    for (const database of [
      "kuutti",
      "kuutti_pr_",
      "kuutti_pr_88x",
      "xkuutti_pr_88",
      "kuutti_test",
    ]) {
      expect(() => assertDemoTarget({ ...preview, database }, "preview"), database).toThrow(
        DemoCommandError,
      );
    }
  });
});

describe("the command's faces", () => {
  it("are asked for with --photos, for a write or a dry run", () => {
    expect(parseDemoCommand(["--photos"], undefined)).toMatchObject({
      action: "write",
      photos: true,
    });
    expect(parseDemoCommand(["--dry-run", "--photos"], "test")).toMatchObject({
      action: "dry-run",
      photos: true,
    });
  });

  it.each([
    [["--photos=yes"], /--photos takes no value/],
    [["--dry-run=1"], /--dry-run takes no value/],
    [["--photos", "--remove"], /--photos is for writing/],
    [["--photos", "--photos"], /--photos is given twice/],
  ])("are refused as %o", (args, message) => {
    expect(() => parseDemoCommand(args, undefined)).toThrow(message);
  });
});

describe("an environment named without a value", () => {
  it.each([[["--env"]], [["--env="]], [["--size", "10", "--env"]]])(
    "is refused, never taken as development: %o",
    (args) => {
      expect(() => parseDemoCommand(args, undefined)).toThrow(/refusing: --env is ""/);
    },
  );

  it("is refused even when APP_ENV is an allowed one", () => {
    expect(() => parseDemoCommand(["--env"], "development")).toThrow(DemoCommandError);
  });

  it("says which number it could not read", () => {
    expect(() => parseDemoCommand(["--seed"], undefined)).toThrow(
      "--seed takes a whole number, not nothing",
    );
    expect(() => parseDemoCommand(["--size", "1e3"], undefined)).toThrow(
      "--size takes a whole number, not 1e3",
    );
    expect(() => parseDemoCommand(["--size=0"], undefined)).toThrow(
      "a population is 1 to 5000 people, not 0",
    );
  });

  it("takes the extremes of the size", () => {
    expect(parseDemoCommand(["--size", "1"], undefined).size).toBe(1);
    expect(parseDemoCommand(["--size=5000"], undefined).size).toBe(5000);
    expect(parseDemoCommand(["--seed", "0"], undefined).seed).toBe(0);
  });
});

describe("the staging process (ADR-018)", () => {
  it("is staging's container with nothing given by hand", () => {
    expect(() => assertStagingProcess({ APP_ENV: "staging", PATH: "/usr/bin" })).not.toThrow();
  });

  it.each([
    [{}, 'refusing: APP_ENV is "unset"'],
    [{ APP_ENV: "production" }, 'refusing: APP_ENV is "production"'],
    [{ APP_ENV: "Staging" }, 'refusing: APP_ENV is "Staging"'],
    [{ APP_ENV: "development" }, 'refusing: APP_ENV is "development"'],
  ])("is refused when APP_ENV is not staging: %o", (env, message) => {
    expect(() => assertStagingProcess(env)).toThrow(message);
    expect(() => assertStagingProcess(env)).toThrow(DemoCommandError);
  });

  it.each(NEVER_GIVEN_ON_STAGING)("is refused when %s is given to the process", (name) => {
    expect(() => assertStagingProcess({ APP_ENV: "staging", [name]: "x" })).toThrow(
      `refusing: ${name} given to the process`,
    );
  });

  it("names every value given by hand at once, and counts an empty one as given", () => {
    expect(() =>
      assertStagingProcess({ APP_ENV: "staging", DATABASE_URL: "", HETU_HMAC_KEY: "k" }),
    ).toThrow("refusing: DATABASE_URL, HETU_HMAC_KEY given to the process");
  });
});
