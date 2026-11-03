import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { DealBreakersScreen } from "./DealBreakersScreen";

// The deal-breakers' rows (#551), each saying what it holds and opening its own
// screen. What you seek shows the same rows (seek/SeekScreen.test.tsx).

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
};
const settle = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);

type Stored = { field: string; accept: string[]; includeUnknown: boolean; paused: boolean };
type Server = {
  fields: Record<string, unknown>;
  dealBreakers: Stored[];
  max: number;
  noProfile: boolean;
  noDealBreakers: boolean;
};

const filter = (field: string, accept: string[], paused = false): Stored => ({
  field,
  accept,
  includeUnknown: true,
  paused,
});

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    fields: {
      monogamy: "monogamous",
      hasKids: "no",
      wantsKids: "want",
      smoking: "never",
      languages: ["fi"],
      height: 170,
    },
    dealBreakers: [],
    max: 7,
    noProfile: false,
    noDealBreakers: false,
    ...start,
  };
  const reads: string[] = [];
  const broken = () => json({ error: { code: "x", message: "no", requestId: "r" } }, 500);
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    reads.push(`${request.method} ${path}`);
    if (path === "/profile") {
      if (server.noProfile) return broken();
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: server.fields,
          prompts: [],
          specialCategoryConsent: null,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
        home: null,
      });
    }
    if (path === "/preferences/deal-breakers") {
      if (server.noDealBreakers) return broken();
      return json({ dealBreakers: server.dealBreakers, max: server.max });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, reads };
}

const TITLES = [
  "Relationship structure",
  "Kids",
  "Kids in the future",
  "Smoking",
  "Languages",
  "Height",
  "Distance",
];

const row = (title: string) => screen.getByRole("button", { name: title });
const heard = (title: string) => row(title).props.accessibilityValue?.text as string | undefined;
/** The answer drawn under the row's title and heard once, as the value: no hint repeats it. */
function expectValue(title: string, words: string) {
  expect(within(row(title)).getByText(words)).toBeTruthy();
  expect(row(title).props.accessibilityValue).toEqual({ text: words });
  expect(row(title).props.accessibilityHint).toBeUndefined();
}

const opened = async (start?: Partial<Server>) => {
  const api = fakeApi(start);
  await show(<DealBreakersScreen />);
  await waitFor(() => expect(row("Smoking")).toBeTruthy());
  await waitFor(() => expect(heard("Distance")).toBeDefined());
  return api;
};
const backInFront = () =>
  act(async () => {
    focus();
    await settle();
  });

beforeEach(async () => {
  router.push.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("DealBreakersScreen", () => {
  it("keeps its title and the way back pinned above the rows", async () => {
    await opened();
    expectPinnedHeader("Deal-breakers", "Back");
    await press(row("Back"));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("has a row per deal-breaker, the fields' order with the distance last, and nothing else to press", async () => {
    await opened();
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      "Back",
      ...TITLES,
    ]);
    expect(screen.queryByRole("switch")).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(TITLES.length + 1);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("draws each field's icon on its row, with the chevron, and neither is heard", async () => {
    await opened();
    const drawn = (node: unknown): number =>
      JSON.stringify(node).match(/"vbWidth":24/g)?.length ?? 0;
    // The arrow in the header, and an icon and a chevron on each row.
    expect(drawn(screen.toJSON())).toBe(1 + 2 * TITLES.length);
    expect(pressables(screen.toJSON() as HostNode)).toHaveLength(TITLES.length + 1);
  });

  it("says how many a person may hold and on what, over the rows", async () => {
    await opened({ max: 3 });
    expect(screen.getByText(/^Up to 3\. Only on what you answered yourself/)).toBeTruthy();
  });

  it("opens each row's own screen", async () => {
    await opened();
    for (const title of TITLES) await press(row(title));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/profile/deal-breakers/monogamy",
      "/profile/deal-breakers/hasKids",
      "/profile/deal-breakers/wantsKids",
      "/profile/deal-breakers/smoking",
      "/profile/deal-breakers/languages",
      "/profile/deal-breakers/height",
      "/profile/deal-breakers/distance",
    ]);
  });

  describe("what a row says", () => {
    it("says Everyone where nothing is set and the own answer is given", async () => {
      await opened();
      for (const title of TITLES) expectValue(title, "Everyone");
    });

    it("asks for the own answer first where it is missing, but never of the distance", async () => {
      await opened({ fields: {} });
      for (const title of TITLES.slice(0, -1)) expectValue(title, "Share yours first");
      expectValue("Distance", "Everyone");
    });

    it.each([
      ["one answer, as a filter says it", "smoking", ["never"], "Smoking", "Never"],
      [
        "the answers in the registry's order, whatever order they were stored in",
        "smoking",
        ["quitting", "never"],
        "Smoking",
        "Never, Quitting",
      ],
      ["kids as somebody else's", "hasKids", ["yes_with_me"], "Kids", "Kids at home"],
      [
        "wanting kids as somebody else's",
        "wantsKids",
        ["want"],
        "Kids in the future",
        "Wants kids",
      ],
      ["a relation in its button's words", "height", ["taller"], "Height", "Taller than me"],
      ["a band alone", "distance", ["nearby"], "Distance", "Nearby"],
      ["the bands by the farthest", "distance", ["nearby", "close"], "Distance", "Close"],
      [
        "three answers in full",
        "languages",
        ["fi", "sv", "en"],
        "Languages",
        "Finnish, Swedish, English",
      ],
      [
        "four as three and how many more",
        "languages",
        ["fi", "sv", "en", "de"],
        "Languages",
        "Finnish, Swedish, English and 1 more",
      ],
    ])("says %s", async (_what, field, accept, title, words) => {
      await opened({ dealBreakers: [filter(field, accept)] });
      expectValue(title, words);
    });

    it("keeps a row short however many a filter takes: sixty is the contract's", async () => {
      const accept = ["fi", "sv", "en", "de", "fr", "es", "it", "ru", "et", "so"];
      await opened({ dealBreakers: [filter("languages", accept)] });
      expectValue("Languages", "Finnish, Swedish, English and 7 more");
    });

    it("says a filter is paused in words, naming no answer, and leaves the others as they are", async () => {
      await opened({
        fields: { hasKids: "no" },
        dealBreakers: [filter("smoking", ["never"], true), filter("hasKids", ["no"])],
      });
      expectValue("Smoking", "Paused until you answer it yourself.");
      expectValue("Kids", "No kids");
      expect(screen.queryByText("Never")).toBeNull();
    });

    it("says nothing when the deal-breakers could not be read: a row's screen says why", async () => {
      const api = fakeApi({ noDealBreakers: true });
      await show(<DealBreakersScreen />);
      await waitFor(() => expect(row("Smoking")).toBeTruthy());
      expect(api.reads).toContain("GET /preferences/deal-breakers");
      for (const title of TITLES) expect(heard(title)).toBeUndefined();
      expect(screen.queryByText("Everyone")).toBeNull();
      expect(screen.queryByText(/^Up to/)).toBeNull();
      expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
      await press(row("Smoking"));
      expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers/smoking");
    });
  });

  it("reads everything once as it opens, and again when a deal-breaker's screen hands back", async () => {
    const { server, reads } = await opened();
    const count = (path: string) => reads.filter((read) => read === `GET ${path}`).length;
    expect(count("/profile")).toBe(1);
    expect(count("/preferences/deal-breakers")).toBe(1);

    server.dealBreakers = [filter("smoking", ["never"])];
    server.fields = { smoking: "never" };
    await backInFront();
    await waitFor(() => expect(heard("Smoking")).toBe("Never"));
    expectValue("Kids", "Share yours first");
    expect(count("/profile")).toBe(2);
    expect(count("/preferences/deal-breakers")).toBe(2);
  });

  it("says it is loading until the own answers are read, in a live region", async () => {
    globalThis.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    await show(<DealBreakersScreen />);
    expect(screen.getByText("Loading your profile…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: "Smoking" })).toBeNull();
  });

  it("says when the own answers could not be read, and tries again, the deal-breakers with them", async () => {
    const { server, reads } = fakeApi({ noProfile: true });
    await show(<DealBreakersScreen />);
    await waitFor(() => expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy());
    server.noProfile = false;
    server.dealBreakers = [filter("smoking", ["never"])];
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(heard("Smoking")).toBe("Never"));
    expect(reads.filter((read) => read === "GET /preferences/deal-breakers")).toHaveLength(2);
  });

  it.each([
    [
      "fi-FI",
      {
        title: "Ehdottomat rajat",
        back: "Takaisin",
        rows: [
          ["Tupakointi", "Ei koskaan"],
          ["Lapset", "Kaikki"],
          ["Lapset tulevaisuudessa", "Kerro ensin omasi"],
          ["Kielet", "Suomi, Ruotsi, Englanti ja 1 muu"],
          ["Pituus", "Tauolla, kunnes vastaat siihen itse."],
          ["Etäisyys", "Melko lähellä"],
        ],
      },
    ],
    [
      "sv-FI",
      {
        title: "Absoluta gränser",
        back: "Tillbaka",
        rows: [
          ["Rökning", "Aldrig"],
          ["Barn", "Alla"],
          ["Barn i framtiden", "Dela ditt eget först"],
          ["Språk", "Finska, Svenska, Engelska och 1 till"],
          ["Längd", "Pausad tills du själv svarar på det."],
          ["Avstånd", "Ganska nära"],
        ],
      },
    ],
  ])("speaks %s", async (tag, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi({
        fields: { hasKids: "no", smoking: "never", languages: ["fi"] },
        dealBreakers: [
          filter("smoking", ["never"]),
          filter("languages", ["fi", "sv", "en", "de"]),
          filter("height", ["taller"], true),
          filter("distance", ["nearby", "close"]),
        ],
      });
      await show(<DealBreakersScreen />);
      const [lastTitle] = words.rows.at(-1) as string[];
      await waitFor(() => expect(heard(lastTitle as string)).toBeDefined());
      expectPinnedHeader(words.title, words.back);
      for (const [title, value] of words.rows) expectValue(title as string, value as string);
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
