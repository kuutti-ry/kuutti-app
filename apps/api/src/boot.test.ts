import { resolve } from "node:path";
import { createPool, migrate, type Pool, seed, withTemporaryDatabase } from "@kuutti/db";
import { ErrorResponse } from "@kuutti/schema";
import {
  ACR_LOATEST2,
  DiscoveryError,
  discoverProvider,
  keyIdOf,
  type ProviderMetadata,
} from "@kuutti/tunnistus-oidc";
import {
  type FakeTelia,
  fakeTelia,
  TELIA_AUTHORIZATION_ENDPOINT,
  TELIA_ISSUER,
} from "@kuutti/tunnistus-oidc/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BootOptions, boot } from "./boot.ts";
import { type IdentityBroker, OidcBroker } from "./identity/index.ts";
import { runNightly } from "./jobs/nightly.ts";
import { CHALLENGE } from "./test/attempt.ts";
import { captureLogger, type LogLine, TEST_DATABASE_URL, testConfig } from "./test/harness.ts";

// The boot sequence (index.ts is only the process around it) against a
// database of its own: a boot migrates, counts the waitlist and, for a
// preview, creates and seeds a database, all of which commits. The shared
// test database stays as the transactional tests expect it. Nothing goes to
// the network: discovery is a stub or the Telia double, Sentry is a fake.

const sentry = vi.hoisted(() => ({
  inits: 0,
  exceptions: [] as unknown[],
  tags: [] as Record<string, string>[],
}));
vi.mock("@sentry/node", () => ({
  init: vi.fn(() => {
    sentry.inits += 1;
  }),
  flush: vi.fn(async () => true),
  captureException: vi.fn((error: unknown) => {
    sentry.exceptions.push(error);
    return "event-id";
  }),
  withScope: vi.fn((fn: (scope: { setTag(k: string, v: string): void }) => void) => {
    const tags: Record<string, string> = {};
    sentry.tags.push(tags);
    fn({
      setTag(k, v) {
        tags[k] = v;
      },
    });
  }),
}));

const MIGRATIONS = resolve(import.meta.dirname, "..", "..", "..", "packages", "db", "drizzle");
// An artificial key, not the all-zero placeholder: only its shape matters here.
const HMAC_KEY = "1f".repeat(32);
const MOCK_ISSUER = "http://127.0.0.1:8080/ftn";
const WARN = 40;
const ERROR = 50;

/** The messages of the boot's own steps, in the order the boot logged them; the waitlist count has a test of its own. */
const STEPS = new Set([
  "error reporting",
  "bank identification",
  "bank identification off: OIDC_ISSUER is not set",
  "bank identification unavailable; is the mock IdP running?",
  "preview database",
  "migrations",
  "research event partitions",
  "audit boundary",
  "audit boundary not enforced: run infra/scripts/db-audit-owner.sh",
  "seed",
  "media",
  "photos off: media delivery is not configured (infra/modules/media)",
]);
type Lines = () => LogLine[];
const steps = (lines: Lines) =>
  lines()
    .map((l) => l.msg ?? "")
    .filter((m) => STEPS.has(m));
const line = (lines: Lines, msg: string) => lines().find((l) => l.msg === msg);

let databaseUrl: string;
let release: () => void;
let held: Promise<void>;

beforeAll(async () => {
  await new Promise<void>((ready) => {
    held = withTemporaryDatabase(async (url) => {
      databaseUrl = url;
      // A developer's database after `pnpm env:up`: migrated and seeded.
      const pool = createPool({ connectionString: url, max: 1 });
      try {
        await migrate(pool, MIGRATIONS);
        await seed(pool);
      } finally {
        await pool.end();
      }
      ready();
      await new Promise<void>((done) => {
        release = done;
      });
    });
  });
}, 120_000);

afterAll(async () => {
  release();
  await held;
});

const opened: Pool[] = [];
afterEach(async () => {
  for (const pool of opened.splice(0)) await pool.end();
});
beforeEach(() => {
  sentry.inits = 0;
  sentry.exceptions.length = 0;
  sentry.tags.length = 0;
});

async function booted(
  overrides: Record<string, string | undefined> = {},
  options: Partial<Omit<BootOptions, "config" | "logger">> = {},
) {
  const { logger, lines } = await captureLogger();
  const config = testConfig({ DATABASE_URL: databaseUrl, ...overrides });
  const result = await boot({ config, logger, ...options });
  opened.push(result.pool);
  return { ...result, lines };
}

/** A boot that must fail, and what it logged before it did. */
async function refused(
  overrides: Record<string, string | undefined>,
  options: Partial<Omit<BootOptions, "config" | "logger">> = {},
) {
  const { logger, lines } = await captureLogger();
  const config = testConfig({ DATABASE_URL: databaseUrl, ...overrides });
  const error = await boot({ config, logger, ...options }).then(
    (result) => {
      opened.push(result.pool);
      return null;
    },
    (e: unknown) => e,
  );
  return { error, lines };
}

const metadata = (overrides: Partial<ProviderMetadata> = {}): ProviderMetadata => ({
  issuer: MOCK_ISSUER,
  authorization_endpoint: `${MOCK_ISSUER}/authorize`,
  token_endpoint: `${MOCK_ISSUER}/token`,
  jwks_uri: `${MOCK_ISSUER}/jwks`,
  token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"],
  ...overrides,
});

/** A broker that sends every login to the mock bank's page and records what it was made from. */
function stubBroker() {
  const made: unknown[] = [];
  const broker: IdentityBroker = {
    issuer: MOCK_ISSUER,
    startLogin: async ({ state }) => new URL(`${MOCK_ISSUER}/authorize?state=${state}`),
    completeLogin: async () => {
      throw new Error("no login completes in a boot test");
    },
  };
  return {
    made,
    createBroker: async (options: unknown) => {
      made.push(options);
      return broker;
    },
  };
}

const startLogin = (app: { request: (path: string) => Response | Promise<Response> }) =>
  app.request(`/auth/start?platform=ios&code_challenge=${CHALLENGE}`);

describe("boot", () => {
  it("migrates, partitions, checks the audit boundary and sets up media, in that order, and the app answers", async () => {
    const { app, lines } = await booted();
    expect(steps(lines)).toEqual([
      "error reporting",
      "bank identification off: OIDC_ISSUER is not set",
      "migrations",
      "research event partitions",
      "audit boundary",
      "media",
    ]);
    expect(line(lines, "error reporting")).toMatchObject({ reporting: false, environment: "test" });
    expect(line(lines, "migrations")).toMatchObject({ state: "nothing-to-do", applied: 0 });
    // A test box is no deployed one: its unenforced boundary and missing media are said, not warned.
    expect(line(lines, "audit boundary")?.level).toBe(30);
    expect(line(lines, "media")).toMatchObject({ mode: "off" });
    expect(lines().some((l) => (l.level ?? 0) >= ERROR)).toBe(false);

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ db: "ok", migrations: "current" });
  });

  it("arms the eight nightly jobs, each of which runs against the database it was given", async () => {
    const { jobs } = await booted();
    expect(jobs.map((j) => j.name)).toEqual([
      "sweep-sessions",
      "sweep-admin-sessions",
      "research-events-partitions",
      "research-anonymity",
      "end-suspensions",
      "waitlist-snapshot",
      "pond-gate",
      "prune-photo-check-notes",
    ]);
    const { logger, lines } = await captureLogger();
    await runNightly(jobs, logger);
    expect(lines().map((l) => `${l.job}: ${l.msg}`)).toEqual(
      expect.arrayContaining(jobs.map((j) => `${j.name}: nightly job done`)),
    );
    expect(lines().filter((l) => l.msg === "nightly job failed")).toEqual([]);
  });

  it("with an object store, photos the automatic check missed get a nightly look as a ninth job", async () => {
    const { jobs, lines } = await booted({
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(line(lines, "media")).toMatchObject({ mode: "presigned", moderation: "queue" });
    expect(jobs.map((j) => j.name).at(-1)).toBe("moderate-pending-photos");
    expect(jobs).toHaveLength(9);
    // Nothing is pending in this database: the look finds nothing and asks the store nothing.
    const sweep = jobs.at(-1);
    expect(await sweep?.run()).toEqual({ rechecked: 0, failed: 0 });
  });

  it("logs an idle client the server dropped by its code and class, never its connection parameters, and lives on", async () => {
    const { pool, lines } = await booted();
    // The shape pg delivers for 57P01 (pg-protocol's DatabaseError): its name
    // is the protocol message's, "error", and its class says where it came from.
    class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "error";
      }
    }
    const dropped = Object.assign(
      new DatabaseError("terminating connection due to administrator command"),
      {
        code: "57P01",
        client: { connectionParameters: { password: "kuutti-boot-test-secret" } },
      },
    );
    pool.emit("error", dropped);
    const logged = line(lines, "idle database client dropped");
    // The message is no field of the line: the logger would print it as "[redacted]" (#235).
    expect(logged).toEqual({
      level: ERROR,
      time: expect.any(Number),
      pid: expect.any(Number),
      hostname: expect.any(String),
      code: "57P01",
      type: "DatabaseError",
      msg: "idle database client dropped",
    });
    expect(JSON.stringify(lines())).not.toContain("kuutti-boot-test-secret");
    expect((await pool.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  it("counts the waitlist of a database with no figures yet, last, and does not count it again", async () => {
    const admin = createPool({ connectionString: databaseUrl, max: 1 });
    try {
      await admin.query("DELETE FROM waitlist_snapshot");
      const first = await booted();
      const messages = first.lines().map((l) => l.msg);
      expect(line(first.lines, "waitlist snapshot")).toMatchObject({ counted: true });
      expect(messages.indexOf("waitlist snapshot")).toBeGreaterThan(messages.indexOf("media"));
      const { rows } = await admin.query<{ n: string }>(
        "SELECT count(*) AS n FROM waitlist_snapshot",
      );
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);

      const second = await booted();
      expect(second.lines().filter((l) => /^waitlist snapshot/.test(l.msg ?? ""))).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("logs a first waitlist count that fails and boots all the same", async () => {
    const admin = createPool({ connectionString: databaseUrl, max: 1 });
    // The counter's table gone for the length of one boot: the count fails as a broken database would.
    await admin.query("ALTER TABLE waitlist_snapshot RENAME TO waitlist_snapshot_away");
    try {
      const { app, lines } = await booted();
      const failed = line(lines, "first waitlist snapshot failed");
      expect(failed).toMatchObject({ level: ERROR, job: "waitlist-snapshot" });
      expect(JSON.stringify(failed?.err)).toContain("42P01");
      expect((await app.request("/health")).status).toBe(200);
    } finally {
      await admin.query("ALTER TABLE waitlist_snapshot_away RENAME TO waitlist_snapshot");
      await admin.end();
    }
  });
});

describe("boot: error reporting (#11)", () => {
  const DSN = "https://k@o1.ingest.de.sentry.io/2";

  it("is off without a DSN: nothing is initialised and an unhandled error is only logged", async () => {
    const { app } = await booted();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    expect((await app.request("/boom")).status).toBe(500);
    expect(sentry.inits).toBe(0);
    expect(sentry.exceptions).toEqual([]);
  });

  it("with a DSN, every unhandled error is reported with the request id the envelope carries", async () => {
    const { app, lines } = await booted({ SENTRY_DSN: DSN });
    expect(sentry.inits).toBe(1);
    expect(line(lines, "error reporting")).toMatchObject({ reporting: true });
    // No self-test unless it is asked for by name.
    expect(sentry.exceptions).toEqual([]);
    expect(lines().some((l) => /self-test/.test(l.msg ?? ""))).toBe(false);

    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = ErrorResponse.parse(await res.json());
    expect((sentry.exceptions[0] as Error).message).toBe("kaboom");
    expect(sentry.tags[0]).toEqual({ requestId: body.error.requestId, route: "/boom" });
  });

  it("the self-test sends one marked event at boot and says to switch it off again", async () => {
    const { lines } = await booted({ SENTRY_DSN: DSN, SENTRY_SELF_TEST: "true" });
    expect(sentry.exceptions).toHaveLength(1);
    expect((sentry.exceptions[0] as Error).message).toMatch(/^Sentry self-test/);
    expect(sentry.tags[0]).toEqual({ requestId: "self-test" });
    expect(
      line(lines, "Sentry self-test event sent; unset SENTRY_SELF_TEST and redeploy")?.level,
    ).toBe(WARN);
  });

  it("the self-test without a DSN sends nothing", async () => {
    await booted({ SENTRY_SELF_TEST: "true" });
    expect(sentry.inits).toBe(0);
    expect(sentry.exceptions).toEqual([]);
  });
});

describe("boot: bank identification (#32, ADR-017)", () => {
  const mockBank = {
    OIDC_ISSUER: MOCK_ISSUER,
    OIDC_CLIENT_ID: "kuutti-local",
    OIDC_REDIRECT_URI: "http://localhost:3000/auth/callback",
    HETU_HMAC_KEY: HMAC_KEY,
  };

  it("without OIDC_ISSUER there is no broker and the login answers 503", async () => {
    const { app, lines } = await booted();
    expect(line(lines, "bank identification off: OIDC_ISSUER is not set")?.level).toBe(WARN);
    const res = await startLogin(app);
    expect(res.status).toBe(503);
    expect(ErrorResponse.parse(await res.json()).error.code).toBe("auth_provider_error");
  });

  it("a discovered issuer with the whole configuration gives the login its broker, and the endpoints are logged", async () => {
    const stub = stubBroker();
    const discovered: string[] = [];
    const { app, lines } = await booted(mockBank, {
      discover: async (issuer) => {
        discovered.push(issuer);
        return metadata();
      },
      createBroker: stub.createBroker,
    });
    expect(discovered).toEqual([MOCK_ISSUER]);
    expect(stub.made).toEqual([
      {
        issuer: MOCK_ISSUER,
        clientId: "kuutti-local",
        redirectUri: "http://localhost:3000/auth/callback",
        acrValues: null,
        signingKeyPem: null,
        encryptionKeyPem: null,
      },
    ]);
    expect(line(lines, "bank identification")).toMatchObject({
      issuer: MOCK_ISSUER,
      authorizationEndpoint: `${MOCK_ISSUER}/authorize`,
      tokenEndpoint: `${MOCK_ISSUER}/token`,
      jwksUri: `${MOCK_ISSUER}/jwks`,
      acrValues: null,
      keys: { signing: null, encryption: null },
    });
    const res = await startLogin(app);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(new RegExp(`^${MOCK_ISSUER}/authorize\\?state=`));
  });

  it("a mock that lists no client authentication at all is still a broker: only Telia must offer private_key_jwt", async () => {
    const stub = stubBroker();
    await booted(mockBank, {
      discover: async () => metadata({ token_endpoint_auth_methods_supported: undefined }),
      createBroker: stub.createBroker,
    });
    expect(stub.made).toHaveLength(1);
  });

  describe("Telia's issuer, through the in-process double", () => {
    let telia: FakeTelia;
    beforeEach(async () => {
      telia = await fakeTelia();
    });
    const teliaConfig = () => ({
      OIDC_ISSUER: TELIA_ISSUER,
      OIDC_CLIENT_ID: telia.clientId,
      OIDC_REDIRECT_URI: telia.redirectUri,
      OIDC_ACR_VALUES: ACR_LOATEST2,
      TELIA_SIGNING_KEY: telia.signingKeyPem,
      TELIA_ENCRYPTION_KEY: telia.encryptionKeyPem,
      HETU_HMAC_KEY: HMAC_KEY,
    });
    const viaDouble = () => ({
      discover: (issuer: string) =>
        discoverProvider(issuer, (url, init) =>
          telia.fetch(url, { ...init } as Parameters<FakeTelia["fetch"]>[1]),
        ),
      createBroker: (options: Parameters<typeof OidcBroker.create>[0]) =>
        OidcBroker.create({ ...options, fetch: telia.fetch }),
    });

    it("is discovered, the ids of our two keys are logged and never the keys, and the login goes to Telia", async () => {
      const { app, lines } = await booted(teliaConfig(), viaDouble());
      expect(line(lines, "bank identification")).toMatchObject({
        issuer: TELIA_ISSUER,
        authorizationEndpoint: TELIA_AUTHORIZATION_ENDPOINT,
        acrValues: ACR_LOATEST2,
        keys: {
          signing: keyIdOf(telia.signingKeyPem),
          encryption: keyIdOf(telia.encryptionKeyPem),
        },
      });
      expect(JSON.stringify(lines())).not.toContain("PRIVATE KEY");
      const res = await startLogin(app);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(TELIA_AUTHORIZATION_ENDPOINT);
      expect(location.search).not.toBe("");
    });

    it("an issuer on Telia's host without private_key_jwt is not the broker: a warning locally, a failed boot on staging", async () => {
      const stub = stubBroker();
      const notTelia = {
        discover: async () =>
          metadata({
            issuer: TELIA_ISSUER,
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          }),
        createBroker: stub.createBroker,
      };
      const { app, lines } = await booted(teliaConfig(), notTelia);
      const warned = line(lines, "bank identification unavailable; is the mock IdP running?");
      expect(warned).toMatchObject({ level: WARN, stage: "discovery" });
      expect(JSON.stringify(warned?.err)).toContain("DiscoveryError");
      expect(line(lines, "bank identification")).toBeUndefined();
      expect(stub.made).toEqual([]);
      expect((await startLogin(app)).status).toBe(503);

      const staging = await refused({ ...teliaConfig(), APP_ENV: "staging" }, notTelia);
      expect(staging.error).toBeInstanceOf(DiscoveryError);
      expect((staging.error as Error).message).toContain(
        "no private_key_jwt at the token endpoint",
      );
      // Refused before the database: nothing was migrated or counted.
      expect(steps(staging.lines)).toEqual(["error reporting"]);
    });

    it("Telia's issuer without our two keys is a configuration error: a warning locally, a failed boot on staging", async () => {
      const withoutKeys = {
        ...teliaConfig(),
        TELIA_SIGNING_KEY: undefined,
        TELIA_ENCRYPTION_KEY: undefined,
      };
      // The broker the boot makes by itself: it refuses before it would reach for Telia.
      const discover = async () =>
        metadata({
          issuer: TELIA_ISSUER,
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        });
      const { app, lines } = await booted(withoutKeys, { discover });
      expect(line(lines, "bank identification")).toMatchObject({
        keys: { signing: null, encryption: null },
      });
      // Making the client is where the keys are required (OidcBroker.create).
      expect(
        line(lines, "bank identification unavailable; is the mock IdP running?"),
      ).toMatchObject({
        level: WARN,
        stage: "broker",
      });
      expect((await startLogin(app)).status).toBe(503);

      const staging = await refused({ ...withoutKeys, APP_ENV: "staging" }, { discover });
      expect((staging.error as Error).message).toBe(
        "a Telia issuer needs TELIA_SIGNING_KEY and TELIA_ENCRYPTION_KEY",
      );
    });

    it("a key that is no PEM is our configuration, not the broker's discovery: the local warning says so", async () => {
      const discover = async () =>
        metadata({
          issuer: TELIA_ISSUER,
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        });
      const stub = stubBroker();
      const { lines } = await booted(
        { ...teliaConfig(), TELIA_SIGNING_KEY: "not a key" },
        { discover, createBroker: stub.createBroker },
      );
      expect(
        line(lines, "bank identification unavailable; is the mock IdP running?"),
      ).toMatchObject({ level: WARN, stage: "configuration" });
      expect(line(lines, "bank identification")).toBeUndefined();
      expect(stub.made).toEqual([]);
    });

    it("an issuer on Telia's host whose document lists no client authentication is refused the same way", async () => {
      const { lines } = await booted(teliaConfig(), {
        discover: async () =>
          metadata({ issuer: TELIA_ISSUER, token_endpoint_auth_methods_supported: undefined }),
        createBroker: stubBroker().createBroker,
      });
      expect(
        line(lines, "bank identification unavailable; is the mock IdP running?"),
      ).toBeDefined();
    });
  });

  it.each([
    ["no client id", { OIDC_CLIENT_ID: undefined }],
    ["no redirect URI", { OIDC_REDIRECT_URI: undefined }],
    ["no HMAC key", { HETU_HMAC_KEY: undefined }],
  ])(
    "half a configuration (%s) is no choice: a warning locally, a failed boot on staging",
    async (_, missing) => {
      const stub = stubBroker();
      const options = { discover: async () => metadata(), createBroker: stub.createBroker };
      const local = await booted({ ...mockBank, ...missing }, options);
      // The thrown error's message is redacted like any (lib/logger.ts); the stage names the cause.
      expect(
        line(local.lines, "bank identification unavailable; is the mock IdP running?"),
      ).toMatchObject({ level: WARN, stage: "configuration" });
      expect(stub.made).toEqual([]);
      expect((await startLogin(local.app)).status).toBe(503);

      const staging = await refused({ ...mockBank, ...missing, APP_ENV: "staging" }, options);
      expect((staging.error as Error).message).toBe(
        "bank identification off: OIDC_CLIENT_ID, OIDC_REDIRECT_URI or HETU_HMAC_KEY is not set",
      );
    },
  );

  it("a broker that cannot be discovered is a warning in development and a failed boot in production", async () => {
    const down = {
      discover: async (issuer: string): Promise<ProviderMetadata> => {
        throw new DiscoveryError(issuer, "HTTP 503 from the broker");
      },
      createBroker: stubBroker().createBroker,
    };
    const development = await booted({ ...mockBank, APP_ENV: "development" }, down);
    expect(
      line(development.lines, "bank identification unavailable; is the mock IdP running?"),
    ).toMatchObject({ level: WARN, stage: "discovery" });
    expect(line(development.lines, "migrations")).toBeDefined();

    const production = await refused(
      { ...mockBank, APP_ENV: "production", ADMIN_APP_URL: "https://admin.kuutti.app" },
      down,
    );
    expect(production.error).toBeInstanceOf(DiscoveryError);
    expect(steps(production.lines)).toEqual(["error reporting"]);
  });
});

describe("boot: a deployed box", () => {
  it.each([
    ["staging", {}],
    ["production", { ADMIN_APP_URL: "https://admin.kuutti.app" }],
  ])(
    "%s warns that the audit boundary is not enforced and that photos are off",
    async (appEnv, extra) => {
      const { app, lines } = await booted({ APP_ENV: appEnv, ...extra });
      expect(steps(lines)).toEqual([
        "error reporting",
        "bank identification off: OIDC_ISSUER is not set",
        "migrations",
        "research event partitions",
        "audit boundary not enforced: run infra/scripts/db-audit-owner.sh",
        "photos off: media delivery is not configured (infra/modules/media)",
      ]);
      expect(
        line(lines, "audit boundary not enforced: run infra/scripts/db-audit-owner.sh"),
      ).toMatchObject({ level: WARN, enforced: false });
      expect(
        line(lines, "photos off: media delivery is not configured (infra/modules/media)"),
      ).toMatchObject({ level: WARN, mode: "off" });
      expect((await app.request("/health")).status).toBe(200);
    },
  );
});

describe("boot: a pull-request preview (#9)", () => {
  // Seven digits at most (the preview pattern); a 9 in front keeps it apart from preview-database.test.ts.
  const prNumber = `9${String(process.pid % 1_000_000).padStart(6, "0")}`;
  const database = `kuutti_pr_${prNumber}`;

  afterAll(async () => {
    const admin = createPool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      // The boots' pools are ended; wait for their sessions to leave before the drop.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const open = await admin.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1",
          [database],
        );
        if (Number(open.rows[0]?.n) === 0) break;
        await new Promise((done) => setTimeout(done, 20));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("creates its own database on first boot, migrates and seeds it, and finds it the second time", async () => {
    const preview = { APP_ENV: "preview", PR_NUMBER: prNumber, DATABASE_URL: TEST_DATABASE_URL };
    const first = await booted(preview);
    expect(steps(first.lines)).toEqual([
      "error reporting",
      "bank identification off: OIDC_ISSUER is not set",
      "preview database",
      "migrations",
      "research event partitions",
      // The preview role owns its throwaway database: no boundary there by design, and no warning.
      "audit boundary",
      "seed",
      "photos off: media delivery is not configured (infra/modules/media)",
    ]);
    expect(line(first.lines, "preview database")).toMatchObject({ database, state: "created" });
    expect(line(first.lines, "migrations")).toMatchObject({ state: "applied" });
    const { rows } = await first.pool.query<{ db: string; ponds: string; config: string }>(
      `SELECT current_database() AS db, (SELECT count(*) FROM ponds) AS ponds,
              (SELECT count(*) FROM matching_config) AS config`,
    );
    expect(rows[0]?.db).toBe(database);
    expect(Number(rows[0]?.ponds)).toBeGreaterThan(0);
    expect(Number(rows[0]?.config)).toBeGreaterThan(0);
    // A preview has no bank: the login sends the app back with a reason, not a 503.
    const res = await startLogin(first.app);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=auth_unavailable");

    const second = await booted(preview);
    expect(line(second.lines, "preview database")).toMatchObject({ database, state: "exists" });
    expect(line(second.lines, "migrations")).toMatchObject({ state: "nothing-to-do" });
  }, 120_000);
});
