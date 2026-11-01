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
const selected = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityState?.selected;
/** What this test says aloud: the mock outlives a test, with what earlier ones said. */
const spoken = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();

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
    expect(
      screen.getByText(
        "Your postal code tells Kuutti how far people are. Others see a town or your area by name, never the digits.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What should your card show?" })).toBeTruthy();
    expect(screen.getByText("On your card: Helsinki")).toBeTruthy();
    expect(selected("Helsinki")).toBe(true);
    expect(screen.getByLabelText("Postal code").props.value).toBe("");
    expect(screen.queryByText(/\d{5}/)).toBeNull();
    noProblems();
  });

  it("saves the choice on the tap, the choice alone, and reads it back", async () => {
    const sent = fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
    await show();
    await press(screen.getByRole("button", { name: "Kallio" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(sent).toEqual([{ showArea: true }]);
    expect(selected("Kallio")).toBe(true);
    expect(screen.getByText("On your card: Kallio")).toBeTruthy();
    noProblems();
  });

  it("leaves digits being typed alone when the choice is saved", async () => {
    fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
    await show();
    await typeDigits("838");
    await press(screen.getByRole("button", { name: "Kallio" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(screen.getByLabelText("Postal code").props.value).toBe("838");
  });

  it("saves a new postal code on its row, in the body alone, and the digits go with the save", async () => {
    const sent = fakeApi(IN_KALLIO, () => json(IN_KOLI));
    await show();
    await typeDigits("83960");
    await press(screen.getByRole("button", { name: "8 3 9 6 0, Koli" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(sent).toEqual([{ postalCode: "83960" }]);
    expect(screen.getByLabelText("Postal code").props.value).toBe("");
    expect(screen.queryAllByRole("button", { name: /Koli/ })).toEqual([]);
    // The town alone now: no area was kept, and the screen says so.
    expect(screen.getByText("Your card shows the nearest town.")).toBeTruthy();
    expect(screen.getByText("On your card: Joensuu")).toBeTruthy();
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
    expect(screen.getByText("On your card: Joensuu")).toBeTruthy();
  });

  it("offers the field alone to somebody with no home, whose place left the list", async () => {
    const sent = fakeApi(null, () => json(IN_KALLIO));
    await show();
    expect(screen.queryByRole("heading", { name: "What should your card show?" })).toBeNull();
    expect(screen.queryByText(/On your card/)).toBeNull();
    noProblems();
    await typeDigits("00530");
    await press(screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }));
    await waitFor(() => expect(screen.getByText("On your card: Helsinki")).toBeTruthy());
    expect(sent).toEqual([{ postalCode: "00530" }]);
  });

  it("says a code the API lacks in its own words, keeps the digits, and lets another go through", async () => {
    let refuse = true;
    fakeApi(IN_KALLIO, () => (refuse ? refusal("postal_code_unknown", 400) : json(IN_KOLI)));
    await show();
    await typeDigits("83960");
    await press(screen.getByRole("button", { name: "8 3 9 6 0, Koli" }));
    await waitFor(() =>
      expect(
        screen.getByText("We can't find that code. Choose the nearest area from the list."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(screen.getByLabelText("Postal code").props.value).toBe("83960");
    expect(screen.getByText("On your card: Helsinki")).toBeTruthy();
    // The refused row is gone, with the nearest areas in its place, and the screen says why once.
    expect(screen.queryByRole("button", { name: "8 3 9 6 0, Koli" })).toBeNull();
    expect(
      screen.getAllByText("We can't find that code. Choose the nearest area from the list."),
    ).toHaveLength(1);
    refuse = false;
    await typeDigits("83940");
    await press(screen.getByRole("button", { name: "8 3 9 4 0, Nunnanlahti" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(
      screen.queryByText("We can't find that code. Choose the nearest area from the list."),
    ).toBeNull();
  });

  it.each([
    ["a refusal of another code", () => refusal("internal_error", 500)],
    ["an answer the contract refuses", () => json({ town: "Helsinki" })],
  ])("says that it could not be saved on %s", async (_what, answer) => {
    fakeApi(IN_KALLIO, answer);
    await show();
    await press(screen.getByRole("button", { name: "Kallio" }));
    await waitFor(() => expect(screen.getByText("It could not be saved. Try again.")).toBeTruthy());
    expect(selected("Helsinki")).toBe(true);
    expect(screen.getByText("On your card: Helsinki")).toBeTruthy();
  });

  it("says it is saving, holds the buttons meanwhile, and the notice goes with the next tap", async () => {
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
    await press(screen.getByRole("button", { name: "Kallio" }));
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }).props.accessibilityState?.disabled,
    ).toBe(true);
    await press(screen.getByRole("button", { name: "Helsinki" }));
    expect(sent).toHaveLength(1);
    await act(async () => {
      answer?.(json({ ...IN_KALLIO, showArea: true }));
      await settle();
    });
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it.each([
    ["saved", "polite", () => json({ ...IN_KALLIO, showArea: true }), "Saved."],
    [
      "refused",
      "assertive",
      () => refusal("internal_error", 500),
      "It could not be saved. Try again.",
    ],
  ])(
    "says a %s notice where it appears, on Android by its live region",
    async (_what, region, save, words) => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      fakeApi(IN_KALLIO, save);
      await show();
      await press(screen.getByRole("button", { name: "Kallio" }));
      await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
      expect(screen.getByText(words).props.accessibilityLiveRegion).toBe(region);
      expect(announce).not.toHaveBeenCalled();
    },
  );

  it("speaks the notice on iOS, which has no live regions", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const announce = spoken();
    fakeApi(IN_KALLIO, () => json({ ...IN_KALLIO, showArea: true }));
    await show();
    await press(screen.getByRole("button", { name: "Kallio" }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith("Saved."));
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
    ["fi-FI", "Koti", "Kortillasi: Helsinki"],
    ["sv-FI", "Hem", "På ditt kort: Helsingfors"],
  ])("speaks %s", async (tag, title, line) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    fakeApi(IN_KALLIO);
    await show();
    expectPinnedHeader(
      title,
      tag === "fi-FI" ? "Takaisin profiiliisi" : "Tillbaka till din profil",
    );
    expect(screen.getByText(line)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText("On your card: Helsinki")).toBeTruthy());
  });
});
