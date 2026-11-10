import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { api, sessionMiddleware } from "./api";
import { assert } from "./app-attest";
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
  refreshToken: `${token("family")}.${token(`refresh${n}`)}`,
  refreshExpiresAt: new Date(BASE + 90 * 24 * 3600 * 1000).toISOString(),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = jest.fn<Promise<Response>, [Request | string, RequestInit?]>();

// The phone's App Attest key (ADR-069): its own tests are app-attest.test.ts.
// Here it signs what a test tells it to, and nothing unless told.
jest.mock("./app-attest", () => ({ assert: jest.fn() }));
const assertMock = assert as jest.Mock;
const KEY_ID = `${"k".repeat(43)}=`;
const ASSERTION = "omlzaWduYXR1cmU=";

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  assertMock.mockReset().mockResolvedValue({ assertion: null, retry: false });
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

  it("keeps the identifier of the session's App Attest key with the tokens, on this device (ADR-069)", async () => {
    await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
    expect(await loadSession()).toEqual({ ...tokens(1), attestKeyId: KEY_ID });
    expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith(
      "kuutti.session",
      JSON.stringify({ ...tokens(1), attestKeyId: KEY_ID }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  });

  it("treats a stored session whose key identifier is no key identifier as no session", async () => {
    const odd = { ...tokens(1), attestKeyId: "AAAA" };
    await SecureStore.setItemAsync("kuutti.session", JSON.stringify(odd));
    expect(await loadSession()).toBeNull();
  });

  it("treats a session stored before ADR-059, whose refresh token was one part, as no session", async () => {
    // The deploy of #490 ended every such session; the phone goes to the bank without asking the API.
    const before = { ...tokens(1), refreshToken: token("refresh1") };
    await SecureStore.setItemAsync("kuutti.session", JSON.stringify(before));
    expect(await loadSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: `${token("family")}.${token("refresh1")}`,
    });
    expect(a?.accessToken).toBe(token("access2"));
    expect(b).toEqual(a);
    expect(currentSession()?.refreshToken).toBe(tokens(2).refreshToken);
  });

  it("asks no key for an assertion when the session began without one", async () => {
    await saveSession(tokens(1));
    fetchMock.mockResolvedValueOnce(json(tokens(2)));
    await refreshSession();
    expect(assertMock).not.toHaveBeenCalled();
    expect(currentSession()).toEqual(tokens(2));
  });

  it("refreshes a session that began with an attestation with its key's assertion over the refresh token, and keeps the key", async () => {
    await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
    assertMock.mockResolvedValueOnce({ assertion: ASSERTION });
    fetchMock.mockResolvedValueOnce(json(tokens(2)));
    const next = await refreshSession();
    expect(assertMock).toHaveBeenCalledWith(KEY_ID, tokens(1).refreshToken);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      refreshToken: tokens(1).refreshToken,
      assertion: ASSERTION,
    });
    // The rotation's answer names no key: the phone keeps it for the next one.
    expect(next).toEqual({ ...tokens(2), attestKeyId: KEY_ID });
    expect(await loadSession()).toEqual({ ...tokens(2), attestKeyId: KEY_ID });
    assertMock.mockResolvedValueOnce({ assertion: ASSERTION });
    fetchMock.mockResolvedValueOnce(json(tokens(3)));
    await refreshSession();
    expect(assertMock).toHaveBeenLastCalledWith(KEY_ID, tokens(2).refreshToken);
  });

  it("refreshes without an assertion when the key is gone, and is signed out when the API refuses that", async () => {
    await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
    fetchMock.mockResolvedValueOnce(json({ error: { code: "session_revoked" } }, 401));
    expect(await refreshSession()).toBeNull();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: tokens(1).refreshToken });
    expect(currentSession()).toBeNull();
  });

  it("asks the API nothing when the device was signed out while its key was signing", async () => {
    await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
    let signed!: (made: { assertion: string }) => void;
    assertMock.mockReturnValueOnce(
      new Promise<{ assertion: string }>((resolve) => {
        signed = resolve;
      }),
    );
    const refreshing = refreshSession();
    await clearSession();
    signed({ assertion: ASSERTION });
    expect(await refreshing).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("a key that does not sign this once (ADR-069 §3)", () => {
    const LATER = { assertion: null, retry: true };
    let now = BASE;
    beforeEach(() => {
      now = BASE;
      jest.spyOn(Date, "now").mockImplementation(() => now);
    });
    afterEach(() => jest.restoreAllMocks());

    it("keeps the session and asks the API nothing, so that no hiccup costs a bank login", async () => {
      await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
      assertMock.mockResolvedValue(LATER);
      expect(await refreshSession()).toEqual({ ...tokens(1), attestKeyId: KEY_ID });
      now += 59_999;
      expect(await refreshSession()).toEqual({ ...tokens(1), attestKeyId: KEY_ID });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(currentSession()).toEqual({ ...tokens(1), attestKeyId: KEY_ID });
    });

    it("refreshes with the assertion as soon as the key signs again", async () => {
      await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
      assertMock.mockResolvedValueOnce(LATER);
      await refreshSession();
      assertMock.mockResolvedValueOnce({ assertion: ASSERTION });
      fetchMock.mockResolvedValueOnce(json(tokens(2)));
      expect(await refreshSession()).toEqual({ ...tokens(2), attestKeyId: KEY_ID });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).assertion).toBe(ASSERTION);
    });

    it("goes without after a minute of that, and lets the API end the wait", async () => {
      await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
      assertMock.mockResolvedValue(LATER);
      await refreshSession();
      now += 60_000;
      fetchMock.mockResolvedValueOnce(json({ error: { code: "session_revoked" } }, 401));
      expect(await refreshSession()).toBeNull();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ refreshToken: tokens(1).refreshToken });
      expect(currentSession()).toBeNull();
    });

    it("counts the minute anew after a refresh that went through, and for another session", async () => {
      await saveSession({ ...tokens(1), attestKeyId: KEY_ID });
      assertMock.mockResolvedValueOnce(LATER);
      await refreshSession();
      now += 50_000;
      assertMock.mockResolvedValueOnce({ assertion: ASSERTION });
      fetchMock.mockResolvedValueOnce(json(tokens(2)));
      await refreshSession();
      // Fifty seconds into the first trouble, and past it: a new minute starts here.
      now += 50_000;
      assertMock.mockResolvedValue(LATER);
      expect(await refreshSession()).toEqual({ ...tokens(2), attestKeyId: KEY_ID });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Signed out and in again while the key was failing: the new session's minute is its own.
      now += 50_000;
      await clearSession();
      await saveSession({ ...tokens(4), attestKeyId: KEY_ID });
      now += 50_000;
      expect(await refreshSession()).toEqual({ ...tokens(4), attestKeyId: KEY_ID });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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
