import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { nullMembers } from "./lib/openapi.ts";
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
