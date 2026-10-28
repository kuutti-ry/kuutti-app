import { fireEvent, screen } from "@testing-library/react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Label } from "./label";

// The label (#12): a press on it is a convenience for sighted users, so it is
// not an accessibility element of its own; it scales with the OS font size.

/** The press wrapper around the label's text. */
const rootOf = (text: string) => {
  const wrapper = screen.getByText(text).parent;
  if (!wrapper) throw new Error("the label has no wrapper");
  return wrapper;
};

describe("Label", () => {
  it("passes a press on to its handler and stays out of the accessibility tree", async () => {
    const pressed = jest.fn();
    await renderWithTheme(<Label onPress={pressed}>Name</Label>);
    expect(screen.getByText("Name").props.maxFontSizeMultiplier).toBe(2);
    await fireEvent.press(screen.getByText("Name"));
    expect(pressed).toHaveBeenCalledTimes(1);
    // The wrapper is accessible={false}: nothing here for the a11y check to flag.
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
    expect(rootOf("Name").props.className).not.toMatch(/opacity-50/);
    expect(screen.getByText("Name").props.className).toMatch(/(^| )text-foreground( |$)/);
  });

  it("is dimmed and ignores presses when disabled", async () => {
    const pressed = jest.fn();
    await renderWithTheme(
      <Label disabled onPress={pressed}>
        Name
      </Label>,
    );
    await fireEvent.press(screen.getByText("Name"));
    expect(pressed).not.toHaveBeenCalled();
    // In the muted token, never faded below the set's contrast (#467).
    expect(rootOf("Name").props.className).not.toMatch(/opacity-/);
    expect(screen.getByText("Name").props.className).toMatch(/\btext-muted-foreground\b/);
    expect(screen.getByText("Name").props.className).not.toMatch(/\btext-foreground\b/);
  });

  it("shrinks beside a control, its text wrapping, instead of pushing the control off the screen", async () => {
    const words = "A label long enough to need the room";
    await renderWithTheme(<Label>{words}</Label>);
    expect(rootOf(words).props.className).toMatch(/\bshrink\b/);
    expect(screen.getByText(words).props.className).toMatch(/\bshrink\b/);
  });
});
