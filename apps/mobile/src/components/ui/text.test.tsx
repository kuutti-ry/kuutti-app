import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { HEADING_FONT_SCALE, MAX_FONT_SCALE } from "@/theme/a11y";
import { Text, TextClassContext } from "./text";

// Text (#12, TD-9): headings are announced as headings with their level, the
// size follows the OS up to MAX_FONT_SCALE, and a parent's text class applies.

describe("Text", () => {
  it.each([
    ["h1", "1"],
    ["h2", "2"],
    ["h3", "3"],
    ["h4", "4"],
  ] as const)("announces %s as a heading of level %s", async (variant, level) => {
    await renderWithTheme(<Text variant={variant}>Title</Text>);
    const heading = screen.getByRole("heading", { name: "Title" });
    expect(heading.props["aria-level"]).toBe(level);
  });

  it.each(["default", "lead", "large", "small", "muted", "code"] as const)(
    "is plain text, not a heading, as %s",
    async (variant) => {
      await renderWithTheme(<Text variant={variant}>Body</Text>);
      expect(screen.queryByRole("heading")).toBeNull();
      expect(screen.getByText("Body").props.maxFontSizeMultiplier).toBe(2);
    },
  );

  // Headings grow less with the OS, the larger they are (#467).
  const HEADINGS = ["h1", "h2", "h3", "h4", "default"] as const;
  const growth = (variant: (typeof HEADINGS)[number]): number =>
    (HEADING_FONT_SCALE as Partial<Record<string, number>>)[variant] ?? MAX_FONT_SCALE;
  // Tailwind's font sizes in rem; NativeWind's rem on native is 14.
  const REM: Record<string, number> = {
    base: 1,
    lg: 1.125,
    xl: 1.25,
    "2xl": 1.5,
    "3xl": 1.875,
    "4xl": 2.25,
  };
  const points = (className: string): number => {
    const size = /(?:^| )text-(base|lg|xl|2xl|3xl|4xl)(?: |$)/.exec(className)?.[1];
    if (size === undefined) throw new Error(`no font size in "${className}"`);
    return (REM[size] as number) * 14;
  };

  it.each(HEADINGS.slice(0, 4))("lets %s grow as far as its own scale", async (variant) => {
    await renderWithTheme(<Text variant={variant}>Title</Text>);
    expect(screen.getByRole("heading", { name: "Title" }).props.maxFontSizeMultiplier).toBe(
      growth(variant),
    );
  });

  it("keeps the headings in order at the largest size, each above body text", async () => {
    // From the sizes the variants draw, so a new text class is held too.
    await renderWithTheme(
      <>
        {HEADINGS.map((variant) => (
          <Text key={variant} variant={variant}>
            {variant}
          </Text>
        ))}
      </>,
    );
    const largest = HEADINGS.map((variant) => {
      const text = screen.getByText(variant);
      return points(text.props.className) * text.props.maxFontSizeMultiplier;
    });
    for (let level = 1; level < largest.length; level++) {
      expect(largest[level - 1]).toBeGreaterThan(largest[level] as number);
    }
    // And none grows more than text does.
    for (const variant of HEADINGS) expect(growth(variant)).toBeLessThanOrEqual(MAX_FONT_SCALE);
  });

  it("takes a caller's own maxFontSizeMultiplier over its variant's", async () => {
    await renderWithTheme(
      <Text variant="h1" maxFontSizeMultiplier={1}>
        Fixed
      </Text>,
    );
    expect(screen.getByText("Fixed").props.maxFontSizeMultiplier).toBe(1);
  });

  it("is plain text when the variant is explicitly none", async () => {
    await renderWithTheme(<Text variant={null}>Bare</Text>);
    const text = screen.getByText("Bare");
    expect(text.props.role).toBeUndefined();
    expect(text.props["aria-level"]).toBeUndefined();
  });

  it("puts its role and classes on the child instead of a text of its own with asChild", async () => {
    await renderWithTheme(
      <Text asChild variant="h2">
        <Text>Child</Text>
      </Text>,
    );
    const heading = screen.getByRole("heading", { name: "Child" });
    expect(heading.props["aria-level"]).toBe("2");
    expect(heading.props.className).toMatch(/text-3xl/);
    // One host text, not a text inside a text.
    expect(screen.getAllByText("Child")).toHaveLength(1);
  });

  it("takes the text class its parent hands down, the caller's class last", async () => {
    await renderWithTheme(
      <TextClassContext.Provider value="text-primary-foreground">
        <Text className="underline">Inside a button</Text>
      </TextClassContext.Provider>,
    );
    expect(screen.getByText("Inside a button").props.className).toMatch(
      /text-primary-foreground underline$/,
    );
  });
});
