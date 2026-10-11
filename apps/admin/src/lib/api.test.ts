import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiUrl, failed, setTokenSource } from "./api.ts";

// The panel's one client (ADR-003): where it points, the bearer it adds from
// the session's token source, and the error it turns an answer into.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recordRequests() {
  const seen: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      seen.push(input instanceof Request ? input : new Request(input, init));
      return json({ role: "moderator", expiresAt: "2030-01-01T08:00:00.000Z" });
    }),
  );
  return seen;
}

afterEach(() => {
  setTokenSource(() => null);
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("takes the build's address when there is one, in any build", () => {
    expect(apiUrl({ PROD: true, VITE_API_URL: "https://api.example.test" })).toBe(
      "https://api.example.test",
    );
    expect(apiUrl({ PROD: false, VITE_API_URL: "https://api.example.test" })).toBe(
      "https://api.example.test",
    );
  });

  it("falls back to the local API on a development server only", () => {
    expect(apiUrl({ PROD: false })).toBe("http://localhost:3000");
    expect(apiUrl({ PROD: true })).toBeUndefined();
  });
});

describe("the client", () => {
  it("sends the session's token as a bearer when there is one", async () => {
    const seen = recordRequests();
    setTokenSource(() => "t".repeat(43));
    await api.GET("/admin/whoami");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
  });

  it("sends no authorization header when nobody is signed in", async () => {
    const seen = recordRequests();
    await api.GET("/admin/whoami");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("reads the token at request time, so a later sign-in is picked up", async () => {
    const seen = recordRequests();
    let token: string | null = null;
    setTokenSource(() => token);
    await api.GET("/admin/whoami");
    token = "u".repeat(43);
    await api.GET("/admin/whoami");
    expect(seen.map((r) => r.headers.get("authorization"))).toEqual([
      null,
      `Bearer ${"u".repeat(43)}`,
    ]);
  });
});

describe("failed", () => {
  it("carries the status and the envelope's code when the API answered with one", () => {
    const error = failed(
      new Response(null, { status: 403 }),
      { error: { code: "admin_forbidden", message: "Forbidden", requestId: "r-1" } },
      "decision",
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("decision answered 403");
    expect(error.status).toBe(403);
    expect(error.code).toBe("admin_forbidden");
  });

  it("has no code when the answer was not the error envelope (a proxy's page, an empty body)", () => {
    const fromProxy = failed(
      new Response(null, { status: 502 }),
      "<html>Bad gateway</html>",
      "queue",
    );
    expect(fromProxy.message).toBe("queue answered 502");
    expect(fromProxy.status).toBe(502);
    expect(fromProxy.code).toBeUndefined();
    expect(failed(new Response(null, { status: 500 }), undefined, "queue").code).toBeUndefined();
  });
});

describe("a production build without VITE_API_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("has no address, and its client sends nothing anywhere", async () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("VITE_API_URL", undefined);
    vi.resetModules();
    const fresh = await import("./api.ts");
    expect(fresh.API_URL).toBeUndefined();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    // No base: the request has no host to go to, so it fails before leaving the page.
    await expect(fresh.api.GET("/admin/whoami")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
