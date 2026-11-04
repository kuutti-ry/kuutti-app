import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SeeksChips } from "./SeeksChips";

// What the screens that hold the rows do not show: SeekWhomScreen.test.tsx has
// what a press adds and takes away, by what it saves, from an answer it was
// given; this has the rows with no answer yet, their role and their words.

const row = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^(✓ )?${name}$`) });
const checked = (name: string) => row(name).props.accessibilityState?.checked;

describe("SeeksChips", () => {
  it("chooses nothing from no answer, Anyone included: the seeks step starts there", async () => {
    await renderWithTheme(<SeeksChips chosen={[]} onChange={() => {}} />);
    for (const name of ["Women", "Men", "Non-binary people", "Anyone"]) {
      expect(checked(name)).toBe(false);
    }
  });

  it("draws each as a whole-width row, a checkbox: several can stand together (#581)", async () => {
    await renderWithTheme(<SeeksChips chosen={["man"]} onChange={() => {}} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(checked("Men")).toBe(true);
    expect(screen.getByText("✓ Men")).toBeTruthy();
    expect(screen.queryByText("Men")).toBeNull();
    // A column, not a row that wraps: as chips they filled a third of the screen.
    expect(row("Men").parent?.props.className).not.toMatch(/\bflex-row\b/);
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("starts an answer from no answer with the row pressed", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<SeeksChips chosen={[]} onChange={onChange} />);
    await fireEvent.press(row("Non-binary people"));
    expect(onChange.mock.calls).toEqual([[["non_binary"]]]);
  });

  it("answers all three in the rows' order on Anyone, and stays so when all three are chosen", async () => {
    const onChange = jest.fn();
    await renderWithTheme(
      <SeeksChips chosen={["non_binary", "woman", "man"]} onChange={onChange} />,
    );
    expect(checked("Anyone")).toBe(true);
    await fireEvent.press(row("Anyone"));
    expect(onChange.mock.calls).toEqual([[["woman", "man", "non_binary"]]]);
  });

  it.each([
    ["fi-FI", ["Naisia", "Miehiä", "Muunsukupuolisia", "Kenet tahansa"]],
    ["sv-FI", ["Kvinnor", "Män", "Icke-binära personer", "Vem som helst"]],
  ])("speaks %s", async (tag, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      await renderWithTheme(<SeeksChips chosen={[]} onChange={() => {}} />);
      for (const word of words) expect(row(word)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
