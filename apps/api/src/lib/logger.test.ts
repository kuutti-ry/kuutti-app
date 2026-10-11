import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../test/harness.ts";
import type { AppEnv } from "./env.ts";
import { createLogger, requestLogger, serializeError } from "./logger.ts";
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
