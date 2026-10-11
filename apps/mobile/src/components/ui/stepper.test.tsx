import { fireEvent, screen } from "@testing-library/react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Stepper } from "./stepper";

// A number between a minus and a plus (ADR-010 §9, #146, #148): both answers
// are labelled buttons, the number is announced as it changes, and a step past
// either end is not offered.

function show(props: Partial<React.ComponentProps<typeof Stepper>> = {}) {
  const onChange = jest.fn();
  return renderWithTheme(
    <Stepper
      label="Height"
      value={170}
      shown="170 cm"
      downLabel="One centimetre less"
      upLabel="One centimetre more"
      canDown
      canUp
      onChange={onChange}
      {...props}
    />,
  ).then(() => onChange);
}

describe("Stepper", () => {
  it("names the number and steps it down and up by one", async () => {
    const onChange = await show();
    expect(screen.getByText("Height")).toBeTruthy();
    expect(screen.getByText("170 cm").props.accessibilityLiveRegion).toBe("polite");
    await fireEvent.press(screen.getByRole("button", { name: "One centimetre less" }));
    await fireEvent.press(screen.getByRole("button", { name: "One centimetre more" }));
    expect(onChange.mock.calls).toEqual([[169], [171]]);
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it("does not step below the lower end", async () => {
    const onChange = await show({ canDown: false });
    const down = screen.getByRole("button", { name: "One centimetre less" });
    expect(down.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(down);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "One centimetre more" }).props.accessibilityState
        ?.disabled,
    ).toBe(false);
  });

  it("does not step above the upper end", async () => {
    const onChange = await show({ canUp: false });
    const up = screen.getByRole("button", { name: "One centimetre more" });
    expect(up.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(up);
    expect(onChange).not.toHaveBeenCalled();
  });

  // The class of the stepper's own root, found by the classes it always has.
  const rootClass = () =>
    JSON.stringify(screen.toJSON()).match(/"className":"([^"]*\bitems-center gap-1\b[^"]*)"/)?.[1];

  it("takes no flex of its own, so a column cannot shrink it under what follows (#238)", async () => {
    await show();
    expect(rootClass()).toBeDefined();
    expect(rootClass()).not.toMatch(/\bflex-1\b/);
  });

  it("takes the flex a row gives it", async () => {
    await show({ className: "flex-1" });
    expect(rootClass()).toMatch(/\bflex-1\b/);
  });
});
