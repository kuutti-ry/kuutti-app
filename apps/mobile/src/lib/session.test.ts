import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { api, sessionMiddleware } from "./api";
import {
  accessTokenIsStale,
  clearSession,
  currentSession,
  loadSession,
  markLoginStarted,
  onSessionChange,
  refreshSession,
  saveSession,
} from "./session";

// The device's session (#35): stored in the secure store as one JSON value,
// refreshed once however many requests need it, gone when the API refuses.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
// One instant for the whole file, so two calls with the same arguments are equal.
const BASE = Date.now();
const tokens = (n: number, accessExpiresInMs = 15 * 60 * 1000): SessionTokens => ({
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token(`access${n}`),
  accessExpiresAt: new Date(BASE + accessExpiresInMs).toISOString(),
  refreshToken: token(`refresh${n}`),
  refreshExpiresAt: new Date(BASE + 90 * 24 * 3600 * 1000).toISOString(),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = jest.fn<Promise<Response>, [Request | string, RequestInit?]>();

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  await clearSession();
});

describe("session storage", () => {
  it("round-trips through the secure store and tells listeners", async () => {
    const seen: (SessionTokens | null)[] = [];
    const stop = onSessionChange((s) => seen.push(s));
    await saveSession(tokens(1));
    // The item stays on this device: never in a backup or a transfer (#35, the review of 10/10/2026).
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("kuutti.session", expect.any(String), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    // Deleted before written, so an item from before this rule does not keep its old accessibility.
    const order = (fn: unknown) => (fn as jest.Mock).mock.invocationCallOrder.at(-1) ?? 0;
    expect(order(SecureStore.deleteItemAsync)).toBeLessThan(order(SecureStore.setItemAsync));
    expect(await loadSession()).toEqual(tokens(1));
    await clearSession();
    expect(currentSession()).toBeNull();
    expect(seen.map((s) => s?.accessToken ?? null)).toEqual([token("access1"), null]);
    stop();
  });

  it("keeps the pending login mark on this device too", async () => {
    await markLoginStarted(BASE);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("kuutti.session.pending", String(BASE), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });

  it("treats a value that does not parse as no session", async () => {
    await SecureStore.setItemAsync("kuutti.session", "{not json");
    expect(await loadSession()).toBeNull();
  });

  it("calls an access token stale thirty seconds before its expiry", () => {
    expect(accessTokenIsStale(tokens(1, 60 * 1000))).toBe(false);
    expect(accessTokenIsStale(tokens(1, 20 * 1000))).toBe(true);
  });
});

describe("refresh", () => {
  it("refreshes once for concurrent callers and stores the new pair", async () => {
    await saveSession(tokens(1));
    fetchMock.mockResolvedValueOnce(json(tokens(2)));
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/refresh$/);
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: token("refresh1") });
    expect(a?.accessToken).toBe(token("access2"));
    expect(b).toEqual(a);
    expect(currentSession()?.refreshToken).toBe(token("refresh2"));
  });

  it("signs the device out when the API refuses the refresh token", async () => {
    await saveSession(tokens(1));
    fetchMock.mockResolvedValueOnce(json({ error: { code: "session_revoked" } }, 401));
    expect(await refreshSession()).toBeNull();
    expect(currentSession()).toBeNull();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("kuutti.session");
  });

  it("keeps the session when the API is merely down", async () => {
    await saveSession(tokens(1));
    fetchMock.mockResolvedValueOnce(json({ error: { code: "internal_error" } }, 500));
    expect(await refreshSession()).toEqual(tokens(1));
  });
});

describe("the client's session middleware", () => {
  it("attaches the access token, not on the login routes", async () => {
    await saveSession(tokens(1));
    fetchMock.mockImplementation(async (request) =>
      json({ echo: (request as Request).headers.get("authorization") }),
    );
    await api.GET("/auth/session");
    await api.GET("/health");
    const headers = fetchMock.mock.calls.map(([r]) => (r as Request).headers.get("authorization"));
    expect(headers).toEqual([`Bearer ${token("access1")}`, null]);
  });

  it("replays a request once after session_expired with the refreshed token", async () => {
    await saveSession(tokens(1));
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: "session_expired" } }, 401))
      .mockResolvedValueOnce(json(tokens(2)))
      .mockResolvedValueOnce(json({ ok: true }));
    const { response } = await api.GET("/auth/session");
    expect(response.status).toBe(200);
    const replay = fetchMock.mock.calls[2]?.[0] as Request;
    expect(replay.headers.get("authorization")).toBe(`Bearer ${token("access2")}`);
    expect(sessionMiddleware.onResponse).toBeDefined();
  });

  it("signs the device out when a 401 survives the refresh (logged out elsewhere)", async () => {
    await saveSession(tokens(1));
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: "session_revoked" } }, 401))
      .mockResolvedValueOnce(json({ error: { code: "session_revoked" } }, 401));
    const { response } = await api.GET("/auth/session");
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the request, then the one refresh
    expect(currentSession()).toBeNull();
  });

  it("does not refresh for a 401 on a request that carried no token", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "unauthenticated" } }, 401));
    const { response } = await api.GET("/auth/session");
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
