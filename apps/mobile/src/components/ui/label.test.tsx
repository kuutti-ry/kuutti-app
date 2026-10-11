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
    expect(rootOf("Name").props.className).toMatch(/\bopacity-50\b/);
  });
});
