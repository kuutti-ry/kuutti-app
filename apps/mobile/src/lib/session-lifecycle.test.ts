import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { api } from "./api";
import {
  clearSession,
  currentSession,
  loadSession,
  onSessionChange,
  refreshSession,
  saveSession,
} from "./session";

// Each gate pauses an actual asynchronous boundary. No timers or real requests
// decide whether an earlier operation finishes before a later sign-in/sign-out.
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const KEY = "kuutti.session";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = (account: number, rotation = 0): SessionTokens => ({
  sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(account).padStart(12, "0")}`,
  accessToken: token(`access${account}v${rotation}`),
  accessExpiresAt: new Date(NOW + 15 * 60 * 1000).toISOString(),
  refreshToken: `${token(`family${account}`)}.${token(`refresh${account}v${rotation}`)}`,
  refreshExpiresAt: new Date(NOW + 90 * 24 * 3600 * 1000).toISOString(),
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = () => json({ error: { code: "session_expired" } }, 401);

const fetchMock = jest.fn<Promise<Response>, [Request | string, RequestInit?]>();
const getMock = jest.mocked(SecureStore.getItemAsync);
const setMock = jest.mocked(SecureStore.setItemAsync);
const deleteMock = jest.mocked(SecureStore.deleteItemAsync);
const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const nativeSession = () => JSON.parse(store.get(KEY) ?? "null") as SessionTokens | null;
const refreshBodies = () =>
  fetchMock.mock.calls
    .filter(([request]) => typeof request === "string")
    .map(([, init]) => JSON.parse(init?.body as string));
const sentOperations = () =>
  fetchMock.mock.calls.flatMap(([request]) =>
    typeof request === "string"
      ? []
      : [{ method: request.method, authorization: request.headers.get("authorization") }],
  );

const unsubscribe: (() => void)[] = [];
function changes() {
  const seen: (SessionTokens | null)[] = [];
  unsubscribe.push(onSessionChange((session) => seen.push(session)));
  return seen;
}

beforeEach(async () => {
  jest.replaceProperty(Platform, "OS", "ios");
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  getMock.mockReset().mockImplementation(async (key) => store.get(key) ?? null);
  setMock.mockReset().mockImplementation(async (key, value) => void store.set(key, value));
  deleteMock.mockReset().mockImplementation(async (key) => void store.delete(key));
  await clearSession();
});

afterEach(() => {
  for (const stop of unsubscribe.splice(0)) stop();
  jest.restoreAllMocks();
});

describe("refreshes that outlive their session", () => {
  it.each([
    [200, "clear"],
    [401, "clear"],
    [500, "clear"],
    [200, "replace"],
    [401, "replace"],
    [500, "replace"],
    [200, "rotate"],
    [401, "rotate"],
    [500, "rotate"],
  ] as const)("ignores a pending %i refresh after %s", async (status, transition) => {
    await saveSession(tokens(1));
    const seen = changes();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const refreshing = refreshSession();
    const next = transition === "clear" ? null : tokens(transition === "replace" ? 2 : 1, 2);
    if (next) await saveSession(next);
    else await clearSession();

    response.resolve(json(status === 200 ? tokens(1, 1) : { error: {} }, status));
    expect(await refreshing).toBeNull();
    expect(currentSession()).toEqual(next);
    expect(nativeSession()).toEqual(next);
    expect(seen).toEqual([next]);
  });

  it("ignores a refresh whose response body arrives after a new sign-in", async () => {
    await saveSession(tokens(1));
    const seen = changes();
    const reading = deferred<void>();
    const body = deferred<SessionTokens>();
    const response = json({});
    jest.spyOn(response, "json").mockImplementation(() => {
      reading.resolve();
      return body.promise;
    });
    fetchMock.mockResolvedValueOnce(response);
    const refreshing = refreshSession();
    await reading.promise;
    await saveSession(tokens(2));
    body.resolve(tokens(1, 1));

    expect(await refreshing).toBeNull();
    expect(currentSession()).toEqual(tokens(2));
    expect(nativeSession()).toEqual(tokens(2));
    expect(seen).toEqual([tokens(2)]);
  });

  it("keeps the replacement session's refresh shared when the old refresh finishes", async () => {
    await saveSession(tokens(1));
    const seen = changes();
    const oldResponse = deferred<Response>();
    const nextResponse = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise)
      .mockResolvedValue(json({ error: {} }, 500));
    const oldRefresh = refreshSession();
    await saveSession(tokens(2));
    const nextRefresh = refreshSession();

    oldResponse.resolve(json(tokens(1, 1)));
    const oldResult = await oldRefresh;
    const joinedRefresh = refreshSession();
    nextResponse.resolve(json(tokens(2, 1)));
    const results = await Promise.all([nextRefresh, joinedRefresh]);

    expect(oldResult).toBeNull();
    expect(results).toEqual([tokens(2, 1), tokens(2, 1)]);
    expect(refreshBodies()).toEqual([
      { refreshToken: tokens(1).refreshToken },
      { refreshToken: tokens(2).refreshToken },
    ]);
    expect(currentSession()).toEqual(tokens(2, 1));
    expect(nativeSession()).toEqual(tokens(2, 1));
    expect(seen).toEqual([tokens(2), tokens(2, 1)]);
  });

  it("does not reuse a refresh after clearing and reinstalling the same session", async () => {
    await saveSession(tokens(1));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const refreshing = refreshSession();
    await clearSession();
    await saveSession(tokens(1));
    const seen = changes();
    response.resolve(json(tokens(1, 1)));

    expect(await refreshing).toBeNull();
    expect(currentSession()).toEqual(tokens(1));
    expect(nativeSession()).toEqual(tokens(1));
    expect(seen).toEqual([]);
  });
});

describe("native session operations in flight", () => {
  it.each([
    ["delete", "clear"],
    ["set", "clear"],
    ["delete", "replace"],
    ["set", "replace"],
  ] as const)("keeps the latest %s-interrupted write after %s", async (boundary, transition) => {
    await saveSession(tokens(1));
    const seen = changes();
    const entered = deferred<void>();
    const release = deferred<void>();
    if (boundary === "delete") {
      deleteMock.mockImplementationOnce(async (key) => {
        entered.resolve();
        await release.promise;
        store.delete(key);
      });
    } else {
      setMock.mockImplementationOnce(async (key, value) => {
        entered.resolve();
        await release.promise;
        store.set(key, value);
      });
    }
    const oldWrite = saveSession(tokens(1, 1));
    await entered.promise;
    const next = transition === "replace" ? tokens(2) : null;
    const latestWrite = next ? saveSession(next) : clearSession();
    const visibleWhilePending = currentSession();
    release.resolve();
    await Promise.all([oldWrite, latestWrite]);

    expect(visibleWhilePending).toEqual(next);
    expect(currentSession()).toEqual(next);
    expect(nativeSession()).toEqual(next);
    expect(seen).toEqual([next]);
  });

  it("finishes an earlier native deletion before storing the replacement", async () => {
    await saveSession(tokens(1));
    const seen = changes();
    const entered = deferred<void>();
    const release = deferred<void>();
    deleteMock.mockImplementationOnce(async (key) => {
      entered.resolve();
      await release.promise;
      store.delete(key);
    });
    const clearing = clearSession();
    await entered.promise;
    const saving = saveSession(tokens(2));
    release.resolve();
    await Promise.all([clearing, saving]);

    expect(currentSession()).toEqual(tokens(2));
    expect(nativeSession()).toEqual(tokens(2));
    expect(seen).toEqual([tokens(2)]);
  });

  it.each(["delete", "set"] as const)("continues after a native %s failure", async (boundary) => {
    const seen = changes();
    const entered = deferred<void>();
    const release = deferred<void>();
    const failure = new Error("synthetic secure-store failure");
    const fail = async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    };
    if (boundary === "delete") deleteMock.mockImplementationOnce(fail);
    else setMock.mockImplementationOnce(fail);
    const failedWrite = saveSession(tokens(1));
    const rejection = expect(failedWrite).rejects.toBe(failure);
    await entered.promise;
    const latestWrite = saveSession(tokens(2));
    release.resolve();
    await rejection;
    await latestWrite;

    expect(currentSession()).toEqual(tokens(2));
    expect(nativeSession()).toEqual(tokens(2));
    expect(seen).toEqual([tokens(2)]);
  });

  it.each([
    ["stored", "replace"],
    ["stored", "clear"],
    ["malformed", "replace"],
    ["rejected", "replace"],
  ] as const)("discards a %s startup read after %s", async (answer, transition) => {
    const read = deferred<string | null>();
    getMock.mockReturnValueOnce(read.promise);
    const loading = loadSession();
    const seen = changes();
    const next = transition === "replace" ? tokens(2) : null;
    if (next) await saveSession(next);
    else await clearSession();
    if (answer === "rejected") read.reject(new Error("synthetic read failure"));
    else read.resolve(answer === "stored" ? JSON.stringify(tokens(1)) : "{invalid");

    expect(await loading).toEqual(next);
    expect(currentSession()).toEqual(next);
    expect(nativeSession()).toEqual(next);
    expect(seen).toEqual([next]);
  });
});

describe("the session that authorizes an API operation", () => {
  it("does not replay an old operation after replacement and a delayed 401", async () => {
    await saveSession(tokens(1));
    const sent = deferred<void>();
    const response = deferred<Response>();
    fetchMock.mockImplementationOnce(() => {
      sent.resolve();
      return response.promise;
    });
    fetchMock.mockImplementation(async (request) =>
      typeof request === "string" ? json(tokens(2, 1)) : new Response(null, { status: 204 }),
    );
    const operation = api.POST("/auth/logout");
    await sent.promise;
    await saveSession(tokens(2));
    const seen = changes();
    response.resolve(unauthorized());
    const result = await operation;

    expect(result.response.status).toBe(401);
    expect(sentOperations()).toEqual([
      { method: "POST", authorization: `Bearer ${tokens(1).accessToken}` },
    ]);
    expect(refreshBodies()).toEqual([]);
    expect(currentSession()).toEqual(tokens(2));
    expect(nativeSession()).toEqual(tokens(2));
    expect(seen).toEqual([]);
  });

  it("does not replay an operation when sign-in changes during its 401 refresh", async () => {
    await saveSession(tokens(1));
    const refreshing = deferred<void>();
    const response = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockImplementationOnce(() => {
        refreshing.resolve();
        return response.promise;
      })
      .mockResolvedValue(new Response(null, { status: 204 }));
    const operation = api.POST("/auth/logout");
    await refreshing.promise;
    await saveSession(tokens(2));
    response.resolve(json(tokens(1, 1)));
    const result = await operation;

    expect(result.response.status).toBe(401);
    expect(sentOperations()).toEqual([
      { method: "POST", authorization: `Bearer ${tokens(1).accessToken}` },
    ]);
    expect(refreshBodies()).toEqual([{ refreshToken: tokens(1).refreshToken }]);
    expect(currentSession()).toEqual(tokens(2));
    expect(nativeSession()).toEqual(tokens(2));
  });

  it("replays after token rotation within the same session", async () => {
    await saveSession(tokens(1));
    const sent = deferred<void>();
    const response = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => {
        sent.resolve();
        return response.promise;
      })
      .mockResolvedValueOnce(json(tokens(1, 2)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const operation = api.POST("/auth/logout");
    await sent.promise;
    await saveSession(tokens(1, 1));
    response.resolve(unauthorized());
    const result = await operation;

    expect(result.response.status).toBe(204);
    expect(sentOperations()).toEqual([
      { method: "POST", authorization: `Bearer ${tokens(1).accessToken}` },
      { method: "POST", authorization: `Bearer ${tokens(1, 2).accessToken}` },
    ]);
    expect(refreshBodies()).toEqual([{ refreshToken: tokens(1, 1).refreshToken }]);
    expect(currentSession()).toEqual(tokens(1, 2));
    expect(nativeSession()).toEqual(tokens(1, 2));
  });
});
