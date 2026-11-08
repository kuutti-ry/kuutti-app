import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { ProgressMark, progressWords } from "./ProgressMark";

// The mark at the end of a profile row (#239): a check once done, else a count,
// where one question is one item (#581); decorative, the row's value says it in
// words.

const hidden = { includeHiddenElements: true };

describe("ProgressMark", () => {
  it.each([
    [2, 5, "2/5"],
    [0, 4, "0/4"],
    [1, 3, "1/3"],
  ])(
    "writes the count for a part not yet done, hidden from screen readers: %i of %i",
    async (answered, total, words) => {
      await renderWithTheme(<ProgressMark progress={{ answered, total }} />);
      expect(screen.getByText(words, hidden)).toBeTruthy();
      expect(screen.queryByText(words)).toBeNull();
      expect(screen.queryByTestId("progress-done", hidden)).toBeNull();
    },
  );

  it("shows a check mark once done, and no count", async () => {
    await renderWithTheme(<ProgressMark progress={{ answered: 3, total: 3 }} />);
    expect(screen.queryByText("3/3", hidden)).toBeNull();
    expect(screen.getByTestId("progress-done", hidden)).toBeTruthy();
  });
});

describe("progressWords", () => {
  const t = ((key: string, args?: Record<string, number>) =>
    args ? `${key}:${args.answered}/${args.total}` : key) as never;

  it("says done once everything counted is answered, and how many of how many before", () => {
    expect(progressWords(t, { answered: 2, total: 2 })).toBe("profile.progress.done");
    expect(progressWords(t, { answered: 1, total: 2 })).toBe("profile.progress.answered:1/2");
  });
});
