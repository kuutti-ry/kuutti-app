import { createPool, type Queryable } from "@kuutti/db";
import { HealthResponse } from "@kuutti/schema";
import type { QueryResultRow } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ORIGIN_PROOF_HEADER } from "../lib/origin-proof.ts";
import { TRUSTED_PROXIES } from "../lib/rate-limit.ts";
import { captureLogger, test, testConfig } from "../test/harness.ts";

// The secret Kuutti's distribution sends (ADR-066).
const SECRET = "origin-proof-of-the-test-4711-4711-4711";

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

// ADR-026, History of 2026-11-06: /health is outside every window, and a
// request through somebody else's distribution never meets the edge, so one
// check of the database answers every /health asked within its second.
describe("GET /health asks the database at most once a second, one check at a time", () => {
  const T0 = Date.parse("2026-11-06T12:00:00.000Z");
  /** The statement every check opens with (lib/db.ts). */
  const OPENS_A_CHECK = /^SELECT 1\b/;
  /** The migrations' first statement (packages/db), which no timeout races. */
  const ASKS_MIGRATIONS = /to_regclass\('drizzle\.__drizzle_migrations'\)/;

  // A real pg pool pointed at a closed port, as below: connection refused, not a mock.
  const unreachable = createPool({
    connectionString: "postgres://kuutti:kuutti@127.0.0.1:1/kuutti_test",
    max: 1,
    connectionTimeoutMillis: 300,
  });
  afterAll(() => unreachable.end());

  /** The test's connection, counting what /health sends it; `before` runs ahead of each statement. */
  function counting(db: Queryable, before?: (text: string) => Promise<void> | void) {
    let checks = 0;
    let statements = 0;
    const counted: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        statements += 1;
        if (OPENS_A_CHECK.test(text)) checks += 1;
        await before?.(text);
        return db.query<R>(text, values);
      },
    };
    return { db: counted, checks: () => checks, statements: () => statements };
  }

  /** A promise the test opens itself, to hold a statement where it wants. */
  function gate(): { passed: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const passed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { passed, open };
  }

  /** An app on `db` whose clock the test moves; `whenAsked(n)` settles once the clock has been read n times. */
  async function appAt(db: Queryable, config: Record<string, string> = {}) {
    let at = T0;
    let asked = 0;
    const waiting: Array<{ n: number; then: () => void }> = [];
    const { logger, lines } = await captureLogger();
    const app = createApp({
      config: testConfig(config),
      logger,
      db,
      now: () => {
        asked += 1;
        for (const w of waiting) if (w.n === asked) w.then();
        return new Date(at);
      },
    });
    return {
      app,
      lines,
      move: (ms: number) => {
        at += ms;
      },
      whenAsked: (n: number) =>
        new Promise<void>((then) => {
          if (asked >= n) then();
          else waiting.push({ n, then });
        }),
    };
  }

  test("answers every request within its second from one check of the database", async ({
    ctx,
  }) => {
    const counted = counting(ctx.client);
    const { app, move } = await appAt(counted.db);
    const first = await app.request("/health");
    expect(first.status).toBe(200);
    const statementsOfOneCheck = counted.statements();
    expect(statementsOfOneCheck).toBeGreaterThan(0);
    for (let i = 0; i < 4; i += 1) {
      move(249); // 996 ms after the check, at the last of them
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(HealthResponse.parse(await res.json())).toMatchObject({
        status: "ok",
        db: "ok",
        migrations: "current",
      });
    }
    expect(counted.checks()).toBe(1);
    expect(counted.statements()).toBe(statementsOfOneCheck);
  });

  test("asks again once its second is over, at its last millisecond and not before", async ({
    ctx,
  }) => {
    const counted = counting(ctx.client);
    const { app, move } = await appAt(counted.db);
    await app.request("/health");
    move(999);
    await app.request("/health");
    expect(counted.checks()).toBe(1);
    move(1);
    expect((await app.request("/health")).status).toBe(200);
    expect(counted.checks()).toBe(2);
    // The new check has a second of its own.
    move(999);
    await app.request("/health");
    expect(counted.checks()).toBe(2);
  });

  test("shares a check still under way however long it takes, and never runs two at once", async ({
    ctx,
  }) => {
    const reached = gate();
    const release = gate();
    let held = false;
    const counted = counting(ctx.client, async (text) => {
      if (held || !ASKS_MIGRATIONS.test(text)) return;
      held = true;
      reached.open();
      await release.passed;
    });
    const { app, move, whenAsked } = await appAt(counted.db);
    const first = app.request("/health");
    await reached.passed; // the first check is under way, held at the migrations
    move(5_000); // long past its second
    const second = app.request("/health");
    await whenAsked(2); // the second request has read the clock, and so chosen
    expect(counted.checks()).toBe(1);
    release.open();
    const answers = await Promise.all([first, second]);
    expect(answers.map((res) => res.status)).toEqual([200, 200]);
    expect(counted.checks()).toBe(1);
    // Settled, the check was kept for its own second, which is long over.
    expect((await app.request("/health")).status).toBe(200);
    expect(counted.checks()).toBe(2);
  });

  test("starts a check when the clock went back, rather than keeping one for good", async ({
    ctx,
  }) => {
    const counted = counting(ctx.client);
    const { app, move } = await appAt(counted.db);
    await app.request("/health");
    move(-1);
    expect((await app.request("/health")).status).toBe(200);
    expect(counted.checks()).toBe(2);
  });

  test("keeps a database that does not answer for its second, then sees it back", async ({
    ctx,
  }) => {
    let down = true;
    const counted = counting({
      query: <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
        (down ? unreachable : ctx.client).query<R>(text, values),
    });
    const { app, move } = await appAt(counted.db);
    const degraded = { status: "degraded", db: "unreachable", migrations: "pending" };
    const first = await app.request("/health");
    expect(first.status).toBe(503);
    expect(HealthResponse.parse(await first.json())).toMatchObject(degraded);
    down = false;
    move(999);
    const kept = await app.request("/health");
    expect(kept.status).toBe(503);
    expect(HealthResponse.parse(await kept.json())).toMatchObject(degraded);
    expect(counted.checks()).toBe(1);
    move(1);
    const back = await app.request("/health");
    expect(back.status).toBe(200);
    expect(HealthResponse.parse(await back.json())).toMatchObject({ status: "ok", db: "ok" });
    expect(counted.checks()).toBe(2);
  });

  test("keeps a check that failed for its second, each answer the error's own, then tries again", async ({
    ctx,
  }) => {
    let failing = true;
    const counted = counting(ctx.client, (text) => {
      if (failing && ASKS_MIGRATIONS.test(text)) throw new Error("the migrations cannot be read");
    });
    const { app, move, lines } = await appAt(counted.db);
    const first = await app.request("/health");
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: { code: "internal_error" } });
    failing = false;
    move(999);
    const kept = await app.request("/health");
    expect(kept.status).toBe(500);
    expect(counted.checks()).toBe(1);
    const unhandled = lines().filter((l) => l.msg === "unhandled error");
    expect(unhandled.map((l) => l.requestId)).toEqual([
      first.headers.get("x-request-id"),
      kept.headers.get("x-request-id"),
    ]);
    move(1);
    expect((await app.request("/health")).status).toBe(200);
    expect(counted.checks()).toBe(2);
  });

  test.for(TRUSTED_PROXIES)(
    "behind %s, one check answers requests with and without the proof, each with its own",
    async (mode, { ctx }) => {
      const counted = counting(ctx.client);
      const { app } = await appAt(counted.db, { TRUSTED_PROXY: mode, ORIGIN_SECRET: SECRET });
      const proofs: Array<string | undefined> = [];
      for (const sent of [SECRET, undefined, `${SECRET}x`, SECRET]) {
        const res = await app.request("/health", {
          headers: sent === undefined ? {} : { [ORIGIN_PROOF_HEADER]: sent },
        });
        const body = HealthResponse.parse(await res.json());
        expect(body).toMatchObject({ status: "ok", db: "ok", trustedProxy: mode });
        proofs.push(body.originProof);
      }
      expect(proofs).toEqual(["valid", "missing", "wrong", "valid"]);
      expect(counted.checks()).toBe(1);
    },
  );
});

// ADR-026, History of 2026-11-06: the probes' path, and the container's own
// HEALTHCHECK's, which asks from inside the container without the proof.
describe("GET /health and the address's window", () => {
  const VIEWER = "203.0.113.7";
  const through = (proof: boolean) => ({
    headers: {
      "x-forwarded-for": `198.51.100.1, ${VIEWER}`,
      "cloudfront-viewer-address": `${VIEWER}:4711`,
      ...(proof ? { [ORIGIN_PROOF_HEADER]: SECRET } : {}),
    },
  });
  // What @hono/node-server hands a request: the socket it came in on.
  const socket = (remoteAddress: string) => ({
    incoming: { socket: { remoteAddress, remotePort: 40000, remoteFamily: "IPv4" } },
  });

  async function appOneAMinute(mode: (typeof TRUSTED_PROXIES)[number], db: Queryable) {
    const { logger } = await captureLogger();
    return createApp({
      config: testConfig({
        TRUSTED_PROXY: mode,
        ORIGIN_SECRET: SECRET,
        RATE_LIMIT_PER_MINUTE: "1",
      }),
      logger,
      db,
    });
  }

  test.for(TRUSTED_PROXIES)(
    "behind %s, is counted by no window, with the proof or without",
    async (mode, { ctx }) => {
      const app = await appOneAMinute(mode, ctx.client);
      for (const proof of [true, false, true, false]) {
        const res = await app.request("/health", through(proof), socket(VIEWER));
        expect(res.status).toBe(200);
        expect(res.headers.get("ratelimit-limit")).toBeNull();
      }
    },
  );

  test("answers the container's own check while requests without the proof fill the bucket of no address", async ({
    ctx,
  }) => {
    const app = await appOneAMinute("cloudfront", ctx.client);
    // Through somebody else's distribution: no proof, so no address, whatever viewer it names.
    const elsewhere = (viewer: string) => ({
      headers: { "cloudfront-viewer-address": `${viewer}:4711` },
    });
    const edge = socket("10.0.1.7");
    expect((await app.request("/openapi.json", elsewhere("198.51.100.1"), edge)).status).toBe(200);
    expect((await app.request("/openapi.json", elsewhere("198.51.100.2"), edge)).status).toBe(429);
    // apps/api/Dockerfile's HEALTHCHECK: 127.0.0.1 from inside the container, and nothing else.
    const own = await app.request("/health", {}, socket("127.0.0.1"));
    expect(own.status).toBe(200);
    expect(HealthResponse.parse(await own.json())).toMatchObject({
      status: "ok",
      originProof: "missing",
    });
  });
});
