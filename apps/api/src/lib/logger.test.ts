import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../test/harness.ts";
import { type AdminLookup, requireAdmin } from "./admin-middleware.ts";
import { requireSession, type SessionLookup } from "./auth-middleware.ts";
import type { AppEnv } from "./env.ts";
import { createLogger, requestLogger, serializeError } from "./logger.ts";
import { addressOf, personOf, rateLimit, TRUSTED_PROXIES } from "./rate-limit.ts";
import { serverRequestId } from "./request-id.ts";

describe("logger redaction", () => {
  it("never writes hetu, email, message text or credentials", async () => {
    const { logger, lines } = await captureLogger();
    logger.info(
      {
        hetu: "010190-123A",
        email: "a@b.fi",
        message: "hello there",
        authorization: "Bearer secret-token",
        nested: { personal_identity_code: "010190-123A", email: "c@d.fi", text: "private words" },
        accountId: "acc-1",
      },
      "probe",
    );
    const out = JSON.stringify(lines());
    for (const forbidden of [
      "010190-123A",
      "a@b.fi",
      "hello there",
      "secret-token",
      "c@d.fi",
      "private words",
    ]) {
      expect(out).not.toContain(forbidden);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain("acc-1");
  });

  it("keeps stack frames but not the message on the stack's first line", async () => {
    const { logger, lines } = await captureLogger();
    logger.error({ err: new Error("duplicate key value (email)=(a@b.fi)") }, "unhandled error");
    const [line] = lines();
    const err = line?.err as { type?: string; message?: string; stack?: string };
    expect(err.message).toBe("[redacted]");
    expect(err.stack).toMatch(/^Error: \[redacted\]\n\s+at /);
    expect(JSON.stringify(line)).not.toContain("a@b.fi");
  });
});

describe("error serialization", () => {
  it("leaves a logged value that is not an error as it is, and invents no stack", () => {
    expect(serializeError({ code: "E_PLAIN" })).toEqual({ code: "E_PLAIN" });
  });

  it("names an error-like value without a type of its own Error on the stack's first line", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
      message: "duplicate key value (email)=(a@b.fi)",
      stack: "duplicate key value (email)=(a@b.fi)\n    at handler (routes.ts:1:1)",
    });
    const serialized = serializeError(bare);
    expect(serialized.type).toBeUndefined();
    expect(serialized.stack).toBe("Error: [redacted]\n    at handler (routes.ts:1:1)");
  });

  it("keeps the type of a named error on the first line", () => {
    const error = new TypeError("cannot read email a@b.fi");
    expect(serializeError(error).stack).toMatch(/^TypeError: \[redacted\]\n\s+at /);
  });
});

describe("request log line", () => {
  async function logged(
    options: Parameters<typeof requestLogger>[1] | undefined,
    headers: Record<string, string> = {},
  ) {
    const { logger, lines } = await captureLogger();
    const app = new Hono<AppEnv>();
    app.use("*", serverRequestId());
    app.use("*", options ? requestLogger(logger, options) : requestLogger(logger));
    app.get("/items/:id", (c) => c.text("ok"));
    const res = await app.request("/items/7", { headers });
    const line = lines().find((l) => l.msg === "request");
    return { line, requestId: res.headers.get("x-request-id") };
  }

  it("carries the ids, the route pattern, the status and the time taken, never the path's values", async () => {
    const { line, requestId } = await logged(undefined, { "x-amz-cf-id": "abcDEF123_-=" });
    expect(line).toMatchObject({
      level: 30,
      requestId,
      method: "GET",
      route: "/items/:id",
      status: 200,
      durationMs: expect.any(Number),
    });
    // Nothing fronts a process with the default: CloudFront's header is anybody's and is not logged.
    expect(line).not.toHaveProperty("cfRequestId");
    expect(JSON.stringify(line)).not.toContain("/items/7");
  });

  it("behind Traefik, CloudFront's header is not taken either", async () => {
    const { line } = await logged({ trustedProxy: "traefik" }, { "x-amz-cf-id": "abcDEF123_-=" });
    expect(line).not.toHaveProperty("cfRequestId");
  });

  it("behind CloudFront, its request id is logged beside ours when it looks like one", async () => {
    const valid = await logged({ trustedProxy: "cloudfront" }, { "x-amz-cf-id": "abcDEF123_-=" });
    expect(valid.line).toMatchObject({ cfRequestId: "abcDEF123_-=", requestId: valid.requestId });
    const planted = await logged(
      { trustedProxy: "cloudfront" },
      { "x-amz-cf-id": "a@b.fi; injected=line" },
    );
    expect(planted.line).not.toHaveProperty("cfRequestId");
    expect(JSON.stringify(planted.line)).not.toContain("a@b.fi");
  });
});

describe("request log line: who asked (ADR-026 §7)", () => {
  // 43 characters of base64url, the shape of either token.
  const TOKEN = `${"Q".repeat(40)}_-9`;
  const DB = { query: () => Promise.reject(new Error("the guards' stores are the only readers")) };
  const FAR = new Date("2999-01-01T00:00:00.000Z");
  const account: SessionLookup = {
    accountId: "acc-1",
    sessionId: "ses-1",
    accessExpiresAt: FAR,
    revokedAt: null,
    accountState: "active",
    identityStanding: "ok",
  };
  const staff: AdminLookup = {
    sessionId: "adm-ses-1",
    identityId: "idn-1",
    role: "moderator",
    currentRole: "moderator",
    expiresAt: FAR,
    revokedAt: null,
    identityStanding: "ok",
  };

  async function asked(path: "/me" | "/queue" | "/open", limit = 10) {
    const { logger, lines } = await captureLogger();
    const app = new Hono<AppEnv>();
    app.use("*", serverRequestId());
    app.use("*", requestLogger(logger));
    const touch = async () => {};
    // One person's limiter behind both guards, as app.ts builds it.
    const perPerson = rateLimit({ limit, windowMs: 60_000, keyOf: personOf });
    app.use(
      "/me",
      requireSession({
        db: DB,
        store: { findByAccessHash: async () => account, touch },
        limit: perPerson,
      }),
    );
    app.use(
      "/queue",
      requireAdmin({
        db: DB,
        store: { findByAccessHash: async () => staff, touch },
        roles: ["moderator"],
        limit: perPerson,
      }),
    );
    for (const route of ["/me", "/queue", "/open"]) app.get(route, (c) => c.text("ok"));
    const headers = { authorization: `Bearer ${TOKEN}` };
    const statuses = [
      (await app.request(path, { headers })).status,
      (await app.request(path, { headers })).status,
    ];
    return { statuses, requests: lines().filter((l) => l.msg === "request") };
  }

  it("carries the account after the session guard, and no staff identity", async () => {
    const { requests } = await asked("/me");
    expect(requests[0]).toMatchObject({ accountId: "acc-1", status: 200 });
    expect(requests[0]).not.toHaveProperty("staffIdentityId");
  });

  it("carries the staff identity after the staff guard, and no account", async () => {
    const { requests } = await asked("/queue");
    expect(requests[0]).toMatchObject({ staffIdentityId: "idn-1", status: 200 });
    expect(requests[0]).not.toHaveProperty("accountId");
  });

  it("names the person a refusal of the person's limiter was for", async () => {
    const forStaff = await asked("/queue", 1);
    expect(forStaff.statuses).toEqual([200, 429]);
    expect(forStaff.requests[1]).toMatchObject({ staffIdentityId: "idn-1", status: 429 });
    const forAccount = await asked("/me", 1);
    expect(forAccount.statuses).toEqual([200, 429]);
    expect(forAccount.requests[1]).toMatchObject({ accountId: "acc-1", status: 429 });
  });

  it("carries neither where no guard ran", async () => {
    const { requests } = await asked("/open");
    expect(requests[0]).not.toHaveProperty("accountId");
    expect(requests[0]).not.toHaveProperty("staffIdentityId");
  });
});

describe("request log line: never the client's address (ADR-026 §7)", () => {
  const IPV4 = "203.0.113.47";
  const IPV6 = "2001:db8:4711::47";

  it.each(TRUSTED_PROXIES)(
    "behind %s, with every place an address can come from filled, and the address limiter refusing",
    async (trustedProxy) => {
      const { logger, lines } = await captureLogger();
      const app = new Hono<AppEnv>();
      app.use("*", serverRequestId());
      app.use("*", requestLogger(logger, { trustedProxy }));
      app.use(
        "*",
        rateLimit({ limit: 1, windowMs: 60_000, keyOf: addressOf(trustedProxy), now: () => 0 }),
      );
      app.get("/items/:id", (c) => c.text("ok"));
      for (const [hop, viewer, remoteAddress] of [
        [`${IPV6}, ${IPV4}`, `${IPV4}:4711`, `::ffff:${IPV4}`],
        [`${IPV4}, ${IPV6}`, `${IPV6}:4711`, IPV6],
      ] as const) {
        const statuses: number[] = [];
        for (let i = 0; i < 2; i += 1) {
          const res = await app.request(
            "/items/7",
            {
              headers: {
                "x-forwarded-for": hop,
                "cloudfront-viewer-address": viewer,
                "x-amz-cf-id": "abcDEF123_-=",
              },
            },
            { incoming: { socket: { remoteAddress, remotePort: 40000, remoteFamily: "IPv6" } } },
          );
          statuses.push(res.status);
        }
        // The address was read and counted, so it was there to leak.
        expect(statuses).toEqual([200, 429]);
      }
      const out = JSON.stringify(lines());
      expect(lines().filter((l) => l.msg === "request")).toHaveLength(4);
      for (const forbidden of [IPV4, "2001:db8:4711", "4711::", "/64"]) {
        expect(out).not.toContain(forbidden);
      }
    },
  );
});

describe("the deployed logger", () => {
  it("writes to standard output, where the container's log driver reads it, at the configured level", async () => {
    const logger = await createLogger({ level: "warn", pretty: false });
    const stream = (logger as unknown as Record<symbol, { fd?: number } | undefined>)[
      pino.symbols.streamSym
    ];
    expect(stream?.fd).toBe(1);
    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("info")).toBe(false);
  });
});
