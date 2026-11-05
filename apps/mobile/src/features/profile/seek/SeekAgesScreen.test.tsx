import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SeekAgesScreen } from "./SeekAgesScreen";

// The age window (#542): the bounds of onboarding, from the stored answer, two
// steppers that never cross, saved on leaving. Every answer is a button.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = async (ui: React.ReactElement) => {
  let view: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  await act(async () => {
    view = await renderWithTheme(ui);
    await settle();
  });
  return view as NonNullable<typeof view>;
};
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) =>
  json({ error: { code, message: "no", requestId: "r" } }, status);

const CONSENT = { version: "2026-10-01", at: "2026-10-01T10:00:00.000Z" };

type Window = { min: number; max: number };

/** What the API keeps; a save replaces what it names, unless `refusal` answers it. */
type Server = {
  seeks: string[] | null;
  ageWindow: Window | null;
  consent: typeof CONSENT | null;
  /** The answer to a save instead of taking it. */
  refusal: (() => Response) | null;
  /** Every read fails. */
  failing: boolean;
  /** The network is gone: every request is lost, a save counted as it went. */
  offline: boolean;
  /** Every read waits for this. */
  wait: Promise<void>;
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    seeks: ["woman"],
    ageWindow: { min: 25, max: 40 },
    consent: CONSENT,
    refusal: null,
    failing: false,
    offline: false,
    wait: Promise.resolve(),
    ...start,
  };
  const writes: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body = (await request.json()) as { ageWindow?: Window };
      writes.push({ method: request.method, path, body });
      if (server.offline) throw new TypeError("Network request failed");
      if (server.refusal) return server.refusal();
      server.ageWindow = body.ageWindow ?? server.ageWindow;
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    await server.wait;
    if (server.offline) throw new TypeError("Network request failed");
    if (server.failing) return envelope("internal_error", 500);
    if (path === "/preferences") return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    if (path === "/profile") {
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: {},
          prompts: [],
          specialCategoryConsent: server.consent,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
        home: null,
      });
    }
    return envelope("not_found", 404);
  }) as unknown as typeof fetch;
  return { server, writes };
}

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: { emit: (name: string, event: unknown) => void };
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; dismissTo: jest.Mock };
};

/** The back gesture, the back button or Android's back key, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
/** Leaving as the stack does it: the screen goes at once, its save on the way after it (#238). */
const leaveAndGo = async (view: Awaited<ReturnType<typeof show>>) => {
  await leave();
  await act(async () => {
    view.unmount();
    await settle();
  });
};

const YOUNGER_YOUNGEST = "Youngest, one year younger";
const OLDER_YOUNGEST = "Youngest, one year older";
const YOUNGER_OLDEST = "Oldest, one year younger";
const OLDER_OLDEST = "Oldest, one year older";
const STEPS = [YOUNGER_YOUNGEST, OLDER_YOUNGEST, YOUNGER_OLDEST, OLDER_OLDEST];
const FAILED = "That did not go through. Try again.";
const LOAD_FAILED = FAILED_TO_LOAD;
const THE_QUESTION = "Leave without saving?";
const BACK = "Back to what you seek";

const button = (name: string) => screen.getByRole("button", { name });
const stopped = () =>
  STEPS.filter((name) => button(name).props.accessibilityState?.disabled === true);

/** The two numbers shown, youngest first, whatever they are. */
const shownAges = () => screen.getAllByText(/^\d+$/).map((node) => Number(node.props.children));

const opened = async (start?: Partial<Server>) => {
  const api = fakeApi(start);
  const view = await show(<SeekAgesScreen />);
  await waitFor(() => expect(button(YOUNGER_YOUNGEST)).toBeTruthy());
  return { ...api, view };
};

const saved = (ageWindow: Window) => ({ method: "PUT", path: "/preferences", body: { ageWindow } });

beforeEach(async () => {
  router.push.mockClear();
  router.replace.mockClear();
  router.back.mockClear();
  router.dismissTo.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("SeekAgesScreen", () => {
  it("keeps the question and the way back to the list pinned above the steppers", async () => {
    await opened();
    expectPinnedHeader("What ages?", BACK);
    await press(button(BACK));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("has no line over the steppers: they stop at the bounds themselves, and the list says the rest (#581)", async () => {
    await opened();
    expect(screen.queryAllByText(/./).map((node) => node.props.children)).toEqual([
      "What ages?",
      "Youngest",
      "25",
      "Oldest",
      "40",
    ]);
  });

  it("starts from the stored window, each number under its own name, said as it changes", async () => {
    await opened({ ageWindow: { min: 31, max: 47 } });
    const drawn = JSON.stringify(screen.toJSON());
    const places = ['"Youngest"', '"31"', '"Oldest"', '"47"'].map((word) => drawn.indexOf(word));
    expect(places).not.toContain(-1);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(shownAges()).toEqual([31, 47]);
    expect(screen.getByText("31").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.getByText("47").props.accessibilityLiveRegion).toBe("polite");
  });

  it("has four buttons and the way back, each labelled and a full target: no slider and no Save", async () => {
    await opened();
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      BACK,
      ...STEPS,
    ]);
    expect(screen.queryByRole("adjustable")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(5);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it.each([
    ["nothing away from the ends", { min: 25, max: 40 }, []],
    ["the youngest at 18", { min: 18, max: 40 }, [YOUNGER_YOUNGEST]],
    ["the youngest one past 18", { min: 19, max: 40 }, []],
    ["the oldest at 99", { min: 25, max: 99 }, [OLDER_OLDEST]],
    ["the oldest one short of 99", { min: 25, max: 98 }, []],
    ["both at their bounds", { min: 18, max: 99 }, [YOUNGER_YOUNGEST, OLDER_OLDEST]],
    ["the two ends met", { min: 30, max: 30 }, [OLDER_YOUNGEST, YOUNGER_OLDEST]],
    ["the two ends a year apart", { min: 30, max: 31 }, []],
    ["met at 18", { min: 18, max: 18 }, [YOUNGER_YOUNGEST, OLDER_YOUNGEST, YOUNGER_OLDEST]],
    ["met at 99", { min: 99, max: 99 }, [OLDER_YOUNGEST, YOUNGER_OLDEST, OLDER_OLDEST]],
  ])("stops at the ends: %s", async (_what, ageWindow, ends) => {
    await opened({ ageWindow });
    expect(stopped()).toEqual(ends);
  });

  it("steps each end by one, either way", async () => {
    await opened({ ageWindow: { min: 25, max: 40 } });
    await press(button(OLDER_YOUNGEST));
    expect(shownAges()).toEqual([26, 40]);
    await press(button(YOUNGER_YOUNGEST));
    await press(button(YOUNGER_YOUNGEST));
    expect(shownAges()).toEqual([24, 40]);
    await press(button(OLDER_OLDEST));
    expect(shownAges()).toEqual([24, 41]);
    await press(button(YOUNGER_OLDEST));
    await press(button(YOUNGER_OLDEST));
    expect(shownAges()).toEqual([24, 39]);
  });

  it("stops the steppers as they meet: a window never crosses", async () => {
    const { writes, view } = await opened({ ageWindow: { min: 29, max: 30 } });
    await press(button(OLDER_YOUNGEST));
    expect(shownAges()).toEqual([30, 30]);
    expect(stopped()).toEqual([OLDER_YOUNGEST, YOUNGER_OLDEST]);
    await press(button(OLDER_YOUNGEST));
    await press(button(YOUNGER_OLDEST));
    expect(shownAges()).toEqual([30, 30]);
    await leaveAndGo(view);
    expect(writes).toEqual([saved({ min: 30, max: 30 })]);
  });

  it("stops the steppers at 18 and at 99, wherever they started", async () => {
    const { writes, view } = await opened({ ageWindow: { min: 19, max: 98 } });
    await press(button(YOUNGER_YOUNGEST));
    await press(button(YOUNGER_YOUNGEST));
    await press(button(OLDER_OLDEST));
    await press(button(OLDER_OLDEST));
    expect(shownAges()).toEqual([18, 99]);
    expect(stopped()).toEqual([YOUNGER_YOUNGEST, OLDER_OLDEST]);
    await leaveAndGo(view);
    expect(writes).toEqual([saved({ min: 18, max: 99 })]);
  });

  it("leaves without a request or a word when nothing changed", async () => {
    const { writes, view } = await opened();
    const event = await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
    await leaveAndGo(view);
    expect(writes).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("sends nothing when each end went there and back to the stored numbers", async () => {
    const { writes, view } = await opened();
    await press(button(OLDER_YOUNGEST));
    await press(button(YOUNGER_OLDEST));
    await press(button(YOUNGER_YOUNGEST));
    await press(button(OLDER_OLDEST));
    expect(shownAges()).toEqual([25, 40]);
    await leaveAndGo(view);
    expect(writes).toEqual([]);
  });

  it.each([
    ["the youngest alone", [OLDER_YOUNGEST], { min: 26, max: 40 }],
    ["the oldest alone", [YOUNGER_OLDEST], { min: 25, max: 39 }],
    ["both ends", [YOUNGER_YOUNGEST, OLDER_OLDEST], { min: 24, max: 41 }],
  ])("sends the whole window when %s moved", async (_what, pressed, ageWindow) => {
    const { writes, view } = await opened();
    for (const name of pressed) await press(button(name));
    await leaveAndGo(view);
    expect(writes).toEqual([saved(ageWindow)]);
  });

  it("sends exactly the age window, once, on leaving, and nothing before it", async () => {
    const { writes, server, view } = await opened();
    await press(button(OLDER_YOUNGEST));
    expect(writes).toEqual([]);
    const event = await leave();
    await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writes).toEqual([saved({ min: 26, max: 40 })]);
    expect(server.ageWindow).toEqual({ min: 26, max: 40 });
    await leaveAndGo(view);
    expect(writes).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("brings a refused change back with the draft and says it could not be saved, and goes on the word", async () => {
    const { writes, view } = await opened({ refusal: () => envelope("internal_error", 500) });
    await press(button(OLDER_YOUNGEST));
    await leaveAndGo(view);
    expect(writes).toEqual([saved({ min: 26, max: 40 })]);
    expect(router.push).toHaveBeenCalledWith("/profile/seek/ages");

    // The stack opens the screen again: the numbers are there, and why they were not saved.
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
    expect(shownAges()).toEqual([26, 40]);
    expect(screen.getByText(FAILED)).toBeTruthy();

    await press(button("Leave without saving"));
    expect(screen.queryByText(THE_QUESTION)).toBeNull();
    expect(router.back).toHaveBeenCalledTimes(1);
    await leave();
    expect(writes).toHaveLength(1);
  });

  it.each([
    ["fi-FI", "Nuorin, vuotta vanhempi", "Se ei onnistunut. Yritä uudelleen."],
    ["sv-FI", "Yngsta, ett år äldre", "Det gick inte. Försök igen."],
  ])("says in %s that a refused change could not be saved", async (tag, older, failed) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi({ refusal: () => envelope("internal_error", 500) });
      const view = await show(<SeekAgesScreen />);
      await waitFor(() => expect(button(older)).toBeTruthy());
      await press(button(older));
      await leaveAndGo(view);
      await show(<SeekAgesScreen />);
      await waitFor(() => expect(screen.getByText(failed)).toBeTruthy());
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  // Nothing to compare the draft with yet, so it goes as it is: a draft is never dropped unasked.
  it("tries a refused draft again when it is left before the stored window is read", async () => {
    const { server, writes, view } = await opened({
      refusal: () => envelope("internal_error", 500),
    });
    await press(button(OLDER_YOUNGEST));
    await leaveAndGo(view);
    server.refusal = null;
    server.wait = new Promise(() => {});
    await show(<SeekAgesScreen />);
    expect(shownAges()).toEqual([26, 40]);
    await leave();
    expect(writes).toEqual([saved({ min: 26, max: 40 }), saved({ min: 26, max: 40 })]);
    expect(server.ageWindow).toEqual({ min: 26, max: 40 });
  });

  it("holds a change the network lost, as any refusal", async () => {
    const { server, view } = await opened();
    await press(button(OLDER_YOUNGEST));
    server.offline = true;
    await leaveAndGo(view);
    expect(router.push).toHaveBeenCalledWith("/profile/seek/ages");
    // The network that lost the save has lost the read too.
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
    expect(shownAges()).toEqual([26, 40]);
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
  });

  describe("a change brought back with its read lost too", () => {
    const broughtBack = async () => {
      const { server, writes, view } = await opened();
      await press(button(OLDER_YOUNGEST));
      server.offline = true;
      await leaveAndGo(view);
      const again = await show(<SeekAgesScreen />);
      await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
      return { server, writes, again };
    };

    it("tries the save again on the leaving after Keep editing", async () => {
      const { server, writes, again } = await broughtBack();
      await press(button("Keep editing"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(router.back).not.toHaveBeenCalled();
      expect(shownAges()).toEqual([26, 40]);
      server.offline = false;
      await leaveAndGo(again);
      expect(writes).toEqual([saved({ min: 26, max: 40 }), saved({ min: 26, max: 40 })]);
      expect(server.ageWindow).toEqual({ min: 26, max: 40 });
      expect(router.push).toHaveBeenCalledTimes(1);
    });

    it("comes back again when that save is lost too", async () => {
      const { writes, again } = await broughtBack();
      await press(button("Keep editing"));
      await leaveAndGo(again);
      expect(writes).toHaveLength(2);
      expect(router.push).toHaveBeenCalledTimes(2);
      await show(<SeekAgesScreen />);
      await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
      expect(shownAges()).toEqual([26, 40]);
    });

    it("goes back on Leave without saving, and sends nothing", async () => {
      const { server, writes } = await broughtBack();
      server.offline = false;
      await press(button("Leave without saving"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(router.back).toHaveBeenCalledTimes(1);
      await leave();
      expect(writes).toHaveLength(1);
    });
  });

  it("keeps a refused draft on Keep editing, and saves it on the next leaving", async () => {
    const { writes, server, view } = await opened({
      refusal: () => envelope("internal_error", 500),
    });
    await press(button(OLDER_YOUNGEST));
    await leaveAndGo(view);
    server.refusal = null;
    const again = await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
    await press(button("Keep editing"));
    expect(screen.queryByText(THE_QUESTION)).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
    await press(button(YOUNGER_OLDEST));
    await leaveAndGo(again);
    expect(writes).toEqual([saved({ min: 26, max: 40 }), saved({ min: 26, max: 39 })]);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("holds no draft when what is gone is the consent: the list's read sends the person on", async () => {
    const { writes, view } = await opened({ refusal: () => envelope("consent_required", 403) });
    await press(button(OLDER_YOUNGEST));
    await leaveAndGo(view);
    expect(writes).toEqual([saved({ min: 26, max: 40 })]);
    expect(router.push).not.toHaveBeenCalled();
    // And nothing is held for the next time the screen opens.
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(button(OLDER_YOUNGEST)).toBeTruthy());
    expect(screen.queryByText(THE_QUESTION)).toBeNull();
    expect(shownAges()).toEqual([25, 40]);
  });

  it("says it is loading until the window is read, and leaving then sends nothing", async () => {
    const { writes } = fakeApi({ wait: new Promise(() => {}) });
    await show(<SeekAgesScreen />);
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: OLDER_YOUNGEST })).toBeNull();
    await leave();
    expect(writes).toEqual([]);
  });

  it("says when the window could not be read, and tries again", async () => {
    const { server } = fakeApi({ failing: true });
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy());
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    server.failing = false;
    await press(button("Try again"));
    await waitFor(() => expect(shownAges()).toEqual([25, 40]));
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });

  it("says it is loading again while Try again reads", async () => {
    const { server } = fakeApi({ failing: true });
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText(LOAD_FAILED)).toBeTruthy());
    let answer: (() => void) | undefined;
    server.wait = new Promise((resolve) => {
      answer = resolve;
    });
    server.failing = false;
    await press(button("Try again"));
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    await act(async () => {
      answer?.();
      await settle();
    });
    await waitFor(() => expect(shownAges()).toEqual([25, 40]));
  });

  it("sends whoever has no consent back to Home, and shows no stepper", async () => {
    fakeApi({ consent: null });
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: OLDER_YOUNGEST })).toBeNull();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      "Minkä ikäisiä?",
      "Takaisin siihen, mitä etsit",
      ["Nuorin", "Vanhin"],
      [
        "Nuorin, vuotta nuorempi",
        "Nuorin, vuotta vanhempi",
        "Vanhin, vuotta nuorempi",
        "Vanhin, vuotta vanhempi",
      ],
    ],
    [
      "sv-FI",
      "Vilka åldrar?",
      "Tillbaka till vad du söker",
      ["Yngsta", "Äldsta"],
      [
        "Yngsta, ett år yngre",
        "Yngsta, ett år äldre",
        "Äldsta, ett år yngre",
        "Äldsta, ett år äldre",
      ],
    ],
  ])("speaks %s", async (tag, title, back, ends, steps) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi();
      await show(<SeekAgesScreen />);
      await waitFor(() => expect(button(steps[0] as string)).toBeTruthy());
      expectPinnedHeader(title, back);
      for (const end of ends) expect(screen.getByText(end)).toBeTruthy();
      for (const step of steps) expect(button(step)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
