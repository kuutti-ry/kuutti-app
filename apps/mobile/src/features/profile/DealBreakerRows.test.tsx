import type { DealBreakersResponse, ProfileFields, StoredDealBreaker } from "@kuutti/schema";
import { act, fireEvent, screen, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { DealBreakerRows, isOpenToFilter, ownAnswerPath } from "./DealBreakerRows";

// The deal-breakers' rows (#551), on What you seek (seek/SeekScreen.test.tsx has
// them read and read again): each saying what it holds and opening its own
// screen, or, where it says Share yours first, the question itself (#581).

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });

const filter = (field: string, accept: string[], paused = false) =>
  ({ field, accept, includeUnknown: true, paused }) as StoredDealBreaker;
const held = (...dealBreakers: StoredDealBreaker[]): DealBreakersResponse => ({
  dealBreakers,
  max: 7,
});

const ANSWERED = {
  monogamy: "monogamous",
  hasKids: "no",
  wantsKids: "want",
  smoking: "never",
  languages: ["fi"],
  height: 170,
} as ProfileFields;

const TITLES = [
  "Relationship structure",
  "Kids",
  "Kids in the future",
  "Smoking",
  "Languages",
  "Height",
  "Distance",
];

const show = (response: DealBreakersResponse | null, own: ProfileFields = ANSWERED) =>
  renderWithTheme(<DealBreakerRows response={response} own={own} />);
const row = (title: string) => screen.getByRole("button", { name: title });
/** The answer drawn under the row's title and heard once, as the value: no hint repeats it. */
function expectValue(title: string, words: string) {
  expect(within(row(title)).getByText(words)).toBeTruthy();
  expect(row(title).props.accessibilityValue).toEqual({ text: words });
  expect(row(title).props.accessibilityHint).toBeUndefined();
}

beforeEach(() => router.push.mockClear());

describe("DealBreakerRows", () => {
  it("has a row per deal-breaker, the fields' order with the distance last, and nothing else to press", async () => {
    await show(held());
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual(
      TITLES,
    );
    expect(screen.queryByRole("switch")).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(TITLES.length);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("draws each field's icon on its row, with the chevron, and neither is heard", async () => {
    await show(held());
    const drawn = JSON.stringify(screen.toJSON()).match(/"vbWidth":24/g)?.length ?? 0;
    // An icon and a chevron on each row.
    expect(drawn).toBe(2 * TITLES.length);
    expect(pressables(screen.toJSON() as HostNode)).toHaveLength(TITLES.length);
  });

  describe("what a row says", () => {
    it("says Everyone where nothing is set and the own answer is given", async () => {
      await show(held());
      for (const title of TITLES) expectValue(title, "Everyone");
    });

    it("asks for the own answer first where it is missing, but never of the distance", async () => {
      await show(held(), {});
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
      await show(held(filter(field, accept)));
      expectValue(title, words);
    });

    it("keeps a row short however many a filter takes: sixty is the contract's", async () => {
      const accept = ["fi", "sv", "en", "de", "fr", "es", "it", "ru", "et", "so"];
      await show(held(filter("languages", accept)));
      expectValue("Languages", "Finnish, Swedish, English and 7 more");
    });

    it("says a filter is paused in words, naming no answer, and leaves the others as they are", async () => {
      await show(held(filter("smoking", ["never"], true), filter("hasKids", ["no"])), {
        hasKids: "no",
      } as ProfileFields);
      expectValue("Smoking", "Paused until you answer it yourself.");
      expectValue("Kids", "No kids");
      expect(screen.queryByText("Never")).toBeNull();
    });

    it("says nothing when the deal-breakers could not be read: a row's screen says why", async () => {
      await show(null);
      for (const title of TITLES) {
        expect(row(title).props.accessibilityValue?.text).toBeUndefined();
        expect(row(title).props.accessibilityHint).toBeUndefined();
      }
      expect(screen.queryByText("Everyone")).toBeNull();
    });
  });

  describe("where a row goes", () => {
    const pressed = async () => {
      for (const title of TITLES) await press(row(title));
      return router.push.mock.calls.map(([path]) => path);
    };
    const later = (field: string) => ({
      pathname: "/profile/later/[field]",
      params: { field, once: "1" },
    });

    it("opens each one's own screen where the own answer is given", async () => {
      await show(held());
      expect(await pressed()).toEqual([
        "/profile/deal-breakers/monogamy",
        "/profile/deal-breakers/hasKids",
        "/profile/deal-breakers/wantsKids",
        "/profile/deal-breakers/smoking",
        "/profile/deal-breakers/languages",
        "/profile/deal-breakers/height",
        "/profile/deal-breakers/distance",
      ]);
    });

    it("opens the question itself where the row says Share yours first, and the distance asks none (#581)", async () => {
      await show(held(), {});
      expect(await pressed()).toEqual([
        { pathname: "/profile/section/[id]", params: { id: "relationship", once: "1" } },
        later("hasKids"),
        later("wantsKids"),
        later("smoking"),
        later("languages"),
        later("height"),
        "/profile/deal-breakers/distance",
      ]);
    });

    it("keeps a paused filter's screen, which says why it is paused and takes it off", async () => {
      await show(held(filter("smoking", ["never"], true)), {});
      await press(row("Smoking"));
      expect(router.push.mock.calls).toEqual([["/profile/deal-breakers/smoking"]]);
    });

    it("opens the screen of a filter whose own answer is gone before the API says it is paused", async () => {
      // A filter there is, so a screen to come to: the question would leave it unseen.
      await show(held(filter("hasKids", ["no"])), {});
      await press(row("Kids"));
      expect(router.push.mock.calls).toEqual([["/profile/deal-breakers/hasKids"]]);
    });

    it("opens the screen with nothing read, which says what failed: nothing says Share yours first", async () => {
      await show(null, {});
      await press(row("Smoking"));
      await press(row("Distance"));
      expect(router.push.mock.calls).toEqual([
        ["/profile/deal-breakers/smoking"],
        ["/profile/deal-breakers/distance"],
      ]);
    });
  });

  it.each([
    [
      "fi-FI",
      [
        ["Tupakointi", "Ei koskaan"],
        ["Lapset", "Kaikki"],
        ["Lapset tulevaisuudessa", "Kerro ensin omasi"],
        ["Kielet", "Suomi, Ruotsi, Englanti ja 1 muu"],
        ["Pituus", "Tauolla, kunnes vastaat siihen itse."],
        ["Etäisyys", "Melko lähellä"],
      ],
    ],
    [
      "sv-FI",
      [
        ["Rökning", "Aldrig"],
        ["Barn", "Alla"],
        ["Barn i framtiden", "Dela ditt eget först"],
        ["Språk", "Finska, Svenska, Engelska och 1 till"],
        ["Längd", "Pausad tills du själv svarar på det."],
        ["Avstånd", "Ganska nära"],
      ],
    ],
  ])("speaks %s", async (tag, rows) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      await show(
        held(
          filter("smoking", ["never"]),
          filter("languages", ["fi", "sv", "en", "de"]),
          filter("height", ["taller"], true),
          filter("distance", ["nearby", "close"]),
        ),
        { hasKids: "no", smoking: "never", languages: ["fi"] } as ProfileFields,
      );
      for (const [title, value] of rows) expectValue(title as string, value as string);
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});

describe("ownAnswerPath", () => {
  it("opens a field of the later screens for one answer, and the rest in the section that holds it", () => {
    expect(ownAnswerPath("smoking")).toEqual({
      pathname: "/profile/later/[field]",
      params: { field: "smoking", once: "1" },
    });
    expect(ownAnswerPath("height")).toEqual({
      pathname: "/profile/later/[field]",
      params: { field: "height", once: "1" },
    });
    expect(ownAnswerPath("monogamy")).toEqual({
      pathname: "/profile/section/[id]",
      params: { id: "relationship", once: "1" },
    });
  });
});

describe("isOpenToFilter", () => {
  it("asks for the own answer of a field, and none of the distance", () => {
    expect(isOpenToFilter("smoking", {})).toBe(false);
    expect(isOpenToFilter("smoking", { smoking: "never" })).toBe(true);
    expect(isOpenToFilter("distance", {})).toBe(true);
  });
});
