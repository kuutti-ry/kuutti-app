import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { ProgressMark, progressWords } from "./ProgressMark";

// The mark at the end of a profile row (#239): a check once done, else a ring
// or a count; decorative, the row's value says it in words.

const hidden = { includeHiddenElements: true };

describe("ProgressMark", () => {
  it("draws a ring for a part not yet done, hidden from screen readers", async () => {
    await renderWithTheme(<ProgressMark progress={{ answered: 1, total: 3 }} style="ring" />);
    const ring = screen.getByTestId("progress-ring", hidden);
    expect(ring).toBeTruthy();
    expect(screen.queryByTestId("progress-ring")).toBeNull();
    expect(screen.queryByText("1/3", hidden)).toBeNull();
  });

  it.each([
    [1, 3],
    [2, 3],
    [1, 4],
  ])("fills the ring in proportion: %i of %i", async (answered, total) => {
    await renderWithTheme(<ProgressMark progress={{ answered, total }} style="ring" />);
    const circumference = 2 * Math.PI * 8.75;
    // The arc is the one circle with a dash: its length drawn, then a gap of the whole circle.
    const dashes: unknown[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const { props, children } = node as { props?: Record<string, unknown>; children?: unknown[] };
      if (props?.strokeDasharray !== undefined) dashes.push(props.strokeDasharray);
      for (const child of children ?? []) walk(child);
    };
    walk(screen.toJSON());
    expect(dashes).toHaveLength(1);
    const [drawn, gap] = (dashes[0] as Array<string | number>).map(Number);
    expect(drawn).toBeCloseTo((circumference * answered) / total);
    expect(gap).toBeCloseTo(circumference);
  });

  it("draws an empty ring, no arc, for a part with nothing answered", async () => {
    await renderWithTheme(<ProgressMark progress={{ answered: 0, total: 4 }} style="ring" />);
    const ring = screen.getByTestId("progress-ring", hidden);
    // The faint whole circle only.
    expect(JSON.stringify(screen.toJSON())).not.toContain("strokeDasharray");
    expect(ring).toBeTruthy();
  });

  it("writes the count for a part not yet done, hidden from screen readers", async () => {
    await renderWithTheme(<ProgressMark progress={{ answered: 2, total: 5 }} style="count" />);
    expect(screen.getByText("2/5", hidden)).toBeTruthy();
    expect(screen.queryByText("2/5")).toBeNull();
    expect(screen.queryByTestId("progress-ring", hidden)).toBeNull();
  });

  it.each(["ring", "count"] as const)(
    "shows a check mark, in either style (%s), once done",
    async (style) => {
      await renderWithTheme(<ProgressMark progress={{ answered: 3, total: 3 }} style={style} />);
      expect(screen.queryByTestId("progress-ring", hidden)).toBeNull();
      expect(screen.queryByText("3/3", hidden)).toBeNull();
      expect(screen.getByTestId("progress-done", hidden)).toBeTruthy();
    },
  );
});

describe("progressWords", () => {
  const t = ((key: string, args?: Record<string, number>) =>
    args ? `${key}:${args.answered}/${args.total}` : key) as never;

  it("says done once everything counted is answered, and how many of how many before", () => {
    expect(progressWords(t, { answered: 2, total: 2 })).toBe("profile.progress.done");
    expect(progressWords(t, { answered: 1, total: 2 })).toBe("profile.progress.answered:1/2");
  });
});
