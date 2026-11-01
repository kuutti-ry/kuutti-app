import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { renderWithTheme } from "@/test/render";
import { SeeksChips } from "./SeeksChips";

// What the screens that hold the chips do not show: SeekWhomScreen.test.tsx has
// what a press adds and takes away, by what it saves, from an answer it was
// given; this has the chips with no answer yet, and their words.

const chip = (name: string) => screen.getByRole("button", { name });
const selected = (name: string) => chip(name).props.accessibilityState?.selected;

describe("SeeksChips", () => {
  it("chooses nothing from no answer, Anyone included: the seeks step starts there", async () => {
    await renderWithTheme(<SeeksChips chosen={[]} onChange={() => {}} />);
    for (const name of ["Women", "Men", "Non-binary people", "Anyone"]) {
      expect(selected(name)).toBe(false);
    }
  });

  it("starts an answer from no answer with the chip pressed", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<SeeksChips chosen={[]} onChange={onChange} />);
    await fireEvent.press(chip("Non-binary people"));
    expect(onChange.mock.calls).toEqual([[["non_binary"]]]);
  });

  it("answers all three in the chips' order on Anyone, and stays so when all three are chosen", async () => {
    const onChange = jest.fn();
    await renderWithTheme(
      <SeeksChips chosen={["non_binary", "woman", "man"]} onChange={onChange} />,
    );
    await fireEvent.press(chip("Anyone"));
    expect(onChange.mock.calls).toEqual([[["woman", "man", "non_binary"]]]);
  });

  it.each([
    ["fi-FI", ["Naisia", "Miehiä", "Muunsukupuolisia", "Kenet tahansa"]],
    ["sv-FI", ["Kvinnor", "Män", "Icke-binära personer", "Vem som helst"]],
  ])("speaks %s", async (tag, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      await renderWithTheme(<SeeksChips chosen={[]} onChange={() => {}} />);
      for (const word of words) expect(chip(word)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
