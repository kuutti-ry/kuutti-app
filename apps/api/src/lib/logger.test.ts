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
  it("never writes hetu, email, message text, credentials, a report's note, a message's body or a stored contact", async () => {
    const { logger, lines } = await captureLogger();
    logger.info(
      {
        hetu: "010190-123A",
        email: "a@b.fi",
        message: "hello there",
        authorization: "Bearer secret-token",
        note: "he asked for my number",
        body: "see you at the station",
        value: "+358401234567",
        nested: {
          personal_identity_code: "010190-123A",
          email: "c@d.fi",
          text: "private words",
          note: "she is in year nine",
          body: "my number is in my bio",
          value: "aino.koskinen",
        },
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
      "he asked for my number",
      "she is in year nine",
      "see you at the station",
      "my number is in my bio",
      "+358401234567",
      "aino.koskinen",
    ]) {
      expect(out).not.toContain(forbidden);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain("acc-1");
  });

  it("never writes a postal code or a kept place, at the top of a line or one level down (#514)", async () => {
    const { logger, lines } = await captureLogger();
    logger.info(
      {
        postalCode: "00530",
        homePlace: "00500",
        home_place: "00100",
        update: { postalCode: "83960" },
        account: { homePlace: "422", home_place: "091" },
        accountId: "acc-1",
      },
      "probe",
    );
    const out = JSON.stringify(lines());
    for (const key of ["00530", "00500", "00100", "83960", "422", "091"]) {
      expect(out).not.toContain(`"${key}"`);
    }
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

  it("blanks every line of the stack that is not a frame: a message over several lines too", () => {
    const serialized = serializeError(new Error("the address\na@b.fi\nwas refused"));
    expect(serialized.stack).toMatch(/^Error: \[redacted\]\n\[redacted\]\n\[redacted\]\n\s+at /);
    expect(JSON.stringify(serialized)).not.toContain("a@b.fi");
  });

  it("keeps the type of a named error on the first line", () => {
    const error = new TypeError("cannot read email a@b.fi");
    expect(serializeError(error).stack).toMatch(/^TypeError: \[redacted\]\n\s+at /);
  });

  it("keeps of a database error what names the kind and drops what quotes a value (#636)", async () => {
    // The shape node-postgres gives a unique violation: detail, hint and where carry the values.
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "identity_hetu_hmac_unique"'),
      {
        name: "error",
        severity: "ERROR",
        code: "23505",
        detail: "Key (hetu_hmac)=(0f3a9c…) already exists.",
        hint: "Perhaps you meant a@b.fi",
        where: "SQL statement \"INSERT INTO identity … VALUES ('0f3a9c…')\"",
        internalQuery: "INSERT INTO identity (hetu_hmac) VALUES ('0f3a9c…')",
        schema: "public",
        table: "identity",
        column: "hetu_hmac",
        constraint: "identity_hetu_hmac_unique",
        routine: "_bt_check_unique",
        position: "12",
      },
    );
    const serialized = serializeError(pg);
    expect(Object.keys(serialized).sort()).toEqual(
      [
        "code",
        "column",
        "constraint",
        "message",
        "name",
        "routine",
        "schema",
        "severity",
        "stack",
        "table",
        "type",
      ].sort(),
    );
    expect(serialized).toMatchObject({
      code: "23505",
      constraint: "identity_hetu_hmac_unique",
      table: "identity",
    });
    expect(serialized.stack).toMatch(/^Error: \[redacted\]\n\s+at /);
    const { logger, lines } = await captureLogger();
    logger.error({ err: pg }, "unhandled error");
    const text = JSON.stringify(lines());
    expect(text).not.toContain("0f3a9c");
    expect(text).not.toContain("a@b.fi");
    expect(text).not.toContain("duplicate key value");
  });

  it("serializes a cause the same way, drops a validation error's issues, and keeps an AppError's own detail", async () => {
    const cause = Object.assign(new Error("Key (email)=(a@b.fi)"), {
      detail: "Key (email)=(a@b.fi) already exists.",
      code: "23505",
    });
    const wrapped = Object.assign(new Error("saving the address failed", { cause }), {
      status: 500,
      code: "address_not_saved",
      // The route's own detail, an object, is the log's by design (lib/errors.ts).
      detail: { key: "push_quiet_from_hour" },
      issues: [{ code: "invalid_type", path: ["email"], received: "a@b.fi" }],
    });
    const serialized = serializeError(wrapped) as { cause?: Record<string, unknown> };
    expect(Object.keys(serialized).sort()).toEqual(
      ["cause", "code", "detail", "message", "stack", "status", "type"].sort(),
    );
    expect(serialized).toMatchObject({ detail: { key: "push_quiet_from_hour" } });
    expect(serialized.cause).toMatchObject({ type: "Error", code: "23505", message: "[redacted]" });
    expect(Object.keys(serialized.cause ?? {})).not.toContain("detail");
    // pino writes the cause's message into the stack too, after "caused by:".
    expect((serialized as { stack?: string }).stack).toMatch(/\ncaused by: \[redacted\]\n\s+at /);
    expect(JSON.stringify(serialized)).not.toContain("a@b.fi");
    // Through the logger too: a cause's message is two levels down, past the redaction paths.
    const { logger, lines } = await captureLogger();
    logger.error({ err: wrapped }, "unhandled error");
    expect(JSON.stringify(lines())).not.toContain("a@b.fi");
  });

  it("drops a cause that is no error: a library's object of claims, a database's string", async () => {
    const withClaims = new Error("claim mismatch", {
      cause: { expected: "x", claims: { hetu: "010190-999X", email: "a@b.fi" } },
    });
    const withText = new Error("insert failed", {
      cause: "Key (email)=(a@b.fi) already exists.",
    });
    for (const error of [withClaims, withText]) {
      const serialized = serializeError(error);
      expect(serialized).not.toHaveProperty("cause");
      const { logger, lines } = await captureLogger();
      logger.error({ err: error }, "unhandled error");
      const text = JSON.stringify(lines());
      expect(text).not.toContain("a@b.fi");
      expect(text).not.toContain("010190");
    }
  });

  it("keeps an AWS SDK error's metadata and a kit error's reason", () => {
    const sdk = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $fault: "client",
      $metadata: { httpStatusCode: 403, requestId: "ABC123", attempts: 1 },
    });
    expect(serializeError(sdk)).toMatchObject({
      type: "Error",
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403, requestId: "ABC123" },
    });
    expect(serializeError(sdk)).not.toHaveProperty("$fault");
    const kit = Object.assign(new Error("ID token was not encrypted"), {
      name: "TunnistusError",
      reason: "ID token was not encrypted",
    });
    expect(serializeError(kit)).toMatchObject({
      name: "TunnistusError",
      reason: "ID token was not encrypted",
    });
  });

  it("writes an err or error field that holds no error as it is, null included, and never throws (#102)", async () => {
    // A push refused with no code logs `error: null` (notifications/push.ts).
    const lines: string[] = [];
    const logger = await createLogger({
      level: "info",
      pretty: false,
      destination: { write: (line) => lines.push(line) },
    });
    for (const value of [null, "DeviceNotRegistered", 429, undefined]) {
      expect(() => logger.warn({ error: value, err: value }, "push refused")).not.toThrow();
    }
    expect(lines.map((line) => JSON.parse(line).error)).toEqual([
      null,
      "DeviceNotRegistered",
      429,
      undefined,
    ]);
    expect(serializeError(null)).toBeNull();
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
  const PROOF = "origin-proof-of-the-test-4711-4711-4711";

  it.each(TRUSTED_PROXIES)(
    "behind %s, with every place an address can come from filled, and the address limiter refusing",
    async (trustedProxy) => {
      const { logger, lines } = await captureLogger();
      const app = new Hono<AppEnv>();
      app.use("*", serverRequestId());
      app.use("*", requestLogger(logger, { trustedProxy }));
      app.use(
        "*",
        rateLimit({
          limit: 1,
          windowMs: 60_000,
          keyOf: addressOf({ TRUSTED_PROXY: trustedProxy, originSecrets: [PROOF] }),
          now: () => 0,
        }),
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
                // Through Kuutti's distribution, so CloudFront's viewer address is read (ADR-066).
                "x-kuutti-origin": PROOF,
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
      for (const forbidden of [IPV4, "2001:db8:4711", "4711::", "/64", PROOF]) {
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
