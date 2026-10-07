import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, ssmPrefix } from "./config.ts";

describe("parseConfig", () => {
  it("fails without a database and names the key", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    try {
      parseConfig({});
    } catch (error) {
      expect((error as ConfigError).missing).toContain("DATABASE_URL");
    }
  });

  it("names every invalid key", () => {
    try {
      parseConfig({ DATABASE_URL: "postgres://x", PORT: "not-a-port", LOG_LEVEL: "loud" });
      throw new Error("expected ConfigError");
    } catch (error) {
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("PORT");
      expect(issues).toContain("LOG_LEVEL");
    }
  });

  it("composes DATABASE_URL from the SSM-shaped parts", () => {
    const config = parseConfig({
      DB_HOST: "rds.internal",
      DB_NAME: "kuutti",
      DB_USER: "app",
      DB_APP_PASSWORD: "p@ss word",
      APP_ENV: "staging",
    });
    const url = new URL(config.databaseUrl);
    expect(url.protocol).toBe("postgres:");
    expect(url.username).toBe("app");
    expect(decodeURIComponent(url.password)).toBe("p@ss word");
    expect(url.hostname).toBe("rds.internal");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/kuutti");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(config.corsAllowedOrigins.size).toBe(0);
  });

  it("keeps the Sentry self-test off unless it is asked for by name", () => {
    expect(parseConfig({ DATABASE_URL: "postgres://x" }).SENTRY_SELF_TEST).toBe(false);
    expect(
      parseConfig({ DATABASE_URL: "postgres://x", SENTRY_SELF_TEST: "true" }).SENTRY_SELF_TEST,
    ).toBe(true);
    expect(() => parseConfig({ DATABASE_URL: "postgres://x", SENTRY_SELF_TEST: "1" })).toThrow();
  });

  it("allows the Metro and admin dev origins in development only, and named origins when set", () => {
    expect([...parseConfig({ DATABASE_URL: "postgres://x" }).corsAllowedOrigins]).toEqual([
      "http://localhost:8081",
      "http://localhost:5173",
    ]);
    // A deployed environment allows nothing it was not told to.
    expect([
      ...parseConfig({ DATABASE_URL: "postgres://x", APP_ENV: "staging" }).corsAllowedOrigins,
    ]).toEqual([]);
    const named = parseConfig({
      DATABASE_URL: "postgres://x",
      CORS_ALLOWED_ORIGINS: "https://admin.kuutti.fi, https://kuutti.fi",
    });
    expect([...named.corsAllowedOrigins]).toEqual(["https://admin.kuutti.fi", "https://kuutti.fi"]);
  });

  it("allows only https browser origins in production", () => {
    expect(() =>
      parseConfig({
        DATABASE_URL: "postgres://x",
        APP_ENV: "production",
        ADMIN_APP_URL: "https://admin.kuutti.app",
        CORS_ALLOWED_ORIGINS: "https://admin.kuutti.app, http://localhost:5173",
      }),
    ).toThrow(/https origins only/);
    expect(
      parseConfig({
        DATABASE_URL: "postgres://x",
        APP_ENV: "staging",
        CORS_ALLOWED_ORIGINS: "http://localhost:5173",
      }).corsAllowedOrigins.has("http://localhost:5173"),
    ).toBe(true);
  });

  it("takes the placeholder HMAC key in development only", () => {
    const zeros = "0".repeat(64);
    expect(parseConfig({ DATABASE_URL: "postgres://x", HETU_HMAC_KEY: zeros }).HETU_HMAC_KEY).toBe(
      zeros,
    );
    for (const APP_ENV of ["staging", "production"]) {
      expect(() =>
        parseConfig({ DATABASE_URL: "postgres://x", APP_ENV, HETU_HMAC_KEY: zeros }),
      ).toThrow(/placeholder/);
    }
    expect(() =>
      parseConfig({ DATABASE_URL: "postgres://x", HETU_HMAC_KEY: "ab".repeat(31) }),
    ).toThrow(/32 bytes/);
  });
});

describe("parseConfig for the staff login (#49)", () => {
  it("defaults the panel's address to Vite locally and refuses that default in production", () => {
    expect(parseConfig({ DATABASE_URL: "postgres://x" }).ADMIN_APP_URL).toBe(
      "http://localhost:5173",
    );
    expect(() =>
      parseConfig({ APP_ENV: "production", NODE_ENV: "production", DATABASE_URL: "postgres://x" }),
    ).toThrow(/ADMIN_APP_URL: production needs/);
    expect(
      parseConfig({
        APP_ENV: "production",
        NODE_ENV: "production",
        DATABASE_URL: "postgres://x",
        ADMIN_APP_URL: "https://admin.kuutti.app",
      }).ADMIN_APP_URL,
    ).toBe("https://admin.kuutti.app");
  });
});

describe("parseConfig for a pull-request preview", () => {
  const staging = {
    APP_ENV: "preview",
    DB_HOST: "rds.internal",
    DB_NAME: "kuutti",
    DB_USER: "kuutti_app",
    DB_APP_PASSWORD: "app-secret",
    DB_PREVIEW_USER: "kuutti_preview",
    DB_PREVIEW_PASSWORD: "preview-secret",
  };

  it("serves kuutti_pr_<n> as the preview role and creates it through the maintenance database", () => {
    const config = parseConfig({ ...staging, PR_NUMBER: "42" });
    expect(config.preview).toEqual({
      prNumber: "42",
      database: "kuutti_pr_42",
      adminDatabaseUrl: config.preview?.adminDatabaseUrl,
    });
    const url = new URL(config.databaseUrl);
    expect(url.pathname).toBe("/kuutti_pr_42");
    expect(url.username).toBe("kuutti_preview");
    expect(decodeURIComponent(url.password)).toBe("preview-secret");
    expect(url.searchParams.get("sslmode")).toBe("require");
    const admin = new URL(config.preview?.adminDatabaseUrl ?? "");
    expect(admin.pathname).toBe("/postgres");
    expect(admin.username).toBe("kuutti_preview");
    expect(config.databaseUrl).not.toContain("app-secret");
  });

  it("never falls back to the application role", () => {
    const { DB_PREVIEW_USER: _u, DB_PREVIEW_PASSWORD: _p, ...withoutPreviewRole } = staging;
    expect(() => parseConfig({ ...withoutPreviewRole, PR_NUMBER: "42" })).toThrow(
      /DB_PREVIEW_USER and DB_PREVIEW_PASSWORD/,
    );
  });

  it("refuses a database URL that does not parse without echoing it", () => {
    try {
      parseConfig({ APP_ENV: "preview", PR_NUMBER: "1", DATABASE_URL: "not a url with s3cret" });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(JSON.stringify(error)).not.toContain("s3cret");
      expect(String(error)).not.toContain("s3cret");
    }
  });

  it("throttles harder than staging unless told otherwise", () => {
    expect(parseConfig({ ...staging, PR_NUMBER: "1" }).RATE_LIMIT_PER_MINUTE).toBe(30);
    expect(
      parseConfig({ DATABASE_URL: "postgres://x", APP_ENV: "staging" }).RATE_LIMIT_PER_MINUTE,
    ).toBe(120);
    expect(
      parseConfig({ ...staging, PR_NUMBER: "1", RATE_LIMIT_PER_MINUTE: "5" }).RATE_LIMIT_PER_MINUTE,
    ).toBe(5);
  });

  it("refuses a preview without a pull request number", () => {
    expect(() => parseConfig(staging)).toThrow(/PR_NUMBER/);
  });

  it("refuses a pull request number outside APP_ENV=preview", () => {
    for (const appEnv of ["staging", "production", "development"]) {
      expect(() =>
        parseConfig({ DATABASE_URL: "postgres://x", APP_ENV: appEnv, PR_NUMBER: "7" }),
      ).toThrow(/only valid with APP_ENV=preview/);
    }
  });

  it("refuses a pull request number that is not a number", () => {
    expect(() => parseConfig({ ...staging, PR_NUMBER: "7; DROP DATABASE kuutti" })).toThrow(
      ConfigError,
    );
  });
});

describe("boot", () => {
  it("exits non-zero and prints the missing key names when configuration is incomplete", async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      APP_ENV: "test",
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env,
      cwd: process.cwd(),
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain("Configuration invalid");
    expect(stderr).toContain("DATABASE_URL");
  });
});

describe("ssmPrefix", () => {
  it("follows the infrastructure's environment names: production reads /kuutti/prod/", () => {
    expect(ssmPrefix("staging")).toBe("/kuutti/staging/");
    expect(ssmPrefix("production")).toBe("/kuutti/prod/");
  });

  it("points previews at the staging parameters", () => {
    expect(ssmPrefix("preview")).toBe("/kuutti/staging/");
  });

  it("verifies the RDS certificate and host name when the bundle path is set", () => {
    const config = parseConfig({
      APP_ENV: "staging",
      DB_HOST: "rds.internal",
      DB_NAME: "kuutti",
      DB_USER: "kuutti_app",
      DB_APP_PASSWORD: "s3cret",
      DB_SSL_ROOT_CERT: "/app/certs/rds-eu-central-1-bundle.pem",
    });
    const url = new URL(config.databaseUrl);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("sslrootcert")).toBe("/app/certs/rds-eu-central-1-bundle.pem");
  });

  it("drops the environment's application password from a preview's config", () => {
    const config = parseConfig({
      APP_ENV: "preview",
      PR_NUMBER: "42",
      DB_HOST: "rds.internal",
      DB_NAME: "kuutti",
      DB_USER: "kuutti_app",
      DB_APP_PASSWORD: "staging-secret",
      DB_PREVIEW_USER: "kuutti_preview",
      DB_PREVIEW_PASSWORD: "preview-secret",
    });
    expect(config.DB_APP_PASSWORD).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("staging-secret");
    expect(new URL(config.databaseUrl).username).toBe("kuutti_preview");
  });

  it("drops the Telia client, both private keys and the HMAC key from a preview's config (ADR-014 §1)", () => {
    const config = parseConfig({
      APP_ENV: "preview",
      PR_NUMBER: "42",
      DB_HOST: "rds.internal",
      DB_NAME: "kuutti",
      DB_USER: "kuutti_app",
      DB_PREVIEW_USER: "kuutti_preview",
      DB_PREVIEW_PASSWORD: "preview-secret",
      OIDC_ISSUER: "https://tunnistus-pp.telia.fi/uas",
      OIDC_CLIENT_ID: "0043b426-2e6d-466d-b82f-33bb7d3cb6ea",
      OIDC_REDIRECT_URI: "https://api.staging.kuutti.app/auth/callback",
      OIDC_ACR_VALUES: "http://ftn.ficora.fi/2017/loatest2",
      // Stand-ins, not PEM: the lint job refuses anything shaped like a private key.
      TELIA_SIGNING_KEY: "sig-material",
      TELIA_ENCRYPTION_KEY: "enc-material",
      HETU_HMAC_KEY: "a".repeat(64),
    });
    expect(config.OIDC_ISSUER).toBeUndefined();
    expect(config.OIDC_CLIENT_ID).toBeUndefined();
    expect(config.OIDC_REDIRECT_URI).toBeUndefined();
    expect(config.OIDC_ACR_VALUES).toBeUndefined();
    expect(config.TELIA_SIGNING_KEY).toBeUndefined();
    expect(config.TELIA_ENCRYPTION_KEY).toBeUndefined();
    expect(config.HETU_HMAC_KEY).toBeUndefined();
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain("sig-material");
    expect(serialised).not.toContain("enc-material");
    expect(serialised).not.toContain("a".repeat(64));
  });

  it("leaves the Telia configuration to staging and production", () => {
    const config = parseConfig({
      APP_ENV: "staging",
      DB_HOST: "rds.internal",
      DB_NAME: "kuutti",
      DB_USER: "kuutti_app",
      DB_APP_PASSWORD: "app-secret",
      ADMIN_APP_URL: "https://admin.staging.kuutti.app",
      OIDC_ISSUER: "https://tunnistus-pp.telia.fi/uas",
      OIDC_CLIENT_ID: "0043b426-2e6d-466d-b82f-33bb7d3cb6ea",
      OIDC_REDIRECT_URI: "https://api.staging.kuutti.app/auth/callback",
      OIDC_ACR_VALUES: "http://ftn.ficora.fi/2017/loatest2",
      HETU_HMAC_KEY: "a".repeat(64),
    });
    expect(config.OIDC_ISSUER).toBe("https://tunnistus-pp.telia.fi/uas");
    expect(config.OIDC_REDIRECT_URI).toBe("https://api.staging.kuutti.app/auth/callback");
    expect(config.HETU_HMAC_KEY).toBe("a".repeat(64));
  });
});
