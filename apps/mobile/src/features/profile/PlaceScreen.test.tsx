import type { HomeSummary } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, PixelRatio, Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader, hasCutText } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { MAX_FONT_SCALE } from "@/theme/a11y";
import { PlaceScreen } from "./PlaceScreen";

// The home after onboarding (ADR-061): what the card shows of it, and a new
// postal code, as often as the person likes. In words only, and what was typed
// leaves with its save.

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = () =>
  act(async () => {
    renderWithTheme(<PlaceScreen />);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const typeDigits = (text: string) =>
  act(async () => {
    fireEvent.changeText(screen.getByLabelText("Postal code"), text);
    await settle();
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const noProblems = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};
/** A place by its name, chosen or not: the chosen one's name carries its mark. */
const option = (name: string) => screen.getByRole("radio", { name: new RegExp(`^(✓ )?${name}$`) });
const checked = (name: string) => option(name).props.accessibilityState?.checked;
/** What this test says aloud: the mock outlives a test, with what earlier ones said. */
const spoken = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();
/** Aloud behind what is being said: iOS's way for words no line carries (#581). */
const queued = () =>
  jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockClear();

const LEAD = "Others see a town or your area by name, never the digits.";
const QUESTION = "What should your card show?";
const UNKNOWN = "We can't find that code. Choose the nearest area from the list.";

const HELSINKI = { fi: "Helsinki", sv: "Helsingfors" };
const JOENSUU = { fi: "Joensuu", sv: "Joensuu" };
const KALLIO = { fi: "Kallio", sv: "Berghäll" };
const IN_KALLIO: HomeSummary = { town: HELSINKI, area: KALLIO, showArea: false };
const IN_KOLI: HomeSummary = { town: JOENSUU, area: null, showArea: false };

type Answer = Response | Promise<Response>;

/** GET /profile with the home, and PUT /account/home answered as `save` says; what was sent is kept. */
function fakeApi(home: HomeSummary | null, save: (body: unknown) => Answer = () => json(home)) {
  const sent: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;
    // A postal code never travels where a log could read it (ADR-061 §9).
    expect(url.search).toBe("");
    if (path === "/profile" && request.method === "GET") {
      return json({ profile: null, completeness: { complete: false, missing: [] }, home });
    }
    if (path === "/account/home" && request.method === "PUT") {
      const body = await request.json();
      sent.push(body);
      return save(body);
    }
    return refusal("not_found", 404);
  }) as unknown as typeof fetch;
  return sent;
}

beforeEach(async () => {
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
});

describe("PlaceScreen", () => {
  it("keeps the title and the way back pinned, and goes back on the arrow", async () => {
    fakeApi(IN_KALLIO);
    await show();
    expectPinnedHeader("Home", "Back to your profile");
    await press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("says the home in words, never digits, with what the card shows and the field empty", async () => {
    fakeApi(IN_KALLIO);
    await show();
    expect(screen.getByText(LEAD)).toBeTruthy();
    // Why Kuutti asks was said at onboarding: nobody moves home differently for it (#581).
    expect(screen.queryByText(/tells Kuutti how far/)).toBeNull();
    expect(screen.getByRole("heading", { name: QUESTION }).props["aria-level"]).toBe("3");
    expect(checked("Helsinki")).toBe(true);
    expect(checked("Kallio")).toBe(false);
    expect(screen.getByText("✓ Helsinki")).toBeTruthy();
    expect(screen.getByLabelText("Postal code").props.value).toBe("");
    expect(screen.queryByText(/\d{5}/)).toBeNull();
    noProblems();
  });

  it("saves the choice on the tap, the choice alone, and reads it back", async () => {
    const sent = fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
    await show();
    await press(option("Kallio"));
    await waitFor(() => expect(checked("Kallio")).toBe(true));
    expect(sent).toEqual([{ showArea: true }]);
    expect(checked("Helsinki")).toBe(false);
    noProblems();
  });

  it("leaves digits being typed alone when the choice is saved", async () => {
    fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
    await show();
    await typeDigits("838");
    await press(option("Kallio"));
    await waitFor(() => expect(checked("Kallio")).toBe(true));
    expect(screen.getByLabelText("Postal code").props.value).toBe("838");
  });

  it("saves a new postal code on its row, in the body alone, and the digits go with the save", async () => {
    const sent = fakeApi(IN_KALLIO, () => json(IN_KOLI));
    await show();
    await typeDigits("83960");
    await press(screen.getByRole("button", { name: "8 3 9 6 0, Koli" }));
    // The town alone now: no area was kept, so what the card shows stands in the question's place.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "On your card: Joensuu" })).toBeTruthy(),
    );
    expect(sent).toEqual([{ postalCode: "83960" }]);
    expect(screen.getByLabelText("Postal code").props.value).toBe("");
    expect(screen.queryAllByRole("button", { name: /Koli/ })).toEqual([]);
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryByText("Your card shows the nearest town.")).toBeNull();
  });

  it("takes as many changes as the person likes, with no limit to say", async () => {
    const sent = fakeApi(IN_KALLIO, (body) =>
      json((body as { postalCode: string }).postalCode === "83960" ? IN_KOLI : IN_KALLIO),
    );
    await show();
    for (const [digits, name] of [
      ["83960", "8 3 9 6 0, Koli"],
      ["00530", "0 0 5 3 0, Kallio"],
      ["83960", "8 3 9 6 0, Koli"],
    ] as const) {
      await typeDigits(digits);
      await press(screen.getByRole("button", { name }));
    }
    expect(sent).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "On your card: Joensuu" })).toBeTruthy();
  });

  it("offers the field alone to somebody with no home, whose place left the list", async () => {
    const sent = fakeApi(null, () => json(IN_KALLIO));
    await show();
    expect(screen.queryByRole("heading", { name: QUESTION })).toBeNull();
    expect(screen.queryByText(/On your card/)).toBeNull();
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByText(LEAD)).toBeTruthy();
    noProblems();
    await typeDigits("00530");
    await press(screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }));
    await waitFor(() => expect(checked("Helsinki")).toBe(true));
    expect(sent).toEqual([{ postalCode: "00530" }]);
  });

  it("says a code the API lacks in its own words, keeps the digits, and lets another go through", async () => {
    let refuse = true;
    fakeApi(IN_KALLIO, () => (refuse ? refusal("postal_code_unknown", 400) : json(IN_KOLI)));
    await show();
    await typeDigits("83960");
    await press(screen.getByRole("button", { name: "8 3 9 6 0, Koli" }));
    await waitFor(() => expect(screen.getByText(UNKNOWN)).toBeTruthy());
    expect(screen.getByLabelText("Postal code").props.value).toBe("83960");
    expect(checked("Helsinki")).toBe(true);
    // The refused row is gone, with the nearest areas in its place, and the screen says why once.
    expect(screen.queryByRole("button", { name: "8 3 9 6 0, Koli" })).toBeNull();
    expect(screen.getAllByText(UNKNOWN)).toHaveLength(1);
    refuse = false;
    await typeDigits("83940");
    await press(screen.getByRole("button", { name: "8 3 9 4 0, Nunnanlahti" }));
    await waitFor(() => expect(screen.getByLabelText("Postal code").props.value).toBe(""));
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  it.each([
    ["a refusal of another code", () => refusal("internal_error", 500)],
    ["an answer the contract refuses", () => json({ town: "Helsinki" })],
  ])("says that it could not be saved on %s", async (_what, answer) => {
    fakeApi(IN_KALLIO, answer);
    await show();
    await press(option("Kallio"));
    await waitFor(() => expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy());
    expect(checked("Helsinki")).toBe(true);
    expect(checked("Kallio")).toBe(false);
  });

  it("holds the rows while it saves, with no line that pushes them down, and asks nothing more meanwhile (#581)", async () => {
    let answer: ((response: Response) => void) | undefined;
    const sent = fakeApi(
      IN_KALLIO,
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await show();
    await typeDigits("00530");
    await press(option("Kallio"));
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(
      screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }).props.accessibilityState?.disabled,
    ).toBe(true);
    await press(option("Helsinki"));
    expect(sent).toHaveLength(1);
    await act(async () => {
      answer?.(json({ ...IN_KALLIO, showArea: true }));
      await settle();
    });
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(checked("Kallio")).toBe(true);
    expect(
      screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }).props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it("takes a refusal's words away with the next tap", async () => {
    let refuse = true;
    fakeApi(IN_KALLIO, () =>
      refuse ? refusal("internal_error", 500) : json({ ...IN_KALLIO, showArea: true }),
    );
    await show();
    await press(option("Kallio"));
    await waitFor(() => expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy());
    refuse = false;
    await press(option("Kallio"));
    expect(screen.queryByText("It could not be saved. Try again.")).toBeNull();
    expect(checked("Kallio")).toBe(true);
  });

  describe("a save, heard and not drawn (#581)", () => {
    /** The save waits until the test answers, so what is said as it starts can be told from what is said as it lands. */
    const waitingSave = () => {
      let answer: ((response: Response) => void) | undefined;
      fakeApi(
        IN_KALLIO,
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      return () =>
        act(async () => {
          answer?.(json({ ...IN_KALLIO, showArea: true }));
          await settle();
        });
    };

    it("is queued on iOS behind the row's own name, as it starts and as it lands", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const said = queued();
      const land = waitingSave();
      await show();
      expect(said).not.toHaveBeenCalled();
      await press(option("Kallio"));
      expect(said.mock.calls).toEqual([["Saving…", { queue: true }]]);
      await land();
      expect(said.mock.calls).toEqual([
        ["Saving…", { queue: true }],
        ["Saved.", { queue: true }],
      ]);
    });

    it("is told to TalkBack too, with no line for a live region to read", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      const land = waitingSave();
      await show();
      expect(announce).not.toHaveBeenCalled();
      await press(option("Kallio"));
      expect(announce.mock.calls).toEqual([["Saving…"]]);
      await land();
      expect(announce.mock.calls).toEqual([["Saving…"], ["Saved."]]);
      expect(screen.queryByText("Saved.")).toBeNull();
      expect(screen.queryByText("Saving…")).toBeNull();
    });

    it("says no Saved. of a save refused", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      fakeApi(IN_KALLIO, () => refusal("internal_error", 500));
      await show();
      await press(option("Kallio"));
      await waitFor(() =>
        expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy(),
      );
      expect(announce.mock.calls).toEqual([["Saving…"]]);
    });

    it.each([
      ["fi-FI", "Kallio", "Tallennetaan…", "Tallennettu."],
      ["sv-FI", "Berghäll", "Sparar…", "Sparat."],
    ])("is said in %s", async (tag, area, saving, saved) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
      await show();
      await press(option(area));
      await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
      expect(announce.mock.calls).toEqual([[saving], [saved]]);
    });
  });

  describe("a refusal, which nothing on the screen can say", () => {
    it("stands in a line, on Android by its assertive live region", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      fakeApi(IN_KALLIO, () => refusal("internal_error", 500));
      await show();
      await press(option("Kallio"));
      const words = "It could not be saved. Try again.";
      await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
      expect(screen.getByText(words).props.accessibilityLiveRegion).toBe("assertive");
      expect(announce).not.toHaveBeenCalledWith(words);
    });

    it("is spoken on iOS, which has no live regions", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const announce = spoken();
      fakeApi(IN_KALLIO, () => refusal("internal_error", 500));
      await show();
      await press(option("Kallio"));
      await waitFor(() =>
        expect(announce).toHaveBeenCalledWith("It could not be saved. Try again."),
      );
    });
  });

  it("stays above the keyboard: a tap on a row counts with it up", async () => {
    fakeApi(IN_KALLIO);
    await show();
    const scroll = screen.container.queryAll((node) => node.type === "RCTScrollView")[0];
    expect(scroll?.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scroll?.props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("holds at the largest text with a full list", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    fakeApi(IN_KALLIO);
    await show();
    await typeDigits("0");
    expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
    noProblems();
  });

  it.each([
    [
      "fi-FI",
      "Koti",
      "Takaisin profiiliisi",
      "Muut näkevät kaupungin tai alueesi nimen, eivät koskaan numeroita.",
      "Mitä korttisi näyttää?",
      "Helsinki",
      "Kortillasi: Joensuu",
    ],
    [
      "sv-FI",
      "Hem",
      "Tillbaka till din profil",
      "Andra ser en stad eller ditt område med namn, aldrig siffrorna.",
      "Vad ska ditt kort visa?",
      "Helsingfors",
      "På ditt kort: Joensuu",
    ],
  ])("speaks %s", async (tag, title, back, lead, question, town, onCard) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    fakeApi(IN_KALLIO);
    await show();
    expectPinnedHeader(title, back);
    expect(screen.getByText(lead)).toBeTruthy();
    expect(screen.getByRole("heading", { name: question })).toBeTruthy();
    expect(checked(town)).toBe(true);
    fakeApi(IN_KOLI);
    await show();
    expect(screen.getByRole("heading", { name: onCard })).toBeTruthy();
  });

  it("says it is loading, then that the profile could not be read, and tries again", async () => {
    let answer: ((response: Response) => void) | undefined;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ) as unknown as typeof fetch;
    await show();
    expect(screen.getByText("Loading your profile…")).toBeTruthy();
    await act(async () => {
      answer?.(refusal("internal_error", 500));
      await settle();
    });
    expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy();
    fakeApi(IN_KALLIO);
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(checked("Helsinki")).toBe(true));
  });
});
