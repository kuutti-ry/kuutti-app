import { createPool } from "@kuutti/db";
import { HealthResponse } from "@kuutti/schema";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";

describe("GET /health", () => {
  test("answers 200 with the build identity, db ok and migrations current", async ({ ctx }) => {
    const res = await ctx.app.request("/health");
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({
      status: "ok",
      version: "0.0.0-test",
      commit: "test",
      db: "ok",
      migrations: "current",
    });
  });

  test("offers the source of the running service with its commit (AGPL-3.0 section 13)", async ({
    ctx,
  }) => {
    const body = HealthResponse.parse(await (await ctx.app.request("/health")).json());
    expect(body.source).toBe("https://github.com/kuutti-ry/kuutti-app");
    expect(body.commit).toBe("test");
  });

  test("a deployment that sets SOURCE_URL offers its own source", async () => {
    const { logger } = await captureLogger();
    const pool = createPool({ connectionString: testConfig().databaseUrl, max: 1 });
    try {
      const app = createApp({
        config: testConfig({ SOURCE_URL: "https://codeberg.org/example/kuutti-fork" }),
        logger,
        db: pool,
      });
      const body = HealthResponse.parse(await (await app.request("/health")).json());
      expect(body.source).toBe("https://codeberg.org/example/kuutti-fork");
    } finally {
      await pool.end();
    }
  });

  test("refuses a SOURCE_URL that is not an https URL", () => {
    expect(() => testConfig({ SOURCE_URL: "http://example.com/fork" })).toThrow();
    expect(() => testConfig({ SOURCE_URL: "javascript:alert(1)" })).toThrow();
    expect(() => testConfig({ SOURCE_URL: "not a url" })).toThrow();
  });

  test("answers HEAD without a body", async ({ ctx }) => {
    const res = await ctx.app.request("/health", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("logs the request with its id, route and status", async ({ ctx }) => {
    const res = await ctx.app.request("/health");
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const line = ctx.logs().find((l) => l.msg === "request" && l.requestId === requestId);
    expect(line).toMatchObject({ route: "/health", status: 200, method: "GET" });
    expect(typeof line?.durationMs).toBe("number");
  });

  test("allows an allowlisted origin only", async ({ ctx }) => {
    const allowed = await ctx.app.request("/health", {
      headers: { Origin: "http://localhost:8081" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    const refused = await ctx.app.request("/health", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
    });
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("sets security headers and asks crawlers to stay away", async ({ ctx }) => {
    const res = await ctx.app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("GET /health and the proof of Kuutti's distribution (ADR-066)", () => {
  const SECRET = "origin-proof-of-the-test-4711-4711-4711";

  async function healthOf(
    config: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<HealthResponse> {
    const { logger } = await captureLogger();
    const pool = createPool({ connectionString: testConfig().databaseUrl, max: 1 });
    try {
      const app = createApp({ config: testConfig(config), logger, db: pool });
      return HealthResponse.parse(await (await app.request("/health", { headers })).json());
    } finally {
      await pool.end();
    }
  }

  test("names the mode the process read at boot, and unset with no secret to check", async () => {
    const body = await healthOf({ TRUSTED_PROXY: "traefik" });
    expect(body.trustedProxy).toBe("traefik");
    expect(body.originProof).toBe("unset");
  });

  test("says whether this request carried the proof: missing, wrong or valid", async () => {
    const config = { TRUSTED_PROXY: "cloudfront", ORIGIN_SECRET: SECRET };
    expect((await healthOf(config)).originProof).toBe("missing");
    expect((await healthOf(config, { "x-kuutti-origin": `${SECRET}x` })).originProof).toBe("wrong");
    const proven = await healthOf(config, { "x-kuutti-origin": SECRET });
    expect(proven.originProof).toBe("valid");
    expect(proven.trustedProxy).toBe("cloudfront");
  });

  test("never echoes the secret or the header it came in", async () => {
    const res = await (async () => {
      const { logger } = await captureLogger();
      const pool = createPool({ connectionString: testConfig().databaseUrl, max: 1 });
      try {
        const app = createApp({ config: testConfig({ ORIGIN_SECRET: SECRET }), logger, db: pool });
        return await app.request("/health", { headers: { "x-kuutti-origin": SECRET } });
      } finally {
        await pool.end();
      }
    })();
    expect(await res.text()).not.toContain(SECRET);
    expect([...res.headers.values()].join(" ")).not.toContain(SECRET);
  });
});

describe("GET /health with the database unreachable", () => {
  // A real pg pool pointed at a closed port: connection refused, not a mock.
  const unreachable = createPool({
    connectionString: "postgres://kuutti:kuutti@127.0.0.1:1/kuutti_test",
    max: 1,
    connectionTimeoutMillis: 300,
  });
  afterAll(() => unreachable.end());

  it("answers 503, status degraded, db unreachable", async () => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: unreachable });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = HealthResponse.parse(await res.json());
    expect(body).toMatchObject({ status: "degraded", db: "unreachable", migrations: "pending" });
  });
});
