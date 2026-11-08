import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { nullMembers } from "./lib/openapi.ts";
import { ORIGIN_PROOF_HEADER } from "./lib/origin-proof.ts";
import { TRUSTED_PROXIES, type TrustedProxy } from "./lib/rate-limit.ts";
import { captureLogger, test, testConfig } from "./test/harness.ts";

describe("OpenAPI document", () => {
  test("is served outside production and matches the committed file", async ({ ctx }) => {
    const res = await ctx.app.request("/openapi.json");
    expect(res.status).toBe(200);
    const served = (await res.json()) as {
      info: { version: string };
      paths: Record<string, unknown>;
    };
    const committed = JSON.parse(readFileSync(resolve("openapi.json"), "utf8")) as typeof served;
    // The committed file carries the package version; the served one the build version.
    expect({ ...served, info: { ...served.info, version: "x" } }).toEqual({
      ...committed,
      info: { ...committed.info, version: "x" },
    });
    expect(Object.keys(served.paths)).toContain("/health");
  });

  it("writes a nullable union's null member as 3.1's null type, so the generated type is null and not unknown", () => {
    expect(
      nullMembers({
        a: { oneOf: [{ $ref: "#/x" }, { nullable: true }] },
        b: [{ anyOf: [{ type: "string" }, { nullable: true }] }, null, 1],
        // A nullable member with more in it is a schema of its own, and stays.
        c: { oneOf: [{ type: "object", nullable: true }] },
      }),
    ).toEqual({
      a: { oneOf: [{ $ref: "#/x" }, { type: "null" }] },
      b: [{ anyOf: [{ type: "string" }, { type: "null" }] }, null, 1],
      c: { oneOf: [{ type: "object", nullable: true }] },
    });
  });

  it("is absent in production", async () => {
    const { logger } = await captureLogger();
    const app = createApp({
      config: testConfig({
        APP_ENV: "production",
        NODE_ENV: "production",
        ADMIN_APP_URL: "https://admin.kuutti.app",
      }),
      logger,
      db: { query: async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }) },
    });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(404);
  });
});

// ADR-026, History of 2026-11-06: the document is counted like any other
// path, so a request through somebody else's distribution, which carries no
// proof, meets the bucket of no address here too.
describe("OpenAPI document and the address's window", () => {
  const SECRET = "origin-proof-of-the-test-4711-4711-4711";
  // The document reads no database.
  const db = { query: async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }) };

  async function appOneAMinute(mode: TrustedProxy) {
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

  /** A client at 203.0.113.<n> as each mode reads it: the socket, Traefik's hop, CloudFront's viewer. */
  const ask = (app: ReturnType<typeof createApp>, n: number, proof: boolean) =>
    app.request(
      "/openapi.json",
      {
        headers: {
          "x-forwarded-for": `198.51.100.1, 203.0.113.${n}`,
          "cloudfront-viewer-address": `203.0.113.${n}:4711`,
          ...(proof ? { [ORIGIN_PROOF_HEADER]: SECRET } : {}),
        },
      },
      { incoming: { socket: { remoteAddress: `203.0.113.${n}`, remotePort: 40000 } } },
    );

  it.each(TRUSTED_PROXIES)("behind %s, is counted by the client's address", async (mode) => {
    const app = await appOneAMinute(mode);
    const first = await ask(app, 1, true);
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe("1");
    const again = await ask(app, 1, true);
    expect(again.status).toBe(429);
    // The window's own wait, which the limiter's tests hold to the second.
    expect(again.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(await again.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await ask(app, 2, true)).status).toBe(200);
  });

  it("behind CloudFront, a request without the proof shares the bucket of no address, whatever viewer it names", async () => {
    const app = await appOneAMinute("cloudfront");
    expect((await ask(app, 1, false)).status).toBe(200);
    expect((await ask(app, 2, false)).status).toBe(429);
    // A viewer of Kuutti's distribution keeps a window of its own meanwhile.
    expect((await ask(app, 2, true)).status).toBe(200);
  });
});
