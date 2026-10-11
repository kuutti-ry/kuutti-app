import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// loadConfig on a deployed box (TD-19, #7): the parameters under the
// environment's prefix, read through the instance role, filled in beneath
// what the process environment sets. The SDK client is replaced: no request
// leaves the test, and what it was asked is read back.
const ssm = vi.hoisted(() => ({
  clients: [] as unknown[],
  paths: [] as string[],
  parameters: {} as Record<string, { Name: string; Value: string }[]>,
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    constructor(config: unknown) {
      ssm.clients.push(config);
    }
    async send(command: { input: { Path: string } }) {
      ssm.paths.push(command.input.Path);
      return { Parameters: ssm.parameters[command.input.Path] ?? [] };
    }
  },
  GetParametersByPathCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

// The setup file has loaded config.ts with the real SDK already (harness): load it anew.
let loadConfig: typeof import("./config.ts").loadConfig;
beforeAll(async () => {
  vi.resetModules();
  ({ loadConfig } = await import("./config.ts"));
});

const parameters = (prefix: string, values: Record<string, string>) =>
  Object.entries(values).map(([leaf, Value]) => ({ Name: `${prefix}${leaf}`, Value }));

const database = {
  "db-host": "db.internal",
  "db-name": "kuutti",
  "db-user": "kuutti_app",
  "db-app-password": "placeholder-not-a-secret",
};

// The composed URL by its parts: a connection string with a password in the
// source, placeholder or not, is what the secret scan is there to refuse.
function urlParts(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    user: url.username,
    password: url.password,
    host: url.host,
    database: url.pathname.slice(1),
    sslmode: url.searchParams.get("sslmode"),
  };
}

beforeEach(() => {
  ssm.clients.length = 0;
  ssm.paths.length = 0;
  ssm.parameters = {};
  vi.stubEnv("AWS_REGION", "eu-north-1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("reads nothing from a parameter store in development or test", async () => {
    for (const APP_ENV of [undefined, "development", "test"]) {
      const config = await loadConfig({ APP_ENV, DATABASE_URL: "postgres://localhost/kuutti" });
      expect(config.databaseUrl).toBe("postgres://localhost/kuutti");
    }
    expect(ssm.clients).toEqual([]);
  });

  it.each([
    ["staging", "/kuutti/staging/"],
    ["production", "/kuutti/prod/"],
  ])(
    "on %s reads %s through a client of the configured region, and composes the database from it",
    async (APP_ENV, prefix) => {
      ssm.parameters[prefix] = parameters(prefix, {
        ...database,
        "admin-app-url": "https://admin.kuutti.app",
      });
      const config = await loadConfig({ APP_ENV });
      expect(ssm.paths).toEqual([prefix]);
      expect(ssm.clients).toEqual([{ region: "eu-north-1" }]);
      expect(config.APP_ENV).toBe(APP_ENV);
      expect(urlParts(config.databaseUrl)).toEqual({
        user: "kuutti_app",
        password: "placeholder-not-a-secret",
        host: "db.internal:5432",
        database: "kuutti",
        sslmode: "require",
      });
    },
  );

  it("a preview reads staging's parameters and serves from its own database as the preview role", async () => {
    ssm.parameters["/kuutti/staging/"] = parameters("/kuutti/staging/", {
      ...database,
      "db-preview-user": "kuutti_preview",
      "db-preview-password": "placeholder-preview",
    });
    const config = await loadConfig({ APP_ENV: "preview", PR_NUMBER: "42" });
    expect(ssm.paths).toEqual(["/kuutti/staging/"]);
    expect(urlParts(config.databaseUrl)).toEqual({
      user: "kuutti_preview",
      password: "placeholder-preview",
      host: "db.internal:5432",
      database: "kuutti_pr_42",
      sslmode: "require",
    });
    expect(config.DB_APP_PASSWORD).toBeUndefined();
  });

  it("what the process sets wins over the parameter store", async () => {
    ssm.parameters["/kuutti/staging/"] = parameters("/kuutti/staging/", {
      ...database,
      "log-level": "debug",
    });
    const config = await loadConfig({ APP_ENV: "staging", LOG_LEVEL: "warn" });
    expect(config.LOG_LEVEL).toBe("warn");
  });

  it("a prefix given by name is read in any environment", async () => {
    ssm.parameters["/kuutti/sandbox/"] = parameters("/kuutti/sandbox/", database);
    const config = await loadConfig({
      APP_ENV: "development",
      SSM_PARAMETER_PREFIX: "/kuutti/sandbox/",
    });
    expect(ssm.paths).toEqual(["/kuutti/sandbox/"]);
    expect(config.databaseUrl).toContain("@db.internal:5432/kuutti");
  });

  it("reads the process environment when given nothing", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/from-the-environment");
    vi.stubEnv("SSM_PARAMETER_PREFIX", undefined);
    const config = await loadConfig();
    expect(config.databaseUrl).toBe("postgres://localhost/from-the-environment");
    expect(ssm.clients).toEqual([]);
  });
});
