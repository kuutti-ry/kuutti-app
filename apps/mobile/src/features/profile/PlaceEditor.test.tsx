import type { HomeSummary } from "@kuutti/schema";
import { postalMatches } from "@kuutti/schema/postal-areas";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { AccessibilityInfo, Keyboard, PixelRatio, Platform, StyleSheet } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { hasCutText } from "@/test/layout";
import { renderWithTheme, underProviders } from "@/test/render";
import { MAX_FONT_SCALE, TOUCH_TARGET } from "@/theme/a11y";
import { PLACE_ROWS, PlaceChoice, PlacePicker, placeOffer } from "./PlaceEditor";

// The home's two pieces (ADR-061), shared by onboarding and the home screen:
// the postal code with the list of areas, read from the real list on the
// phone, and what the card will say. The screens' own tests hold the saving.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await settle();
  });
const typeDigits = (text: string, label = "Postal code") =>
  act(async () => {
    fireEvent.changeText(screen.getByLabelText(label), text);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const noProblems = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};
/** The list's buttons by their heard names, in order. */
const rowNames = () =>
  screen.queryAllByRole("button").map((row) => row.props.accessibilityLabel as string);
const speaking = (tag: string) => (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
/** What this test says aloud: the mock outlives a test, with what earlier ones said. */
const spoken = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();
/** What this test says aloud behind what is being said: iOS's way for words no line carries (#581). */
const queued = () =>
  jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockClear();

const town = { fi: "Helsinki", sv: "Helsingfors" };
const area = { fi: "Kallio", sv: "Berghäll" };
const home = (over: Partial<HomeSummary> = {}): HomeSummary => ({
  town,
  area,
  showArea: false,
  ...over,
});

afterEach(() => {
  jest.restoreAllMocks();
  speaking("en-US");
});

describe("placeOffer", () => {
  it("offers nothing before the first digit", () => {
    expect(placeOffer("")).toEqual({ rows: [], state: "empty" });
  });

  it("lists every area the digits start, as a code keeps its zeros", () => {
    const { rows, state } = placeOffer("0053");
    expect(state).toBe("all");
    expect(rows).toEqual([{ code: "00530", fi: "Kallio", sv: "Berghäll" }]);
  });

  it("lists a whole code that is on the list", () => {
    expect(placeOffer("99990")).toEqual({
      rows: [{ code: "99990", fi: "Nuorgam", sv: "Nuorgam" }],
      state: "all",
    });
  });

  it("stops at the rows there is room for, and says there are more", () => {
    const { rows, state } = placeOffer("0");
    expect(rows).toHaveLength(PLACE_ROWS);
    expect(state).toBe("more");
    expect(rows).toEqual(postalMatches("0", PLACE_ROWS));
  });

  it("takes exactly the rows there is room for as all there are", () => {
    // Nine matches would be "more"; the boundary is the list's own, so find a prefix of eight.
    const prefix = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
      .flatMap((a) => [...Array(100).keys()].map((n) => `${a}${String(n).padStart(2, "0")}`))
      .find((digits) => postalMatches(digits, PLACE_ROWS + 1).length === PLACE_ROWS);
    expect(prefix).toBeDefined();
    const { rows, state } = placeOffer(prefix as string);
    expect(rows).toHaveLength(PLACE_ROWS);
    expect(state).toBe("all");
  });

  it("says a whole code the list lacks, with the areas that share the most of it", () => {
    // Korvatunturi's code is real and nobody's home; the list has the area next to it.
    expect(placeOffer("99999")).toEqual({
      rows: [{ code: "99990", fi: "Nuorgam", sv: "Nuorgam" }],
      state: "unknown",
    });
  });

  it("goes back as many digits as it takes", () => {
    const { rows, state } = placeOffer("00111");
    expect(state).toBe("unknown");
    expect(rows).toEqual(postalMatches("001", PLACE_ROWS));
  });

  it("says digits at once when nothing on the list starts with them", () => {
    expect(postalMatches("0011", 1)).toEqual([]);
    expect(placeOffer("0011").state).toBe("unknown");
    expect(placeOffer("0011").rows).toEqual(postalMatches("001", PLACE_ROWS));
  });

  it("ends with nothing where no digit is shared", () => {
    expect(placeOffer("x")).toEqual({ rows: [], state: "unknown" });
  });

  it("never lists a code the API refused, whole or among others", () => {
    const whole = placeOffer("99990", "99990");
    expect(whole.state).toBe("unknown");
    expect(whole.rows.map((row) => row.code)).not.toContain("99990");
    expect(whole.rows).not.toEqual([]);
    const among = placeOffer("999", "99990");
    expect(among.rows.map((row) => row.code)).not.toContain("99990");
    expect(among.state).toBe("all");
  });

  it("goes back past a prefix that held the refused code alone", () => {
    const alone = postalMatches("9999", 2);
    expect(alone).toHaveLength(1);
    const { rows, state } = placeOffer("9999", "99990");
    expect(state).toBe("unknown");
    expect(rows).toEqual(
      postalMatches("999", PLACE_ROWS + 1)
        .slice(0, PLACE_ROWS)
        .filter((r) => r.code !== "99990"),
    );
  });
});

describe("PlacePicker", () => {
  it("is a named number field, focused by nobody, with nothing listed until a digit comes", async () => {
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    expect(screen.getByText("Postal code")).toBeTruthy();
    const field = screen.getByLabelText("Postal code");
    expect(field.props).toMatchObject({
      inputMode: "numeric",
      keyboardType: "number-pad",
      textContentType: "postalCode",
      // Android's autofill service is often another company's: it is handed no home (ADR-061 §9).
      autoComplete: "off",
      autoCorrect: false,
      maxLength: 5,
      value: "",
    });
    // A tap meant for what lies below would land on the number pad (e2e README).
    expect(field.props.autoFocus).toBeUndefined();
    expect(screen.queryAllByRole("button")).toEqual([]);
    noProblems();
  });

  it.each([
    ["letters and spaces", "0a0 53-0", "00530"],
    ["a sixth digit", "005301", "00530"],
    ["nothing but letters", "abc", ""],
    ["an empty field", "", ""],
    ["the zeros a number would lose", "00", "00"],
  ])("keeps digits only, five at most: %s", async (_what, typed, kept) => {
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits(typed);
    expect(screen.getByLabelText("Postal code").props.value).toBe(kept);
  });

  it("closes the keyboard at the fifth digit: the list may lie behind it, and nothing is left to type", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => undefined);
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("0053");
    expect(dismiss).not.toHaveBeenCalled();
    await typeDigits("00530");
    expect(dismiss).toHaveBeenCalledTimes(1);
    // A sixth digit is cut, and counts as the fifth.
    await typeDigits("005301");
    expect(screen.getByLabelText("Postal code").props.value).toBe("00530");
  });

  it("offers the nearest areas instead of the row the API refused, and leaves saying so to the screen", async () => {
    const onPick = jest.fn();
    const ui = (refused: boolean) => <PlacePicker busy={false} refused={refused} onPick={onPick} />;
    await show(ui(false));
    await typeDigits("99990");
    await press(screen.getByRole("button", { name: "9 9 9 9 0, Nuorgam" }));
    expect(onPick).toHaveBeenCalledWith("99990");

    await screen.rerender(underProviders(ui(true)));

    expect(screen.queryByRole("button", { name: "9 9 9 9 0, Nuorgam" })).toBeNull();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("We can't find that code. Choose the nearest area from the list."),
    ).toBeNull();
  });

  it("narrows the list as the digits come, the code a digit at a time to a screen reader", async () => {
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("0");
    expect(screen.getAllByRole("button")).toHaveLength(PLACE_ROWS);
    await typeDigits("00530");
    expect(rowNames()).toEqual(["0 0 5 3 0, Kallio"]);
    // Both are drawn: the digits, then the name beside them.
    expect(screen.getByText("00530")).toBeTruthy();
    expect(screen.getByText("Kallio")).toBeTruthy();
    await typeDigits("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("counts the areas in the plural where there are several", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const announce = spoken();
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("9999");
    await typeDigits("999");
    expect(announce.mock.calls).toEqual([
      ["1 area matches."],
      [`${postalMatches("999", 9).length} areas match.`],
    ]);
  });

  it("says a code the list lacks and offers the nearest, each a button that answers", async () => {
    const onPick = jest.fn();
    await show(<PlacePicker busy={false} onPick={onPick} />);
    await typeDigits("99999");
    expect(
      screen.getByText("We can't find that code. Choose the nearest area from the list."),
    ).toBeTruthy();
    await press(screen.getByRole("button", { name: "9 9 9 9 0, Nuorgam" }));
    expect(onPick).toHaveBeenCalledWith("99990");
  });

  it("sends nothing while digits are typed: only a tap on a row answers, with its whole code", async () => {
    const onPick = jest.fn();
    await show(<PlacePicker busy={false} onPick={onPick} />);
    await typeDigits("00530");
    expect(onPick).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "0 0 5 3 0, Kallio" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("00530");
  });

  it("takes no tap on a row while a save is on its way, and says so in its state", async () => {
    const onPick = jest.fn();
    await show(<PlacePicker busy onPick={onPick} />);
    await typeDigits("00530");
    const row = screen.getByRole("button", { name: "0 0 5 3 0, Kallio" });
    expect(row.props.accessibilityState?.disabled).toBe(true);
    await press(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("gives every row of a full list a label, a role and a 44 pt target with no fixed height", async () => {
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("0");
    noProblems();
    for (const row of screen.getAllByRole("button")) {
      const style = StyleSheet.flatten(row.props.style) as { height?: number; minHeight?: number };
      expect(style.minHeight).toBe(TOUCH_TARGET);
      expect(style.height).toBeUndefined();
    }
  });

  it("holds at the largest text with the longest names of the list", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("00560");
    expect(screen.getByText("Toukola - Kumpula - Vanhakaupunki")).toBeTruthy();
    expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
    noProblems();
  });

  it.each([
    ["en-US", "Postal code", "Berghäll", "Kallio"],
    ["fi-FI", "Postinumero", "Berghäll", "Kallio"],
    ["sv-FI", "Postnummer", "Kallio", "Berghäll"],
  ])("lists areas for a %s reader by the list's name", async (tag, label, not, name) => {
    speaking(tag);
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("00530", label);
    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.queryByText(not)).toBeNull();
    expect(rowNames()).toEqual([`0 0 5 3 0, ${name}`]);
  });

  describe("how many there are, heard and not drawn: the rows show it (#581)", () => {
    it.each([
      [
        "fi-FI",
        "1 alue sopii.",
        "Postinumero",
        "Ensimmäiset 8 aluetta. Lisää numeroita tarkentaa listaa.",
      ],
      [
        "sv-FI",
        "1 område passar.",
        "Postnummer",
        "De första 8 områdena. Fler siffror begränsar listan.",
      ],
      ["en-US", "1 area matches.", "Postal code", "The first 8 areas. More digits narrow them."],
    ])("says it in the %s of the catalogue", async (tag, one, label, more) => {
      speaking(tag);
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      await typeDigits("0", label);
      await typeDigits("00530", label);
      expect(announce.mock.calls).toEqual([[more], [one]]);
      expect(screen.queryByText(one)).toBeNull();
      expect(screen.queryByText(more)).toBeNull();
    });

    it("tells iOS each time it changes, queued behind the keys being said", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const said = queued();
      const announce = spoken();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      expect(said).not.toHaveBeenCalled();
      await typeDigits("00530");
      expect(said.mock.calls).toEqual([["1 area matches.", { queue: true }]]);
      await typeDigits("0");
      expect(said.mock.calls.at(-1)).toEqual([
        `The first ${PLACE_ROWS} areas. More digits narrow them.`,
        { queue: true },
      ]);
      expect(announce).not.toHaveBeenCalled();
    });

    it("tells Android too, with no line for a live region to read", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      const said = queued();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      expect(announce).not.toHaveBeenCalled();
      await typeDigits("00530");
      expect(announce.mock.calls).toEqual([["1 area matches."]]);
      expect(said).not.toHaveBeenCalled();
    });

    it("says it once while the words stay, and nothing for an empty field", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      await typeDigits("9999");
      await typeDigits("99990");
      expect(announce.mock.calls).toEqual([["1 area matches."]]);
      await typeDigits("");
      expect(announce).toHaveBeenCalledTimes(1);
    });
  });

  describe("a code the list lacks, which no row can say", () => {
    const UNKNOWN = "We can't find that code. Choose the nearest area from the list.";

    it("is drawn in a line above the rows, on iOS said once as it appears", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const announce = spoken();
      const said = queued();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      await typeDigits("99999");
      expect(announce.mock.calls).toEqual([[UNKNOWN]]);
      expect(said).not.toHaveBeenCalled();
      expect(screen.getByText(UNKNOWN)).toBeTruthy();
    });

    it("is left to Android's live region", async () => {
      jest.replaceProperty(Platform, "OS", "android");
      const announce = spoken();
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      await typeDigits("99999");
      expect(screen.getByText(UNKNOWN).props.accessibilityLiveRegion).toBe("polite");
      expect(announce).not.toHaveBeenCalled();
    });

    it.each([
      ["fi-FI", "Postinumero", "Emme löydä tätä postinumeroa. Valitse lähin alue listalta."],
      ["sv-FI", "Postnummer", "Vi hittar inte det postnumret. Välj närmaste område i listan."],
    ])("says it in the %s of the catalogue", async (tag, label, words) => {
      speaking(tag);
      await show(<PlacePicker busy={false} onPick={jest.fn()} />);
      await typeDigits("99999", label);
      expect(screen.getByText(words)).toBeTruthy();
    });
  });
});

describe("PlaceChoice", () => {
  const QUESTION = "What should your card show?";
  /** A place by its name, chosen or not: the chosen one's name carries its mark. */
  const option = (name: string) =>
    screen.getByRole("radio", { name: new RegExp(`^(✓ )?${name}$`) });
  const checked = (name: string) => option(name).props.accessibilityState?.checked;

  it("asks its question over the town and the area, whole-width radios in a group, the one shown filled and said", async () => {
    await show(<PlaceChoice home={home()} busy={false} onChoose={jest.fn()} />);
    expect(screen.getByRole("heading", { name: QUESTION })).toBeTruthy();
    const group = screen.getByLabelText(QUESTION);
    expect(group.props.accessibilityRole).toBe("radiogroup");
    expect(group.props.className).not.toMatch(/\bflex-row\b/);
    expect(screen.getAllByRole("radio").map((row) => row.props.accessibilityLabel)).toEqual([
      "✓ Helsinki",
      "Kallio",
    ]);
    expect(checked("Helsinki")).toBe(true);
    expect(checked("Kallio")).toBe(false);
    expect(screen.getByText("✓ Helsinki")).toBeTruthy();
    // The filled one says it: no line repeats it, and no word of the town why.
    expect(screen.queryByText(/On your card/)).toBeNull();
    expect(screen.queryByText("Your card shows the nearest town.")).toBeNull();
    noProblems();
  });

  it("fills the area once it is the one shown", async () => {
    await show(<PlaceChoice home={home({ showArea: true })} busy={false} onChoose={jest.fn()} />);
    expect(checked("Helsinki")).toBe(false);
    expect(checked("Kallio")).toBe(true);
    expect(screen.queryByText(/On your card/)).toBeNull();
  });

  it.each([
    ["the area", "Kallio", false, true],
    ["the town", "Helsinki", true, false],
  ])("asks for %s on its row", async (_what, name, showArea, asked) => {
    const onChoose = jest.fn();
    await show(<PlaceChoice home={home({ showArea })} busy={false} onChoose={onChoose} />);
    await press(option(name));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(asked);
  });

  it("asks nothing for what is shown already, or while a save is on its way", async () => {
    const onChoose = jest.fn();
    await show(<PlaceChoice home={home()} busy={false} onChoose={onChoose} />);
    await press(option("Helsinki"));
    expect(onChoose).not.toHaveBeenCalled();
    await show(<PlaceChoice home={home()} busy onChoose={onChoose} />);
    await press(option("Kallio"));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("has what the card shows in the question's place and role where no area is kept, with nothing to press (#581)", async () => {
    const joensuu = { fi: "Joensuu", sv: "Joensuu" };
    await show(
      <PlaceChoice home={home({ town: joensuu, area: null })} busy={false} onChoose={jest.fn()} />,
    );
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("heading", { name: "On your card: Joensuu" })).toBeTruthy();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.queryByLabelText(QUESTION)).toBeNull();
    expect(screen.queryByText("Your card shows the nearest town.")).toBeNull();
  });

  // The list's own cases: two rows of one name would choose nothing.
  it.each([
    ["Sipoo", { fi: "Sipoo", sv: "Sibbo" }],
    ["Maarianhamina", { fi: "Maarianhamina", sv: "Mariehamn" }],
  ])("offers no choice where the area is called %s like its town", async (name, place) => {
    await show(
      <PlaceChoice home={home({ town: place, area: place })} busy={false} onChoose={jest.fn()} />,
    );
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByRole("heading", { name: `On your card: ${name}` })).toBeTruthy();
  });

  it("asks the question of the reader's own language, where the two names differ in one", async () => {
    const places = home({
      town: { fi: "Savonlinna", sv: "Nyslott" },
      area: { fi: "Savonlinna", sv: "Savonlinna" },
    });
    await show(<PlaceChoice home={places} busy={false} onChoose={jest.fn()} />);
    expect(screen.queryAllByRole("radio")).toEqual([]);
    speaking("sv-FI");
    await show(<PlaceChoice home={places} busy={false} onChoose={jest.fn()} />);
    expect(option("Nyslott")).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: "Savonlinna" })).toHaveLength(1);
  });

  describe("its heading's level, which the screen that holds it says", () => {
    const joensuu = { fi: "Joensuu", sv: "Joensuu" };
    const alone = home({ town: joensuu, area: null });

    it.each([
      ["a level under the screen's title by default, as Home has it", undefined, "3"],
      ["the step's own where onboarding says so", "h1", "1"],
    ] as const)("over a choice, %s", async (_what, heading, level) => {
      await show(<PlaceChoice home={home()} busy={false} onChoose={jest.fn()} heading={heading} />);
      expect(screen.getByRole("heading", { name: QUESTION }).props["aria-level"]).toBe(level);
    });

    it.each([
      ["a level under the screen's title by default, as Home has it", undefined, "3"],
      ["the step's own where onboarding says so", "h1", "1"],
    ] as const)("in its place, %s", async (_what, heading, level) => {
      await show(<PlaceChoice home={alone} busy={false} onChoose={jest.fn()} heading={heading} />);
      expect(
        screen.getByRole("heading", { name: "On your card: Joensuu" }).props["aria-level"],
      ).toBe(level);
    });
  });

  it.each([
    ["en-US", "Helsinki", "Kallio", QUESTION, "On your card: Joensuu"],
    ["fi-FI", "Helsinki", "Kallio", "Mitä korttisi näyttää?", "Kortillasi: Joensuu"],
    ["sv-FI", "Helsingfors", "Berghäll", "Vad ska ditt kort visa?", "På ditt kort: Joensuu"],
  ])("speaks %s", async (tag, townName, areaName, question, line) => {
    speaking(tag);
    await show(<PlaceChoice home={home()} busy={false} onChoose={jest.fn()} />);
    expect(option(townName)).toBeTruthy();
    expect(option(areaName)).toBeTruthy();
    expect(screen.getByLabelText(question).props.accessibilityRole).toBe("radiogroup");
    const joensuu = { fi: "Joensuu", sv: "Joensuu" };
    await show(
      <PlaceChoice home={home({ town: joensuu, area: null })} busy={false} onChoose={jest.fn()} />,
    );
    expect(screen.getByRole("heading", { name: line })).toBeTruthy();
  });

  it("holds at the largest text with a long name, wrapping and not cutting it", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    const long = home({ area: { fi: "Toukola - Kumpula - Vanhakaupunki", sv: "x" } });
    await show(<PlaceChoice home={long} busy={false} onChoose={jest.fn()} />);
    expect(option("Toukola - Kumpula - Vanhakaupunki")).toBeTruthy();
    expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
    noProblems();
  });
});
