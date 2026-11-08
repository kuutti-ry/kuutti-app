import type { Gender } from "@kuutti/schema";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { StrictMode } from "react";
import { saveSession } from "@/lib/session";
import { savedOrHeld, useSeeking } from "./useSeeking";

// What the list of What you seek and its two screens read (#542): the answers
// with the consent, a way back to Home for whoever lacks one of them, and what
// is held when a change is refused on the way out.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const offline = (): Response => {
  throw new TypeError("Network request failed");
};

const AGES = { min: 25, max: 40 };
const PREFERENCES = { seeks: ["woman"], ageWindow: AGES };

/** A stored document with the consent of the current wording, as GET /profile answers it. */
const stored = (overrides: Record<string, unknown> = {}) => ({
  displayName: "Aino",
  bio: null,
  bioPreset: null,
  fields: { intent: "long_term" },
  prompts: [],
  specialCategoryConsent: { version: "2026-10-01", at: "2026-10-01T10:00:00.000Z" },
  updatedAt: "2026-10-08T10:00:00.000Z",
  ...overrides,
});
const profile = (document: ReturnType<typeof stored> | null) => ({
  profile: document,
  completeness: { complete: false, missing: ["photos"] },
  home: null,
});

type Answer = Response | Promise<Response>;
type Routes = {
  preferences: () => Answer;
  profile: () => Answer;
  save: (body: unknown) => Answer;
};

/** GET /preferences, GET /profile and PUT /preferences; a test changes `routes` between reads. */
function serve(answers: Partial<Routes> = {}) {
  const routes: Routes = {
    preferences: () => json(PREFERENCES),
    profile: () => json(profile(stored())),
    save: () => json(PREFERENCES),
    ...answers,
  };
  const saved: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/profile") return routes.profile();
    if (request.method === "GET") return routes.preferences();
    const body = await request.json();
    saved.push(body);
    return routes.save(body);
  }) as unknown as typeof fetch;
  return { routes, saved };
}

/** Holds the next read of the answers until the test lets it through. */
function waiting(routes: Routes) {
  let answer: ((response: Response) => void) | undefined;
  routes.preferences = () =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    });
  return (response: Response) => answer?.(response);
}

async function ready() {
  const view = await renderHook(() => useSeeking());
  await waitFor(() => expect(view.result.current.status).not.toBe("loading"));
  return view;
}

const failure = (state: ReturnType<typeof useSeeking>) =>
  state.status === "error" ? state.error : undefined;

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { replace: jest.Mock; dismissTo: jest.Mock };
};

beforeEach(async () => {
  router.replace.mockClear();
  router.dismissTo.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("useSeeking", () => {
  it("is ready once whom one seeks, the window and the consent are all there", async () => {
    serve();
    const { result } = await ready();
    expect(result.current).toMatchObject({
      status: "ready",
      seeking: { seeks: ["woman"], ageWindow: AGES, fields: { intent: "long_term" } },
    });
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it("asks nothing of what one is here for: unanswered, it is ready without it", async () => {
    serve({ profile: () => json(profile(stored({ fields: {} }))) });
    const { result } = await ready();
    expect(result.current.status).toBe("ready");
    expect(result.current).toMatchObject({ seeking: { fields: {} } });
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it.each([
    ["whom they seek", { preferences: () => json({ ...PREFERENCES, seeks: null }) }],
    ["an age window", { preferences: () => json({ ...PREFERENCES, ageWindow: null }) }],
    ["a stored profile", { profile: () => json(profile(null)) }],
    ["the consent", { profile: () => json(profile(stored({ specialCategoryConsent: null }))) }],
  ])("sends a person without %s back to Home, with no error shown", async (_what, answers) => {
    serve(answers);
    const { result } = await renderHook(() => useSeeking());
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    await act(settle);
    expect(result.current.status).toBe("loading");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("does nothing once its host has gone, whatever the read brings", async () => {
    let answer: ((response: Response) => void) | undefined;
    serve({
      preferences: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const { unmount } = await renderHook(() => useSeeking());
    await waitFor(() => expect(answer).toBeDefined());
    await unmount();
    await act(async () => {
      answer?.(json({ ...PREFERENCES, seeks: null }));
      await settle();
    });
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a refused read of the answers",
      { preferences: () => refusal("internal_error", 500) },
      "ApiError",
    ],
    [
      "a refused read of the profile",
      { profile: () => refusal("internal_error", 500) },
      "ApiError",
    ],
    ["no network", { preferences: offline }, "TypeError"],
    ["an answer this build cannot read", { preferences: () => json({ seeks: ["x"] }) }, "ZodError"],
  ])("is the error state after %s, for the screen to say why", async (_what, answers, name) => {
    serve(answers);
    const { result } = await ready();
    expect(result.current.status).toBe("error");
    expect(failure(result.current)).toMatchObject({ name });
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it("keeps what it showed when a read again fails", async () => {
    const { routes } = serve();
    const { result } = await ready();
    routes.preferences = () => refusal("internal_error", 500);
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["woman"] } });
    expect(router.dismissTo).not.toHaveBeenCalled();
  });

  it("stays quiet through a read again over a ready screen: no loading, and what it shows stays", async () => {
    const { routes } = serve();
    const { result } = await ready();
    const answer = waiting(routes);
    await act(async () => {
      void result.current.reload();
      await settle();
    });
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["woman"] } });
    await act(async () => {
      answer(json({ ...PREFERENCES, seeks: ["man"] }));
      await settle();
    });
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["man"] } });
  });

  it("reads again on reload, and takes the new answers", async () => {
    const { routes } = serve();
    const { result } = await ready();
    routes.preferences = () => json({ seeks: ["man"], ageWindow: { min: 30, max: 50 } });
    routes.profile = () => json(profile(stored({ fields: { intent: "casual" } })));
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({
      status: "ready",
      seeking: { seeks: ["man"], ageWindow: { min: 30, max: 50 }, fields: { intent: "casual" } },
    });
  });

  it("goes back to Home when a read again finds the consent gone", async () => {
    const { routes } = serve();
    const { result } = await ready();
    routes.profile = () => json(profile(stored({ specialCategoryConsent: null })));
    await act(() => result.current.reload());
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("comes out of the error state on a read again that works", async () => {
    const { routes } = serve({ preferences: () => refusal("internal_error", 500) });
    const { result } = await ready();
    routes.preferences = () => json(PREFERENCES);
    await act(() => result.current.reload());
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["woman"] } });
  });

  it("goes through loading on a read again after a failure, for the screen to say so", async () => {
    const { routes } = serve({ preferences: () => refusal("internal_error", 500) });
    const { result } = await ready();
    expect(result.current.status).toBe("error");
    const answer = waiting(routes);
    await act(async () => {
      void result.current.reload();
      await settle();
    });
    expect(result.current.status).toBe("loading");
    await act(async () => {
      answer(json(PREFERENCES));
      await settle();
    });
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["woman"] } });
  });

  it("says why the last read failed while nothing was ever read", async () => {
    const { routes } = serve({ preferences: () => refusal("internal_error", 500) });
    const { result } = await ready();
    expect(failure(result.current)).toMatchObject({ name: "ApiError" });
    routes.preferences = offline;
    await act(() => result.current.reload());
    expect(failure(result.current)).toMatchObject({ name: "TypeError" });
  });

  it("reads what a change on its way stored, not what stood before it", async () => {
    let seeks = ["woman"];
    let answer: (() => void) | undefined;
    serve({
      preferences: () => json({ ...PREFERENCES, seeks }),
      save: () =>
        new Promise<Response>((resolve) => {
          answer = () => {
            seeks = ["man"];
            resolve(json({ ...PREFERENCES, seeks }));
          };
        }),
    });
    const { result } = await ready();
    const saving = savedOrHeld({ seeks: ["man"] }, ["man"]);
    await waitFor(() => expect(answer).toBeDefined());
    await act(async () => {
      void result.current.reload();
      await settle();
      answer?.();
      await saving;
      await settle();
    });
    expect(result.current).toMatchObject({ status: "ready", seeking: { seeks: ["man"] } });
  });

  // The second run of the effects comes after their cleanup, which marked the host gone.
  it("keeps its host once StrictMode has run the effects twice", async () => {
    serve();
    const { result } = await renderHook(() => useSeeking(), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});

describe("savedOrHeld", () => {
  const draft: Gender[] = ["man"];

  it("answers null when the change is saved, having sent it as it was given", async () => {
    const { saved } = serve();
    await expect(savedOrHeld({ seeks: draft }, draft)).resolves.toBeNull();
    expect(saved).toEqual([{ seeks: ["man"] }]);
  });

  it.each([
    ["the API refused it", () => refusal("validation_failed", 422)],
    ["the network failed", offline],
    ["this build cannot read the answer", () => json({ seeks: "everybody", ageWindow: null })],
  ])("holds the draft itself when %s", async (_what, save) => {
    serve({ save });
    await expect(savedOrHeld({ seeks: draft }, draft)).resolves.toBe(draft);
  });

  // An answer with no consent has nowhere to go: the list's read sends the person on to onboarding.
  it("holds nothing when what is gone is the consent", async () => {
    const { saved } = serve({ save: () => refusal("consent_required", 403) });
    await expect(savedOrHeld({ seeks: draft }, draft)).resolves.toBeNull();
    expect(saved).toEqual([{ seeks: ["man"] }]);
  });
});
