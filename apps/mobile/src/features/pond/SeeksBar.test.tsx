import { StyleSheet } from "react-native";
import { renderWithTheme } from "@/test/render";
import { SeeksBar } from "./SeeksBar";

// The bar of whom the people of an area seek (#507): each band named with its
// figure, told apart by its pattern, one element for a screen reader.

const SEEKS = { men: 30, everyone: 20, women: 50 };
const hidden = { includeHiddenElements: true };

describe("SeeksBar", () => {
  it("names each band with its figure, men first and women last", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    expect(screen.getByText("Whom people with a finished profile are looking for")).toBeTruthy();
    const labels = screen.getAllByText(/^\d+ % /).map((node) => node.props.children);
    expect(labels).toEqual(["30 % men", "20 % everyone", "50 % women"]);
  });

  it("is one element for a screen reader, the three figures in sentences", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    const bar = screen.getByRole("image");
    expect(bar.props.accessible).toBe(true);
    expect(bar.props.accessibilityLabel).toBe(
      "Of the people with a finished profile, 30 percent are looking for men. 20 percent are looking for everyone. 50 percent are looking for women.",
    );
    expect(screen.getByLabelText(bar.props.accessibilityLabel)).toBe(bar);
  });

  it("tells the bands apart by pattern: rising, falling, and both where they overlap", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    // Twice each: the bar and the mark beside the label.
    expect(screen.getAllByTestId("strokes-rising", hidden)).toHaveLength(4);
    expect(screen.getAllByTestId("strokes-falling", hidden)).toHaveLength(4);
  });

  it("hides its drawing from a screen reader", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    expect(screen.queryAllByTestId("strokes-rising")).toHaveLength(0);
  });

  it("gives each band its share of the width, and a band too small to see a width of its own", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={{ men: 1, everyone: 1, women: 98 }} />);
    const bar = screen.getByRole("image").children[1];
    if (typeof bar !== "object") throw new Error("the bar is drawn");
    const bands = bar.children.flatMap((band) =>
      typeof band === "object" ? [StyleSheet.flatten(band.props.style)] : [],
    );
    expect(bands.map((style) => style.flexGrow)).toEqual([1, 1, 98]);
    for (const style of bands) {
      expect(style.flexBasis).toBe(0);
      expect(style.minWidth).toBeGreaterThanOrEqual(14);
    }
  });
});
