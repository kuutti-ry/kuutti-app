import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { ApiError } from "@/lib/api";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import { exportFileName, SessionProvider, useSession } from "./session";

// Whether this device is signed in (#35, #51): read from the store at start,
// the exchange of the bank login's one-time code, the three ways out, the
// export, and a store change from elsewhere (a refresh refused) followed.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
// Any well-formed verifier of the attempt (ADR-027): 64 lowercase hex characters.
const VERIFIER = "5a1e".repeat(16);
const SESSION_ID = "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b";
const tokens = (seed = "a", sessionId = SESSION_ID) => ({
  sessionId,
  accessToken: token(`access${seed}`),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token(`refresh${seed}`),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
});

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

  it("lets a read of the stored session that ends after the provider has gone change nothing", async () => {
    await saveSession(tokens());
    serve({});
    let answer: (stored: string | null) => void = () => undefined;
    const getItem = jest
      .spyOn(SecureStore, "getItemAsync")
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const error = jest.spyOn(console, "error");
    const view = await renderHook(() => useSession(), { wrapper: SessionProvider });
    expect(view.result.current.status).toBe("loading");
    expect(getItem).toHaveBeenCalledWith("kuutti.session");
    await view.unmount();
    await act(async () => answer(null));
    expect(error).not.toHaveBeenCalled();
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
  it("exchanges the code with its attempt's verifier, stores the session and reports whether the account is new", async () => {
    const seen = serve({ "POST /auth/exchange": () => json({ ...tokens(), outcome: "created" }) });
    const { result } = await session();
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.signIn(token("code"), VERIFIER);
    });
    expect(outcome).toBe("created");
    expect(seen[0]).toEqual({
      method: "POST",
      path: "/auth/exchange",
      body: { code: token("code"), verifier: VERIFIER },
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
      await result.current.signIn(token("code"), VERIFIER);
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
      error = await result.current
        .signIn(token("code"), VERIFIER)
        .catch((caught: unknown) => caught);
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
    // A plain log out has nothing for the sign-in screen to say.
    expect(result.current).not.toHaveProperty("notice");
    expect(currentSession()).toBeNull();
  });

  it("signs the device out without the network too", async () => {
    await saveSession(tokens());
    serve({});
    const { result } = await session();
    await act(async () => result.current.signOut());
    expect(result.current.status).toBe("signed-out");
    expect(result.current).not.toHaveProperty("notice");
  });

  it("names the lock as the reason when the lock's way out signs the device out (#418)", async () => {
    await saveSession(tokens());
    const seen = serve({ "POST /auth/logout": () => new Response(null, { status: 204 }) });
    const { result } = await session();
    await act(async () => result.current.signOut("lock"));
    // The same log out as any other: the API's session ends, and the device's.
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /auth/logout"]);
    expect(result.current).toMatchObject({ status: "signed-out", notice: "lock" });
    expect(currentSession()).toBeNull();
  });

  it("keeps the lock's notice when the API cannot be reached, signed out all the same", async () => {
    await saveSession(tokens());
    serve({});
    const { result } = await session();
    await act(async () => result.current.signOut("lock"));
    expect(result.current).toMatchObject({ status: "signed-out", notice: "lock" });
    expect(currentSession()).toBeNull();
  });

  it("signs the device out within five seconds when the API never answers the logout", async () => {
    await saveSession(tokens());
    const { result } = await session();
    jest.useFakeTimers();
    try {
      globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      let done = false;
      await act(async () => {
        void result.current.signOut("lock").then(() => {
          done = true;
        });
      });
      await act(async () => {
        jest.advanceTimersByTime(4_999);
      });
      expect(done).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(done).toBe(true);
      expect(result.current).toMatchObject({ status: "signed-out", notice: "lock" });
      expect(currentSession()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("drops an earlier notice at the next sign-in", async () => {
    await saveSession(tokens());
    serve({ "POST /auth/exchange": () => json({ ...tokens("b"), outcome: "resumed" }) });
    const { result } = await session();
    await act(async () => result.current.signOut("lock"));
    expect(result.current).toMatchObject({ notice: "lock" });
    await act(async () => {
      await result.current.signIn(token("code"), VERIFIER);
    });
    expect(result.current).toMatchObject({ status: "signed-in", outcome: "resumed" });
    expect(result.current).not.toHaveProperty("notice");
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
  it("exports everything the API holds as the zip it sent, under the name it gave", async () => {
    await saveSession(tokens());
    const bytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3]);
    serve({
      "GET /account/export": () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="kuutti-tiedot-2026-10-13.zip"',
          },
        }),
    });
    const { result } = await session();
    let exported: { name: string; bytes: Uint8Array } | undefined;
    await act(async () => {
      exported = await result.current.exportData();
    });
    expect(exported?.name).toBe("kuutti-tiedot-2026-10-13.zip");
    expect(Array.from(exported?.bytes ?? [])).toEqual(Array.from(bytes));
  });

  it.each([
    [null, "kuutti-data.zip"],
    ["inline", "kuutti-data.zip"],
    ['attachment; filename="kuutti-data-2026-10-13.zip"', "kuutti-data-2026-10-13.zip"],
    ['attachment; filename="../a b/kuutti.zip"', ".._a_b_kuutti.zip"],
  ])("names the file from the header %s as %s", (header, name) => {
    expect(exportFileName(header)).toBe(name);
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

describe("SessionProvider: the break (#170)", () => {
  it("pauses the account with the confirmation, signs the device out and keeps the notice for the sign-in screen", async () => {
    await saveSession(tokens());
    const seen = serve({ "POST /account/pause": () => new Response(null, { status: 204 }) });
    const { result } = await session();
    await act(async () => result.current.pauseAccount());
    expect(seen[0]).toEqual({ method: "POST", path: "/account/pause", body: { confirm: true } });
    expect(result.current).toMatchObject({ status: "signed-out", notice: "paused" });
    expect(currentSession()).toBeNull();
  });

  it("keeps the session and throws when the break is refused", async () => {
    await saveSession(tokens());
    serve({ "POST /account/pause": () => refusal("not_active", 409) });
    const { result } = await session();
    let error: unknown;
    await act(async () => {
      error = await result.current.pauseAccount().catch((caught: unknown) => caught);
    });
    expect(error).toMatchObject({ status: 409, code: "not_active" });
    expect(result.current.status).toBe("signed-in");
  });

  it("reports a login that ended a break as unpaused", async () => {
    const seen = serve({
      "POST /auth/exchange": () => json({ ...tokens("b"), outcome: "unpaused" }),
    });
    const { result } = await session();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.signIn("c".repeat(43), VERIFIER);
    });
    expect(outcome).toBe("unpaused");
    expect(seen[0]?.path).toBe("/auth/exchange");
    expect(result.current).toMatchObject({ status: "signed-in", outcome: "unpaused" });
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
