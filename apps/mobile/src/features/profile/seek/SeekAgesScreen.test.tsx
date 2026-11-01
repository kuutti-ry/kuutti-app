import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
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
      if (server.refusal) return server.refusal();
      server.ageWindow = body.ageWindow ?? server.ageWindow;
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    await server.wait;
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
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
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
const GENERIC = "Saving did not work. Check the fields and try again.";
const CONTACT_DETAILS =
  "Your text has an e-mail address, a link, a phone number or a social media handle. Those come after a match.";
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

  it("leads with the bounds and says that the answer also decides who sees the person", async () => {
    await opened();
    expect(screen.getByText("Between 18 and 99. It also decides who sees you.")).toBeTruthy();
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

  it.each([
    ["the generic line", "validation_failed", 422, GENERIC],
    ["the words the app has for the code", "text_contact_details", 400, CONTACT_DETAILS],
  ])(
    "brings a refused change back with the draft and %s, and goes on the word",
    async (_what, code, status, reason) => {
      const { writes, view } = await opened({ refusal: () => envelope(code, status) });
      await press(button(OLDER_YOUNGEST));
      await leaveAndGo(view);
      expect(writes).toEqual([saved({ min: 26, max: 40 })]);
      expect(router.push).toHaveBeenCalledWith("/profile/seek/ages");

      // The stack opens the screen again: the numbers are there, and why they were not saved.
      await show(<SeekAgesScreen />);
      await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
      expect(shownAges()).toEqual([26, 40]);
      expect(screen.getByText(reason)).toBeTruthy();

      await press(button("Leave without saving"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(router.back).toHaveBeenCalledTimes(1);
      await leave();
      expect(writes).toHaveLength(1);
    },
  );

  // Nothing to compare the draft with yet, so nothing goes: it is the question's to let go.
  it("sends nothing for a refused draft left before the stored window is read", async () => {
    const { server, writes, view } = await opened({
      refusal: () => envelope("internal_error", 500),
    });
    await press(button(OLDER_YOUNGEST));
    await leaveAndGo(view);
    server.wait = new Promise(() => {});
    await show(<SeekAgesScreen />);
    expect(shownAges()).toEqual([26, 40]);
    await leave();
    expect(writes).toHaveLength(1);
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
    expect(screen.getByText("Loading your profile…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: OLDER_YOUNGEST })).toBeNull();
    await leave();
    expect(writes).toEqual([]);
  });

  it("says when the window could not be read, and tries again", async () => {
    const { server } = fakeApi({ failing: true });
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy());
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    server.failing = false;
    await press(button("Try again"));
    await waitFor(() => expect(shownAges()).toEqual([25, 40]));
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it("sends whoever has no consent to onboarding, and shows no stepper", async () => {
    fakeApi({ consent: null });
    await show(<SeekAgesScreen />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByRole("button", { name: OLDER_YOUNGEST })).toBeNull();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      "Minkä ikäisiä?",
      "Takaisin siihen, mitä etsit",
      "Väliltä 18–99. Se ratkaisee myös, ketkä näkevät sinut.",
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
      "Mellan 18 och 99. Det avgör också vilka som ser dig.",
      ["Yngsta", "Äldsta"],
      [
        "Yngsta, ett år yngre",
        "Yngsta, ett år äldre",
        "Äldsta, ett år yngre",
        "Äldsta, ett år äldre",
      ],
    ],
  ])("speaks %s", async (tag, title, back, lead, ends, steps) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi();
      await show(<SeekAgesScreen />);
      await waitFor(() => expect(screen.getByText(lead)).toBeTruthy());
      expectPinnedHeader(title, back);
      for (const end of ends) expect(screen.getByText(end)).toBeTruthy();
      for (const step of steps) expect(button(step)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
