import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
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
  takeLoginStarted,
} from "./session";

// The device's session (#35): stored in the secure store as one JSON value,
// refreshed once however many requests need it, gone when the API refuses.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
// One instant for the whole file, so two calls with the same arguments are equal.
const BASE = Date.now();
// Any well-formed sign-in verifier (ADR-027): 64 lowercase hex characters.
const VERIFIER = "5a1e".repeat(16);
const OTHER_VERIFIER = "beef".repeat(16);
const TEN_MINUTES = 10 * 60 * 1000;
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

  it("keeps the pending login mark on this device too, with its verifier", async () => {
    await markLoginStarted(VERIFIER, BASE);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "kuutti.session.pending",
      JSON.stringify({ at: BASE, verifier: VERIFIER }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    // Deleted before written, as the session is.
    const order = (fn: unknown) => (fn as jest.Mock).mock.invocationCallOrder.at(-1) ?? 0;
    expect(order(SecureStore.deleteItemAsync)).toBeLessThan(order(SecureStore.setItemAsync));
    await takeLoginStarted(BASE);
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

describe("the pending login mark", () => {
  // What a sign-in attempt leaves on the phone until its code comes back: when
  // it started, and the verifier its code is bound to (ADR-027). Each test
  // starts with none.
  const { __store: store } = jest.requireMock("expo-secure-store") as {
    __store: Map<string, string>;
  };
  beforeEach(async () => {
    await takeLoginStarted();
  });

  it("gives back the verifier of the login it marked, once", async () => {
    await markLoginStarted(VERIFIER, BASE);
    expect(await takeLoginStarted(BASE + 1000)).toBe(VERIFIER);
    expect(await takeLoginStarted(BASE + 2000)).toBeNull();
    expect(store.has("kuutti.session.pending")).toBe(false);
  });

  it("keeps only the latest start's verifier", async () => {
    await markLoginStarted(VERIFIER, BASE);
    await markLoginStarted(OTHER_VERIFIER, BASE + 1000);
    expect(await takeLoginStarted(BASE + 2000)).toBe(OTHER_VERIFIER);
    expect(await takeLoginStarted(BASE + 3000)).toBeNull();
  });

  it("finds the mark in the secure store after the app was ended while the browser was open", async () => {
    store.set("kuutti.session.pending", JSON.stringify({ at: BASE, verifier: VERIFIER }));
    expect(await takeLoginStarted(BASE + 1000)).toBe(VERIFIER);
  });

  it.each([
    ["at its tenth minute", BASE, BASE + TEN_MINUTES, VERIFIER],
    ["just past its ten minutes", BASE, BASE + TEN_MINUTES + 1, null],
    ["started later than now by a clock set back", BASE + 1000, BASE, null],
  ])("holds the mark to its ten minutes, %s", async (_when, at, now, expected) => {
    await markLoginStarted(VERIFIER, at);
    expect(await takeLoginStarted(now)).toBe(expected);
  });

  it.each([
    ["the time alone, as one from before ADR-027", String(BASE)],
    ["not JSON", "{x"],
    ["no verifier", JSON.stringify({ at: BASE })],
    [
      "a verifier the exchange would refuse",
      JSON.stringify({ at: BASE, verifier: "5A1E".repeat(16) }),
    ],
    ["a time that is not a number", JSON.stringify({ at: String(BASE), verifier: VERIFIER })],
    ["null", "null"],
  ])("counts as none a stored mark holding %s", async (_what, value) => {
    store.set("kuutti.session.pending", value);
    expect(await takeLoginStarted(BASE + 1000)).toBeNull();
    expect(store.has("kuutti.session.pending")).toBe(false);
  });

  it("counts an unreadable secure store as no mark", async () => {
    store.set("kuutti.session.pending", JSON.stringify({ at: BASE, verifier: VERIFIER }));
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keychain locked"));
    expect(await takeLoginStarted(BASE + 1000)).toBeNull();
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

describe("without a session", () => {
  it("refreshing asks the API nothing and answers signed out", async () => {
    expect(await refreshSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("on the web preview", () => {
  // No product surface on the web (rule 8): the preview keeps its session in
  // memory only, and the secure store is never asked.
  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "web");
    for (const fn of [
      SecureStore.getItemAsync,
      SecureStore.setItemAsync,
      SecureStore.deleteItemAsync,
    ]) {
      (fn as jest.Mock).mockClear();
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it("keeps the session in memory only", async () => {
    await saveSession(tokens(3));
    expect(await loadSession()).toEqual(tokens(3));
    await clearSession();
    expect(await loadSession()).toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("keeps the login mark in memory, good once", async () => {
    await markLoginStarted(VERIFIER, BASE);
    expect(await takeLoginStarted(BASE + 1000)).toBe(VERIFIER);
    expect(await takeLoginStarted(BASE + 2000)).toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });
});
