import { describe, expect, it } from "vitest";
import { HealthResponse } from "./health.ts";

const base = {
  status: "ok",
  version: "0.0.0-dev",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://github.com/kuutti-ry/kuutti-app",
  db: "ok",
  migrations: "current",
};

describe("HealthResponse", () => {
  it("accepts the shape the API returns", () => {
    expect(HealthResponse.safeParse(base).success).toBe(true);
  });

  it("accepts the degraded shape", () => {
    expect(
      HealthResponse.safeParse({ ...base, status: "degraded", db: "unreachable" }).success,
    ).toBe(true);
  });

  it("requires the source offer, and only as an https address a client may link", () => {
    const { source: _source, ...withoutSource } = base;
    expect(HealthResponse.safeParse(withoutSource).success).toBe(false);
    for (const source of ["http://example.com/fork", "javascript:alert(1)", "not a url"]) {
      expect(HealthResponse.safeParse({ ...base, source }).success).toBe(false);
    }
  });

  it("rejects an unknown status", () => {
    expect(HealthResponse.safeParse({ ...base, status: "fine" }).success).toBe(false);
  });

  // #198, ADR-066: optional, so an app or panel built before the two fields
  // reads a newer API's answer, and one built after reads an older API's.
  it("reads an answer with or without the proxy mode and the origin proof", () => {
    expect(HealthResponse.safeParse(base).success).toBe(true);
    const parsed = HealthResponse.parse({
      ...base,
      trustedProxy: "cloudfront",
      originProof: "valid",
    });
    expect(parsed.trustedProxy).toBe("cloudfront");
    expect(parsed.originProof).toBe("valid");
    for (const originProof of ["valid", "missing", "wrong", "unset"]) {
      expect(HealthResponse.safeParse({ ...base, originProof }).success).toBe(true);
    }
  });

  it("refuses a proxy mode or a proof it does not know", () => {
    expect(HealthResponse.safeParse({ ...base, trustedProxy: "nginx" }).success).toBe(false);
    expect(HealthResponse.safeParse({ ...base, originProof: "maybe" }).success).toBe(false);
    expect(HealthResponse.safeParse({ ...base, originProof: true }).success).toBe(false);
  });
});
