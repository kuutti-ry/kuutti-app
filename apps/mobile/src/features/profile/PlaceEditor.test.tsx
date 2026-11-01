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
    expect(
      screen.getByText(`The first ${PLACE_ROWS} areas. More digits narrow them.`),
    ).toBeTruthy();
    await typeDigits("00530");
    expect(rowNames()).toEqual(["0 0 5 3 0, Kallio"]);
    expect(screen.getByText("1 area matches.")).toBeTruthy();
    // Both are drawn: the digits, then the name beside them.
    expect(screen.getByText("00530")).toBeTruthy();
    expect(screen.getByText("Kallio")).toBeTruthy();
    await typeDigits("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("counts the areas in the plural where there are several", async () => {
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("9999");
    await typeDigits("999");
    expect(screen.getByText(`${postalMatches("999", 9).length} areas match.`)).toBeTruthy();
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

  it.each([
    ["fi-FI", "1 alue sopii.", "Postinumero"],
    ["sv-FI", "1 område passar.", "Postnummer"],
  ])("says the line and the field's name in the %s of the catalogue", async (tag, line, label) => {
    speaking(tag);
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("00530", label);
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("speaks the line on iOS, which has no live regions, each time it changes", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const announce = spoken();
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    expect(announce).not.toHaveBeenCalled();
    await typeDigits("00530");
    expect(announce).toHaveBeenLastCalledWith("1 area matches.");
    await typeDigits("99999");
    expect(announce).toHaveBeenLastCalledWith(
      "We can't find that code. Choose the nearest area from the list.",
    );
    await typeDigits("");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("leaves the line to Android's live region", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const announce = spoken();
    await show(<PlacePicker busy={false} onPick={jest.fn()} />);
    await typeDigits("00530");
    expect(screen.getByText("1 area matches.").props.accessibilityLiveRegion).toBe("polite");
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("PlaceChoice", () => {
  const buttons = () => screen.queryAllByRole("button");
  const selected = (name: string) =>
    screen.getByRole("button", { name }).props.accessibilityState?.selected;

  it("offers the town and the area by name, with the one shown selected and said", async () => {
    await show(<PlaceChoice home={home()} busy={false} onChoose={jest.fn()} />);
    expect(selected("Helsinki")).toBe(true);
    expect(selected("Kallio")).toBe(false);
    expect(screen.getByText("On your card: Helsinki")).toBeTruthy();
    expect(screen.queryByText("Your card shows the nearest town.")).toBeNull();
    noProblems();
  });

  it("says the area once it is the one shown", async () => {
    await show(<PlaceChoice home={home({ showArea: true })} busy={false} onChoose={jest.fn()} />);
    expect(selected("Helsinki")).toBe(false);
    expect(selected("Kallio")).toBe(true);
    expect(screen.getByText("On your card: Kallio")).toBeTruthy();
  });

  it.each([
    ["the area", "Kallio", false, true],
    ["the town", "Helsinki", true, false],
  ])("asks for %s on its button", async (_what, name, showArea, asked) => {
    const onChoose = jest.fn();
    await show(<PlaceChoice home={home({ showArea })} busy={false} onChoose={onChoose} />);
    await press(screen.getByRole("button", { name }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(asked);
  });

  it("asks nothing for what is shown already, or while a save is on its way", async () => {
    const onChoose = jest.fn();
    await show(<PlaceChoice home={home()} busy={false} onChoose={onChoose} />);
    await press(screen.getByRole("button", { name: "Helsinki" }));
    expect(onChoose).not.toHaveBeenCalled();
    await show(<PlaceChoice home={home()} busy onChoose={onChoose} />);
    await press(
      screen.getAllByRole("button", { name: "Kallio" }).at(-1) as ReturnType<
        typeof screen.getByRole
      >,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("offers no choice where no area is kept, and still says what the card shows", async () => {
    const joensuu = { fi: "Joensuu", sv: "Joensuu" };
    await show(
      <PlaceChoice home={home({ town: joensuu, area: null })} busy={false} onChoose={jest.fn()} />,
    );
    expect(buttons()).toEqual([]);
    expect(screen.getByText("Your card shows the nearest town.")).toBeTruthy();
    expect(screen.getByText("On your card: Joensuu")).toBeTruthy();
  });

  // The list's own cases: two buttons of one name would choose nothing.
  it.each([
    ["Sipoo", { fi: "Sipoo", sv: "Sibbo" }],
    ["Maarianhamina", { fi: "Maarianhamina", sv: "Mariehamn" }],
  ])("offers no choice where the area is called %s like its town", async (name, place) => {
    await show(
      <PlaceChoice home={home({ town: place, area: place })} busy={false} onChoose={jest.fn()} />,
    );
    expect(buttons()).toEqual([]);
    expect(screen.getByText(`On your card: ${name}`)).toBeTruthy();
  });

  it("asks the question of the reader's own language, where the two names differ in one", async () => {
    const places = home({
      town: { fi: "Savonlinna", sv: "Nyslott" },
      area: { fi: "Savonlinna", sv: "Savonlinna" },
    });
    await show(<PlaceChoice home={places} busy={false} onChoose={jest.fn()} />);
    expect(buttons()).toEqual([]);
    speaking("sv-FI");
    await show(<PlaceChoice home={places} busy={false} onChoose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Nyslott" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Savonlinna" })).toHaveLength(1);
  });

  it.each([
    ["en-US", "Helsinki", "Kallio", "On your card: Helsinki"],
    ["fi-FI", "Helsinki", "Kallio", "Kortillasi: Helsinki"],
    ["sv-FI", "Helsingfors", "Berghäll", "På ditt kort: Helsingfors"],
  ])("speaks %s", async (tag, townName, areaName, line) => {
    speaking(tag);
    await show(<PlaceChoice home={home()} busy={false} onChoose={jest.fn()} />);
    expect(screen.getByRole("button", { name: townName })).toBeTruthy();
    expect(screen.getByRole("button", { name: areaName })).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("holds at the largest text with a long name, wrapping and not cutting it", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    const long = home({ area: { fi: "Toukola - Kumpula - Vanhakaupunki", sv: "x" } });
    await show(<PlaceChoice home={long} busy={false} onChoose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Toukola - Kumpula - Vanhakaupunki" })).toBeTruthy();
    expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
    noProblems();
  });
});
