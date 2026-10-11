import { screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
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
