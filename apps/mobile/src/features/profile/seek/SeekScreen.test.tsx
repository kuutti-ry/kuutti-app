import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { AccessibilityInfo } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SeekScreen } from "./SeekScreen";

// What a person seeks, as a list of its own (#542): each row its answer under
// onboarding's own question, heard once, and nothing edited here. Beside the
// deal-breakers' heading how many are in use, and the app's one (i) (#581); the
// rows' own words and where each goes are DealBreakerRows.test.tsx's.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = (ui: React.ReactElement) =>
  act(async () => {
    await renderWithTheme(ui);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const broken = () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);

const CONSENT = { version: "2026-10-01", at: "2026-10-01T10:00:00.000Z" };
const dealBreaker = (field: string, accept: string[], paused = false) => ({
  field,
  accept,
  includeUnknown: true,
  paused,
});

/** What the API keeps; a test changes it between reads, as a screen handing back has. */
type Server = {
  seeks: string[] | null;
  ageWindow: { min: number; max: number } | null;
  fields: Record<string, unknown>;
  consent: typeof CONSENT | null;
  dealBreakers: ReturnType<typeof dealBreaker>[];
  /** Every read fails. */
  failing: boolean;
  /** The deal-breakers alone cannot be read. */
  noDealBreakers: boolean;
  /** How many deal-breakers a person may hold. */
  max: number;
  /** Every read waits for this. */
  wait: Promise<void>;
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    seeks: ["woman"],
    ageWindow: { min: 25, max: 40 },
    fields: { intent: "long_term" },
    consent: CONSENT,
    dealBreakers: [],
    failing: false,
    noDealBreakers: false,
    max: 2,
    wait: Promise.resolve(),
    ...start,
  };
  const reads = { preferences: 0, profile: 0, dealBreakers: 0 };
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    await server.wait;
    if (path === "/preferences" && request.method === "GET") {
      reads.preferences += 1;
      if (server.failing) return broken();
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    if (path === "/profile" && request.method === "GET") {
      reads.profile += 1;
      if (server.failing) return broken();
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: server.fields,
          prompts: [],
          specialCategoryConsent: server.consent,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
        home: null,
      });
    }
    if (path === "/preferences/deal-breakers" && request.method === "GET") {
      reads.dealBreakers += 1;
      if (server.failing || server.noDealBreakers) return broken();
      return json({ dealBreakers: server.dealBreakers, max: server.max });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, reads };
}

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; dismissTo: jest.Mock };
  __focus: () => void;
};

const ABOUT = "About deal-breakers";
const WHOM = "Whom are you looking for?";
const AGES = "What ages?";
const INTENT = "What are you here for?";
const SMOKING = "Smoking";
const KIDS = "Kids";
/** Every question a deal-breaker asks of the person answered: each row opens its own screen. */
const ANSWERED = {
  intent: "long_term",
  monogamy: "monogamous",
  hasKids: "no",
  wantsKids: "want",
  smoking: "never",
  languages: ["fi"],
  height: 170,
};
const DEAL_BREAKER_ROWS = [
  "Relationship structure",
  KIDS,
  "Kids in the future",
  SMOKING,
  "Languages",
  "Height",
  "Distance",
];

const row = (title: string) => screen.getByRole("button", { name: title });
const heard = (title: string) => row(title).props.accessibilityValue?.text as string | undefined;

/**
 * The answer drawn under the row's title and heard once, as the value: no hint
 * repeats it. The hint says only what the row's star says, where it has one (#616).
 */
function expectAnswer(title: string, answer: string) {
  expect(within(row(title)).getByText(answer)).toBeTruthy();
  expect(row(title).props.accessibilityValue).toEqual({ text: answer });
  expect(row(title).props.accessibilityHint ?? "").not.toContain(answer);
}

const opened = async (start?: Partial<Server>) => {
  const api = fakeApi(start);
  await show(<SeekScreen />);
  await waitFor(() => expect(row(WHOM)).toBeTruthy());
  return api;
};

/** The line behind the (i), and over nothing else. */
const BEHIND_THE_I =
  "Up to 2. Only on what you answered yourself, and both ways: yours apply to others, theirs to you.";

/** Comes back to the list, as a screen handing back does. */
const handBack = () =>
  act(async () => {
    focus();
    await settle();
  });

const inLocale = async (tag: string, run: () => Promise<void>) => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
  try {
    await run();
  } finally {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  }
};

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

describe("SeekScreen", () => {
  it("keeps the title and the way back pinned above the list", async () => {
    await opened();
    expectPinnedHeader("What you seek", "Back");
  });

  it("says at the top that the answers work both ways, naming no moment", async () => {
    await opened();
    expect(
      screen.getByText(
        "These work both ways: they decide whom you see and who sees you. Conversations you already have stay as they are.",
      ),
    ).toBeTruthy();
  });

  it("stars whom one seeks and the ages, what the card needs, and not what one is here for, and says what the star means under them (#616)", async () => {
    await opened();
    const needed = "Needed before your card can be shown";
    for (const name of [WHOM, AGES]) {
      expect(screen.getByRole("button", { name }).props.accessibilityHint).toMatch(
        new RegExp(`^${needed}`),
      );
      expect(screen.getByText(`${name} *`)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: INTENT }).props.accessibilityHint ?? "").not.toMatch(
      needed,
    );
    expect(screen.queryByText(`${INTENT} *`)).toBeNull();
    expect(screen.getByText(`* ${needed}`).props.accessibilityLabel).toBe(needed);
  });

  it("has onboarding's three questions in their order, then a row per deal-breaker, and nothing else to press", async () => {
    await opened();
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      "Back",
      WHOM,
      AGES,
      INTENT,
      ABOUT,
      ...DEAL_BREAKER_ROWS,
    ]);
  });

  it("puts the deal-breakers under a heading of their own, how many are in use beside it, the line on what they ask behind the (i)", async () => {
    await opened();
    await waitFor(() => expect(heard(SMOKING)).toBeDefined());
    const heading = screen.getByRole("heading", { name: "Deal-breakers" });
    expect(heading.props["aria-level"]).toBe("2");
    expect(screen.queryByText(BEHIND_THE_I)).toBeNull();
    const flat = JSON.stringify(screen.toJSON());
    const places = [INTENT, '"Deal-breakers"', '"0/2"', ABOUT, DEAL_BREAKER_ROWS[0] as string].map(
      (word) => flat.indexOf(word),
    );
    expect(places).not.toContain(-1);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    // All three in one row: a 44 pt one, by the (i).
    const count = screen.getByText("0/2");
    expect(count.parent).toBe(heading.parent);
    expect(screen.getByRole("button", { name: ABOUT }).parent).toBe(heading.parent);
    // 44 pt with or without the button, so the rows do not jump when the read lands.
    expect(heading.parent?.props.className).toMatch(/\bmin-h-touch\b/);
    expect(heading.parent?.props.className).toMatch(/\bflex-row\b/);
  });

  describe("how many are in use (#581)", () => {
    it.each([
      ["none", [], "0/2", "0 of 2 in use"],
      ["one", [dealBreaker("smoking", ["never"])], "1/2", "1 of 2 in use"],
      [
        "a paused one among them: it stands, and counts against the number",
        [dealBreaker("smoking", ["never"]), dealBreaker("hasKids", ["no"], true)],
        "2/2",
        "2 of 2 in use",
      ],
    ])("counts %s, drawn short and heard in words", async (_what, dealBreakers, drawn, words) => {
      await opened({ dealBreakers });
      await waitFor(() => expect(screen.getByText(drawn)).toBeTruthy());
      expect(screen.getByText(drawn).props.accessibilityLabel).toBe(words);
    });

    it("follows a screen handing back", async () => {
      const { server } = await opened();
      await waitFor(() => expect(screen.getByText("0/2")).toBeTruthy());
      server.dealBreakers = [dealBreaker("smoking", ["never"])];
      await handBack();
      await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
      expect(screen.queryByText("0/2")).toBeNull();
    });
  });

  describe("the (i) beside the heading, the maintainer's one (#581)", () => {
    const about = () => screen.getByRole("button", { name: ABOUT });
    const shown = async () => {
      await opened();
      await waitFor(() => expect(about()).toBeTruthy());
    };

    it("is a labelled button with a 44 pt target, an icon a screen reader does not hear", async () => {
      await shown();
      const problems = pressables(screen.toJSON() as HostNode).flatMap((node) =>
        a11yProblems(node),
      );
      expect(problems).toEqual([]);
      expect(about().props.className).toMatch(/\bmin-h-touch\b/);
      expect(within(about()).queryAllByText(/./)).toEqual([]);
    });

    it("opens the shared dialog with the heading and the line, the limit read from the API", async () => {
      await shown();
      expect(screen.container.queryAll((node) => node.props.role === "dialog")).toHaveLength(0);
      await press(about());
      const [dialog] = screen.container.queryAll(
        (node) => typeof node.type === "string" && node.props.role === "dialog",
      );
      if (!dialog) throw new Error("no dialog");
      expect(within(dialog).getByRole("heading", { name: "Deal-breakers" })).toBeTruthy();
      expect(within(dialog).getByText(BEHIND_THE_I)).toBeTruthy();
      expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    });

    it("takes the focus to its title as it opens: the button that opened it is under the scrim", async () => {
      await shown();
      const focused = AccessibilityInfo.sendAccessibilityEvent as jest.Mock;
      focused.mockClear();
      await press(about());
      expect(focused).toHaveBeenCalledTimes(1);
      expect(focused).toHaveBeenCalledWith(expect.anything(), "focus");
    });

    it("shuts with its labelled close, and comes back on the next press", async () => {
      await shown();
      await press(about());
      await press(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText(BEHIND_THE_I)).toBeNull();
      await press(about());
      expect(screen.getByText(BEHIND_THE_I)).toBeTruthy();
    });

    it("says the limit the API read, whatever it is", async () => {
      const { server } = fakeApi();
      server.max = 5;
      await show(<SeekScreen />);
      await waitFor(() => expect(about()).toBeTruthy());
      await press(about());
      expect(screen.getByText(/^Up to 5\. Only on what you answered yourself/)).toBeTruthy();
    });

    it("goes when the deal-breakers cannot be vouched for, with the count, and comes back with them", async () => {
      const { server } = await opened();
      await waitFor(() => expect(about()).toBeTruthy());
      server.noDealBreakers = true;
      await handBack();
      await waitFor(() => expect(screen.queryByRole("button", { name: ABOUT })).toBeNull());
      expect(screen.queryByText("0/2")).toBeNull();
      expect(screen.getByRole("heading", { name: "Deal-breakers" })).toBeTruthy();
      server.noDealBreakers = false;
      await handBack();
      await waitFor(() => expect(about()).toBeTruthy());
      expect(screen.getByText("0/2")).toBeTruthy();
    });
  });

  it("draws each answer under its title and has it heard once, as the value", async () => {
    await opened({ dealBreakers: [dealBreaker("smoking", ["never"])] });
    await waitFor(() => expect(heard(SMOKING)).toBe("Never"));
    expectAnswer(WHOM, "Women");
    expectAnswer(AGES, "Youngest 25, oldest 40");
    expectAnswer(INTENT, "Something long-term");
    expectAnswer(SMOKING, "Never");
  });

  it("has every control labelled, a button and a full target", async () => {
    await opened();
    const found = pressables(screen.toJSON() as HostNode);
    // The back arrow, the three questions and the (i), and the rows.
    expect(found).toHaveLength(5 + DEAL_BREAKER_ROWS.length);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it.each([
    ["one", ["man"], "Men"],
    ["two", ["woman", "non_binary"], "Women, Non-binary people"],
    ["two stored the other way round", ["non_binary", "woman"], "Women, Non-binary people"],
    ["all three", ["woman", "man", "non_binary"], "Anyone"],
    ["all three stored in another order", ["non_binary", "woman", "man"], "Anyone"],
  ])("says whom in the rows' order, Anyone for all three: %s", async (_what, seeks, words) => {
    await opened({ seeks });
    expectAnswer(WHOM, words);
  });

  it.each([
    ["a window", { min: 25, max: 40 }, "Youngest 25, oldest 40"],
    ["the widest window", { min: 18, max: 99 }, "Youngest 18, oldest 99"],
    ["one year", { min: 30, max: 30 }, "Youngest 30, oldest 30"],
  ])("says the ages in words: %s", async (_what, ageWindow, words) => {
    await opened({ ageWindow });
    expectAnswer(AGES, words);
  });

  it("has nothing under the question and no value while what one is here for is unanswered", async () => {
    await opened({ fields: {} });
    expect(heard(INTENT)).toBeUndefined();
    expect(row(INTENT).props.accessibilityHint).toBeUndefined();
    // The title is the row's one text.
    expect(within(row(INTENT)).getAllByText(/./)).toHaveLength(1);
    await press(row(INTENT));
    expect(router.push).toHaveBeenCalledWith("/profile/section/intent");
  });

  it("says what each deal-breaker holds, from what is stored and what the person answered (#551)", async () => {
    await opened({
      fields: { intent: "long_term", hasKids: "no", languages: ["fi"] },
      dealBreakers: [
        dealBreaker("hasKids", ["no", "yes_not_with_me"]),
        dealBreaker("smoking", ["never"], true),
        dealBreaker("languages", ["fi", "sv", "en", "de", "et"]),
        dealBreaker("distance", ["nearby", "close"]),
      ],
    });
    await waitFor(() => expect(heard(SMOKING)).toBeDefined());
    // Unanswered and not set; answers said as somebody else's; paused; capped; by the farthest band.
    expectAnswer("Relationship structure", "Share yours first");
    expectAnswer(KIDS, "No kids, Kids living elsewhere");
    expectAnswer(SMOKING, "Paused until you answer it yourself.");
    expectAnswer("Languages", "Finnish, Swedish, English and 2 more");
    expectAnswer("Distance", "Close");
  });

  it("says Everyone on what the person answered and set no filter on", async () => {
    await opened({ fields: { intent: "long_term", smoking: "never" } });
    await waitFor(() => expect(heard(SMOKING)).toBeDefined());
    expectAnswer(SMOKING, "Everyone");
    expectAnswer(KIDS, "Share yours first");
  });

  it("says nothing of the deal-breakers when they could not be read: each one's screen says why", async () => {
    const { reads } = await opened({ noDealBreakers: true });
    expect(reads.dealBreakers).toBe(1);
    for (const title of DEAL_BREAKER_ROWS) {
      expect(heard(title)).toBeUndefined();
      expect(row(title).props.accessibilityHint).toBeUndefined();
    }
    expect(screen.queryByText("Everyone")).toBeNull();
    // No count and no (i): nothing is known that they could say.
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    expect(screen.queryByRole("button", { name: ABOUT })).toBeNull();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
    await press(row(SMOKING));
    expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers/smoking");
  });

  it("opens each row's own screen, and goes back with its back button", async () => {
    await opened({ fields: ANSWERED });
    await waitFor(() => expect(heard(SMOKING)).toBe("Everyone"));
    for (const title of [WHOM, AGES, INTENT, ...DEAL_BREAKER_ROWS]) await press(row(title));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/profile/seek/whom",
      "/profile/seek/ages",
      "/profile/section/intent",
      "/profile/deal-breakers/monogamy",
      "/profile/deal-breakers/hasKids",
      "/profile/deal-breakers/wantsKids",
      "/profile/deal-breakers/smoking",
      "/profile/deal-breakers/languages",
      "/profile/deal-breakers/height",
      "/profile/deal-breakers/distance",
    ]);
    expect(router.back).not.toHaveBeenCalled();
    await press(row("Back"));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("opens the question itself from a row that says Share yours first, whose screen would only say it again (#581)", async () => {
    await opened({
      fields: { intent: "long_term", smoking: "never" },
      dealBreakers: [dealBreaker("hasKids", ["no"], true)],
    });
    await waitFor(() => expect(heard(SMOKING)).toBe("Everyone"));
    expectAnswer("Kids in the future", "Share yours first");
    await press(row("Kids in the future"));
    await press(row("Relationship structure"));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      { pathname: "/profile/later/[field]", params: { field: "wantsKids", once: "1" } },
      { pathname: "/profile/section/[id]", params: { id: "relationship", once: "1" } },
    ]);
    router.push.mockClear();
    // A paused one keeps its screen, and the distance asks for no answer.
    await press(row(KIDS));
    await press(row("Distance"));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/profile/deal-breakers/hasKids",
      "/profile/deal-breakers/distance",
    ]);
  });

  it("the row says Everyone once that answer is given and the question hands back, and opens its own screen", async () => {
    const { server } = await opened({ fields: { intent: "long_term" } });
    await waitFor(() => expect(heard(SMOKING)).toBe("Share yours first"));
    server.fields = { intent: "long_term", smoking: "never" };
    await handBack();
    await waitFor(() => expect(heard(SMOKING)).toBe("Everyone"));
    await press(row(SMOKING));
    expect(router.push).toHaveBeenLastCalledWith("/profile/deal-breakers/smoking");
  });

  it("reads everything once as it opens, and again each time a screen hands back", async () => {
    const { server, reads } = await opened();
    // The first focus is the mount, which the hook reads already.
    expect(reads).toEqual({ preferences: 1, profile: 1, dealBreakers: 1 });

    server.seeks = ["man"];
    server.ageWindow = { min: 30, max: 50 };
    server.fields = { intent: "casual", hasKids: "no" };
    server.dealBreakers = [dealBreaker("hasKids", ["no"])];
    await handBack();
    expect(reads).toEqual({ preferences: 2, profile: 2, dealBreakers: 2 });
    await waitFor(() => expect(heard(KIDS)).toBe("No kids"));
    expectAnswer(WHOM, "Men");
    expectAnswer(AGES, "Youngest 30, oldest 50");
    expectAnswer(INTENT, "Something casual");

    await handBack();
    expect(reads).toEqual({ preferences: 3, profile: 3, dealBreakers: 3 });
  });

  it("stays on the list while it reads again: no loading screen in between", async () => {
    const { server } = await opened();
    let answer: (() => void) | undefined;
    server.wait = new Promise((resolve) => {
      answer = resolve;
    });
    server.seeks = ["man"];
    await handBack();
    expect(screen.queryByText("Loading…")).toBeNull();
    expectAnswer(WHOM, "Women");
    await act(async () => {
      answer?.();
      await settle();
    });
    await waitFor(() => expectAnswer(WHOM, "Men"));
  });

  it("takes nothing away when a read again fails, but the deal-breakers it can no longer vouch for", async () => {
    const { server } = await opened({
      fields: { intent: "long_term", smoking: "never" },
      dealBreakers: [dealBreaker("smoking", ["never"])],
    });
    await waitFor(() => expect(heard(SMOKING)).toBe("Never"));
    server.failing = true;
    await handBack();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
    expectAnswer(WHOM, "Women");
    expect(heard(SMOKING)).toBeUndefined();
    expect(screen.queryByText("Never")).toBeNull();
  });

  it("goes back to Home when a screen hands back and the consent is gone", async () => {
    const { server } = await opened();
    expect(router.dismissTo).not.toHaveBeenCalled();
    server.consent = null;
    await handBack();
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says it is loading until the answers are read, in a live region, with no row", async () => {
    const { server } = fakeApi();
    server.wait = new Promise(() => {});
    await show(<SeekScreen />);
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What you seek" })).toBeNull();
  });

  it("shows the rows before the deal-breakers are known, saying nothing of them", async () => {
    const { server } = fakeApi({
      fields: { intent: "long_term", smoking: "never" },
      dealBreakers: [dealBreaker("smoking", ["never"])],
    });
    let answer: ((response: Response) => void) | undefined;
    const others = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/preferences/deal-breakers")
        return others(input, init);
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }) as unknown as typeof fetch;
    await show(<SeekScreen />);
    await waitFor(() => expect(row(WHOM)).toBeTruthy());
    await waitFor(() => expect(answer).toBeDefined());
    expect(heard(SMOKING)).toBeUndefined();
    expect(screen.queryByText("Everyone")).toBeNull();
    await act(async () => {
      answer?.(json({ dealBreakers: server.dealBreakers, max: 2 }));
      await settle();
    });
    await waitFor(() => expect(heard(SMOKING)).toBe("Never"));
  });

  it("says when the answers could not be read, and tries again, the deal-breakers with them", async () => {
    const { server } = fakeApi({
      failing: true,
      fields: { intent: "long_term", smoking: "never" },
      dealBreakers: [dealBreaker("smoking", ["never"])],
    });
    await show(<SeekScreen />);
    await waitFor(() => expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy());
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);

    server.failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(heard(SMOKING)).toBe("Never"));
    expectAnswer(WHOM, "Women");
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });

  it("says it is loading again while Try again reads", async () => {
    const { server } = fakeApi({ failing: true });
    await show(<SeekScreen />);
    await waitFor(() => expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy());
    let answer: (() => void) | undefined;
    server.wait = new Promise((resolve) => {
      answer = resolve;
    });
    server.failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
    await act(async () => {
      answer?.();
      await settle();
    });
    await waitFor(() => expect(row(WHOM)).toBeTruthy());
  });

  it("sends whoever lacks the consent back to Home, and shows no row of it", async () => {
    fakeApi({ consent: null });
    await show(<SeekScreen />);
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      {
        title: "Mitä etsit",
        back: "Takaisin",
        explain:
          "Nämä toimivat molempiin suuntiin: ne ratkaisevat, keitä näet ja ketkä näkevät sinut. Keskustelusi pysyvät ennallaan.",
        whom: ["Ketä etsit?", "Naisia, Muunsukupuolisia"],
        ages: ["Minkä ikäisiä?", "Nuorin 25, vanhin 40"],
        intent: ["Mitä etsit täältä?", "Jotain pitkäaikaista"],
        heading: "Ehdottomat rajat",
        count: "Käytössä 1, enintään 2",
        about: "Tietoa ehdottomista rajoista",
        line: "Enintään 2. Vain siitä, mihin vastasit itse, ja molempiin suuntiin: sinun rajasi koskevat muita, heidän rajansa sinua.",
        close: "Sulje",
        paused: ["Tupakointi", "Tauolla, kunnes vastaat siihen itse."],
      },
    ],
    [
      "sv-FI",
      {
        title: "Vad du söker",
        back: "Tillbaka",
        explain:
          "De här gäller åt båda håll: de avgör vilka du ser och vilka som ser dig. Samtal du redan har förblir som de är.",
        whom: ["Vem söker du?", "Kvinnor, Icke-binära personer"],
        ages: ["Vilka åldrar?", "Yngsta 25, äldsta 40"],
        intent: ["Vad är du här för?", "Något långvarigt"],
        heading: "Absoluta gränser",
        count: "1 av 2 används",
        about: "Om absoluta gränser",
        line: "Högst 2. Bara om det du själv svarat på, och åt båda hållen: dina gäller andra, deras gäller dig.",
        close: "Stäng",
        paused: ["Rökning", "Pausad tills du själv svarar på det."],
      },
    ],
  ] as const)("speaks %s", async (tag, words) => {
    await inLocale(tag, async () => {
      fakeApi({
        seeks: ["non_binary", "woman"],
        dealBreakers: [dealBreaker("smoking", ["never"], true)],
      });
      await show(<SeekScreen />);
      await waitFor(() => expect(heard(words.paused[0])).toBe(words.paused[1]));
      expectPinnedHeader(words.title, words.back);
      expect(screen.getByText(words.explain)).toBeTruthy();
      expect(screen.getByRole("heading", { name: words.heading })).toBeTruthy();
      for (const [title, answer] of [words.whom, words.ages, words.intent, words.paused]) {
        expectAnswer(title, answer);
      }
      expect(screen.getByText("1/2").props.accessibilityLabel).toBe(words.count);
      expect(screen.queryByText(words.line)).toBeNull();
      await press(row(words.about));
      expect(screen.getByText(words.line)).toBeTruthy();
      await press(row(words.close));
      expect(screen.queryByText(words.line)).toBeNull();
    });
  });

  it.each([
    ["fi-FI", "Ketä etsit?", "Kenet tahansa", "Tupakointi", "Kaikki"],
    ["sv-FI", "Vem söker du?", "Vem som helst", "Rökning", "Alla"],
  ])("says Anyone and Everyone in %s", async (tag, whom, anyone, smoking, everyone) => {
    await inLocale(tag, async () => {
      fakeApi({
        seeks: ["woman", "man", "non_binary"],
        fields: { intent: "long_term", smoking: "never" },
      });
      await show(<SeekScreen />);
      await waitFor(() => expect(heard(smoking)).toBe(everyone));
      expectAnswer(whom, anyone);
    });
  });
});
