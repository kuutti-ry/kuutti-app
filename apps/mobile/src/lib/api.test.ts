import type { SessionTokens } from "@kuutti/schema";
import { ApiError, api, fetchHealth } from "./api";
import { clearSession, currentSession, saveSession } from "./session";

// The typed client's own behaviour beyond the session round trip of
// session.test.ts: the health probe, and a token refreshed before it is sent.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const BASE = Date.now();
const tokens = (n: number, accessExpiresInMs: number): SessionTokens => ({
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token(`access${n}`),
  accessExpiresAt: new Date(BASE + accessExpiresInMs).toISOString(),
  refreshToken: token(`refresh${n}`),
  refreshExpiresAt: new Date(BASE + 90 * 24 * 3600 * 1000).toISOString(),
});
const health = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://github.com/kuutti-ry/kuutti-app",
  db: "ok",
  migrations: "current",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = jest.fn<Promise<Response>, [Request | string, RequestInit?]>();
const pathOf = (input: Request | string) =>
  new URL(input instanceof Request ? input.url : input).pathname;

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  await clearSession();
});

describe("fetchHealth", () => {
  it("answers the parsed probe, asked without a session", async () => {
    await saveSession(tokens(1, 15 * 60 * 1000));
    fetchMock.mockResolvedValueOnce(json(health));
    expect(await fetchHealth()).toEqual(health);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(pathOf(request)).toBe("/health");
    expect(request.headers.get("authorization")).toBeNull();
  });

  it("throws an ApiError carrying the status when the API is unwell", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 502),
    );
    const error = await fetchHealth().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toBe("API answered 502");
    expect((error as ApiError).name).toBe("ApiError");
  });
});

describe("a request with a session about to expire", () => {
  it("refreshes the access token first and sends the new one", async () => {
    await saveSession(tokens(1, 10 * 1000));
    fetchMock.mockImplementation(async (input) =>
      pathOf(input) === "/auth/refresh" ? json(tokens(2, 15 * 60 * 1000)) : json({ ok: true }),
    );
    await api.GET("/auth/session");
    expect(fetchMock.mock.calls.map(([input]) => pathOf(input))).toEqual([
      "/auth/refresh",
      "/auth/session",
    ]);
    const sent = fetchMock.mock.calls[1]?.[0] as Request;
    expect(sent.headers.get("authorization")).toBe(`Bearer ${token("access2")}`);
  });

  it("sends the request without a token when the refresh signs the device out", async () => {
    await saveSession(tokens(1, 10 * 1000));
    fetchMock.mockImplementation(async (input) =>
      pathOf(input) === "/auth/refresh"
        ? json({ error: { code: "session_revoked" } }, 401)
        : json({ error: { code: "unauthenticated" } }, 401),
    );
    const { response } = await api.GET("/auth/session");
    expect(response.status).toBe(401);
    const sent = fetchMock.mock.calls[1]?.[0] as Request;
    expect(sent.headers.get("authorization")).toBeNull();
    expect(currentSession()).toBeNull();
    // No second refresh for a request that carried no token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
