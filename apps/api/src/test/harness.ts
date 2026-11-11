import { createPool, type Pool, type PoolClient, TEST_DATABASE_URL } from "@kuutti/db";
import { createI18n, typedT } from "@kuutti/i18n";
import { test as base } from "vitest";
import { type App, createApp } from "../app.ts";
import { type Config, parseConfig } from "../lib/config.ts";
import { createLogger, type Logger } from "../lib/logger.ts";

/** DATABASE_URL, or the local default of docker compose (#5) and CI, as @kuutti/db gives it. */
export { TEST_DATABASE_URL };

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    APP_VERSION: "0.0.0-test",
    GIT_COMMIT: "test",
    BUILT_AT: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/** English t(), for a function that takes the request's language (the export, #253). */
export const englishT = typedT(createI18n({ locale: "en" }), "en");

export type LogLine = Record<string, unknown> & {
  level?: number;
  msg?: string;
  requestId?: string;
};

/** A logger whose output the test can read back, with production redaction. */
export async function captureLogger(): Promise<{ logger: Logger; lines: () => LogLine[] }> {
  const raw: string[] = [];
  const logger = await createLogger({
    level: "trace",
    pretty: false,
    destination: { write: (line) => raw.push(line) },
  });
  return { logger, lines: () => raw.map((l) => JSON.parse(l) as LogLine) };
}

let pool: Pool | undefined;
export function testPool(): Pool {
  pool ??= createPool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    applicationName: "kuutti-api-test",
  });
  return pool;
}
export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export type TestContext = {
  app: App;
  client: PoolClient;
  logs: () => LogLine[];
};

/**
 * One transaction per test on the real database, rolled back afterwards: no
 * mocked database (CLAUDE.md Testing), no state shared between tests. Routes
 * see `client` as their Queryable, so everything they write vanishes.
 */
export const test = base.extend<{ ctx: TestContext }>({
  // biome-ignore lint/correctness/noEmptyPattern: vitest fixtures declare dependencies by destructuring
  ctx: async ({}, use) => {
    const client = await testPool().connect();
    await client.query("BEGIN");
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: client });
    try {
      await use({ app, client, logs: lines });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  },
});

/** A request's headers with a JSON body. */
export const jsonHeaders = (headers: Record<string, string>) => ({
  ...headers,
  "content-type": "application/json",
});

/** A count the test asks of its own transaction: the first column of the first row. */
export const count = async (ctx: TestContext, sql: string, params: unknown[] = []) =>
  Number((await ctx.client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

/** The configuration for docker compose's S3 stand-in at `endpoint` (CI's compose job, or a developer with the stack up). */
export const composeS3Config = (endpoint: string | undefined) =>
  testConfig({
    S3_ENDPOINT: endpoint,
    S3_BUCKET: process.env.S3_BUCKET ?? "kuutti-media",
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "kuutti",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "kuutti-dev-only",
    S3_FORCE_PATH_STYLE: "true",
  });

export { describe, expect } from "vitest";
