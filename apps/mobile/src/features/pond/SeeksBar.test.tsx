import type { RenderResult } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { renderWithTheme } from "@/test/render";
import { SeeksBar } from "./SeeksBar";

// The bar of whom people on Kuutti seek (#507, #581): one continuous bar in three
// colours, under it each band's figure in words beside a swatch of its colour,
// and one element for a screen reader.

const SEEKS = { men: 30, everyone: 20, women: 50 };

type HostElement = ReturnType<RenderResult["getByRole"]>;

const childrenOf = (node: HostElement) =>
  node.children.flatMap((child) => (typeof child === "object" ? [child] : []));

/** The image element's two parts: the bar, and the labels under it. */
async function parts(seeks = SEEKS) {
  const screen = await renderWithTheme(<SeeksBar seeks={seeks} />);
  const [bar, labels] = childrenOf(screen.getByRole("image"));
  if (!bar || !labels) throw new Error("the bar and its labels are drawn");
  return { screen, bar, labels };
}

const colourOf = (node: HostElement | undefined) =>
  /\bbg-seeks-\w+/.exec(node?.props.className ?? "")?.[0];

const BANDS = ["bg-seeks-men", "bg-seeks-everyone", "bg-seeks-women"];

describe("SeeksBar", () => {
  it("names each band with its figure, men first and women last, and says nothing else", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    const lines = screen
      .getAllByText(/./, { includeHiddenElements: true })
      .map((node) => node.props.children);
    expect(lines).toEqual(["30 % men", "20 % everyone", "50 % women"]);
  });

  it("is one element for a screen reader, the three figures in sentences", async () => {
    const screen = await renderWithTheme(<SeeksBar seeks={SEEKS} />);
    const bar = screen.getByRole("image");
    expect(bar.props.accessible).toBe(true);
    expect(bar.props.accessibilityLabel).toBe(
      "Of the people with a finished profile who are looking for men or women, 30 percent are looking for men. 20 percent are looking for everyone. 50 percent are looking for women.",
    );
    expect(screen.getByLabelText(bar.props.accessibilityLabel)).toBe(bar);
  });

  it("is one continuous bar: no gap between the bands and no edge of their own, its corners rounded as one shape", async () => {
    const { bar } = await parts();
    const classes = bar.props.className as string;
    expect(classes).toMatch(/(^| )flex-row( |$)/);
    expect(classes).toMatch(/(^| )overflow-hidden( |$)/);
    expect(classes).toMatch(/(^| )rounded-md( |$)/);
    expect(classes).not.toMatch(/\bgap\b|\bgap-|\bborder\b|\bborder-/);
    for (const band of childrenOf(bar)) {
      expect(band.props.className).not.toMatch(
        /\brounded\b|\brounded-|\bborder\b|\bborder-|\bm[xl]-/,
      );
    }
  });

  it("colours the bands men, everyone, women, and each label's swatch as its band", async () => {
    const { bar, labels } = await parts();
    expect(childrenOf(bar).map(colourOf)).toEqual(BANDS);
    const rows = childrenOf(labels).map((row) => {
      const [swatch, label] = childrenOf(row);
      return [colourOf(swatch), label?.props.children];
    });
    expect(rows).toEqual([
      ["bg-seeks-men", "30 % men"],
      ["bg-seeks-everyone", "20 % everyone"],
      ["bg-seeks-women", "50 % women"],
    ]);
  });

  it("gives each band its share of the width", async () => {
    const { bar } = await parts({ men: 5, everyone: 5, women: 90 });
    const bands = childrenOf(bar).map((band) => StyleSheet.flatten(band.props.style));
    expect(bands.map((style) => style.flexGrow)).toEqual([5, 5, 90]);
    for (const style of bands) expect(style.flexBasis).toBe(0);
  });

  it("draws the figures smaller, in lines that wrap at the largest text, with no fixed height", async () => {
    const { labels, screen } = await parts();
    expect(labels.props.className).toMatch(/(^| )flex-wrap( |$)/);
    expect(labels.props.className).not.toMatch(/(^| )h-/);
    expect(screen.getByText("30 % men").props.className).toMatch(/(^| )text-small( |$)/);
  });
});
