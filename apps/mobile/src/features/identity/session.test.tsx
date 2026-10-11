import { act, renderHook, waitFor } from "@testing-library/react-native";
import { ApiError } from "@/lib/api";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { SessionProvider, useSession } from "./session";

// Whether this device is signed in (#35, #51): read from the store at start,
// the exchange of the bank login's one-time code, the three ways out, the
// export, and a store change from elsewhere (a refresh refused) followed.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const SESSION_ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const tokens = (seed = "a", sessionId = SESSION_ID) => ({
  sessionId,
  accessToken: token(`access${seed}`),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token(`refresh${seed}`),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
});
const EXPORTED = {
  exportedAt: "2026-09-26T10:00:00.000Z",
  account: {
    id: "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
    state: "active",
    registeredAt: "2026-09-01T00:00:00.000Z",
    birthYear: 1990,
    birthMonth: 6,
    gender: null,
    pond: null,
    genderChangedAt: null,
    seeksChangedAt: null,
    email: null,
  },
  identity: {
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastBankLoginAt: null,
    loginLevel: null,
    deletionCount: 0,
  },
  sessions: [],
  profile: null,
  preferences: { seeks: null, ageWindow: null },
  dealBreakers: [],
  consents: [],
  photos: [],
  photoAccessLog: [],
  research: { enrolled: false, since: null, consentVersion: null, events: [] },
  gate: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);

type Seen = { method: string; path: string; body: unknown };
/** Answers by "METHOD /path"; a missing route is a network failure. */
function serve(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    seen.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    const route = routes[`${request.method} ${path}`];
    if (!route) throw new TypeError("Network request failed");
    return route();
  }) as unknown as typeof fetch;
  return seen;
}

async function session() {
  const view = await renderHook(() => useSession(), { wrapper: SessionProvider });
  await waitFor(() => expect(view.result.current.status).not.toBe("loading"));
  return view;
}

beforeEach(async () => {
  await clearSession();
});
afterEach(() => jest.restoreAllMocks());

describe("SessionProvider: starting", () => {
  it("is signed out with nothing stored", async () => {
    serve({});
    const { result } = await session();
    expect(result.current.status).toBe("signed-out");
  });

  it("is signed in with the stored session, without an outcome", async () => {
    await saveSession(tokens());
    serve({});
    const { result } = await session();
    expect(result.current).toMatchObject({ status: "signed-in", sessionId: SESSION_ID });
    expect(result.current).not.toHaveProperty("outcome");
  });

  it("follows a store change made elsewhere, such as a refused refresh signing the device out", async () => {
    await saveSession(tokens());
    serve({});
    const { result } = await session();
    await act(async () => clearSession());
    expect(result.current.status).toBe("signed-out");
  });
});

describe("SessionProvider: signing in", () => {
  it("exchanges the code, stores the session and reports whether the account is new", async () => {
    const seen = serve({ "POST /auth/exchange": () => json({ ...tokens(), outcome: "created" }) });
    const { result } = await session();
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.signIn(token("code"));
    });
    expect(outcome).toBe("created");
    expect(seen[0]).toEqual({
      method: "POST",
      path: "/auth/exchange",
      body: { code: token("code") },
    });
    expect(result.current).toMatchObject({
      status: "signed-in",
      sessionId: SESSION_ID,
      outcome: "created",
    });
    expect(currentSession()).toEqual(tokens());
  });

  it("keeps the outcome through a later store change of the same session, not of another", async () => {
    serve({ "POST /auth/exchange": () => json({ ...tokens(), outcome: "resumed" }) });
    const { result } = await session();
    await act(async () => {
      await result.current.signIn(token("code"));
    });
    // A refresh stores a new pair for the same session.
    await act(async () => saveSession(tokens("b")));
    expect(result.current).toMatchObject({ sessionId: SESSION_ID, outcome: "resumed" });
    // Another session is another sign-in: the outcome is not carried over.
    const other = "7f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
    await act(async () => saveSession(tokens("c", other)));
    expect(result.current).toMatchObject({ status: "signed-in", sessionId: other });
    expect(result.current).not.toHaveProperty("outcome");
  });

  it("throws the API's refusal with its code and stays signed out", async () => {
    serve({ "POST /auth/exchange": () => refusal("code_expired", 400) });
    const { result } = await session();
    let error: unknown;
    await act(async () => {
      error = await result.current.signIn(token("code")).catch((caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "code_expired" });
    expect(result.current.status).toBe("signed-out");
    expect(currentSession()).toBeNull();
  });
});

describe("SessionProvider: signing out", () => {
  it("ends the session on the API and on the device", async () => {
    await saveSession(tokens());
    const seen = serve({ "POST /auth/logout": () => new Response(null, { status: 204 }) });
    const { result } = await session();
    await act(async () => result.current.signOut());
    expect(seen.map((s) => s.path)).toEqual(["/auth/logout"]);
    expect(result.current.status).toBe("signed-out");
    expect(currentSession()).toBeNull();
  });

  it("signs the device out without the network too", async () => {
    await saveSession(tokens());
    serve({});
    const { result } = await session();
    await act(async () => result.current.signOut());
    expect(result.current.status).toBe("signed-out");
  });

  it("ends every session of the account, and treats one already over as done", async () => {
    await saveSession(tokens());
    serve({ "POST /auth/logout-all": () => new Response(null, { status: 204 }) });
    const { result } = await session();
    await act(async () => result.current.signOutEverywhere());
    expect(result.current.status).toBe("signed-out");

    await act(async () => saveSession(tokens()));
    // Logged out everywhere already: the one refresh is refused as well.
    serve({
      "POST /auth/logout-all": () => refusal("session_revoked", 401),
      "POST /auth/refresh": () => refusal("session_revoked", 401),
    });
    await act(async () => result.current.signOutEverywhere());
    expect(result.current.status).toBe("signed-out");
  });

  it("stays signed in and throws when ending every session fails", async () => {
    await saveSession(tokens());
    serve({ "POST /auth/logout-all": () => refusal("internal_error", 500) });
    const { result } = await session();
    let error: unknown;
    await act(async () => {
      error = await result.current.signOutEverywhere().catch((caught: unknown) => caught);
    });
    expect(error).toMatchObject({ status: 500, message: "log out everywhere answered 500" });
    expect(result.current.status).toBe("signed-in");
    expect(currentSession()).not.toBeNull();
  });
});

describe("SessionProvider: the account", () => {
  it("exports everything the API holds, parsed", async () => {
    await saveSession(tokens());
    serve({ "GET /account/export": () => json(EXPORTED) });
    const { result } = await session();
    let exported: unknown;
    await act(async () => {
      exported = await result.current.exportData();
    });
    expect(exported).toEqual(EXPORTED);
  });

  it("throws the refusal of an export with its code", async () => {
    await saveSession(tokens());
    serve({ "GET /account/export": () => refusal("export_busy", 429) });
    const { result } = await session();
    let error: unknown;
    await act(async () => {
      error = await result.current.exportData().catch((caught: unknown) => caught);
    });
    expect(error).toMatchObject({ status: 429, code: "export_busy" });
  });

  it("deletes the account with the confirmation and signs the device out", async () => {
    await saveSession(tokens());
    const seen = serve({ "POST /account/delete": () => new Response(null, { status: 204 }) });
    const { result } = await session();
    await act(async () => result.current.deleteAccount());
    expect(seen[0]).toEqual({ method: "POST", path: "/account/delete", body: { confirm: true } });
    expect(result.current.status).toBe("signed-out");
  });

  it("keeps the session and throws when the deletion is refused", async () => {
    await saveSession(tokens());
    serve({ "POST /account/delete": () => refusal("internal_error", 500) });
    const { result } = await session();
    let error: unknown;
    await act(async () => {
      error = await result.current.deleteAccount().catch((caught: unknown) => caught);
    });
    expect(error).toMatchObject({ status: 500, code: "internal_error" });
    expect(result.current.status).toBe("signed-in");
  });
});

describe("useSession", () => {
  it("refuses to be used outside its provider", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(renderHook(() => useSession())).rejects.toThrow(
      "useSession needs a SessionProvider above it",
    );
  });
});
