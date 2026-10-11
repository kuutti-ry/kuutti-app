import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { Switch, TRACK_HEIGHT, TRACK_WIDTH } from "./switch";

// The switch (#12): a labelled switch whose state is said, drawn smaller than
// 44 pt with the target extended, on and off told apart by the thumb's place.

describe("Switch", () => {
  it("is a labelled switch that says whether it is on, and turns on when pressed", async () => {
    const change = jest.fn();
    await renderWithTheme(
      <Switch accessibilityLabel="High contrast" checked={false} onCheckedChange={change} />,
    );
    const toggle = screen.getByRole("switch", { name: "High contrast" });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    expect(toggle.props.className).toMatch(/justify-start/);
    // 52 x 32 drawn; the target reaches 44 pt both ways.
    expect(TRACK_HEIGHT + toggle.props.hitSlop.top + toggle.props.hitSlop.bottom).toBe(44);
    expect(TRACK_WIDTH).toBeGreaterThanOrEqual(44);
    await fireEvent.press(toggle);
    expect(change).toHaveBeenCalledWith(true);
  });

  it("puts the thumb at the end when on, and turns off when pressed", async () => {
    const change = jest.fn();
    await renderWithTheme(
      <Switch accessibilityLabel="High contrast" checked onCheckedChange={change} />,
    );
    const toggle = screen.getByRole("switch", { name: "High contrast" });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: true });
    expect(toggle.props.className).toMatch(/justify-end/);
    await fireEvent.press(toggle);
    expect(change).toHaveBeenCalledWith(false);
  });

  it("says it is disabled, looks it, and does not change", async () => {
    const change = jest.fn();
    await renderWithTheme(
      <Switch accessibilityLabel="High contrast" checked disabled onCheckedChange={change} />,
    );
    const toggle = screen.getByRole("switch", { name: "High contrast" });
    expect(toggle.props.accessibilityState).toMatchObject({ disabled: true });
    expect(toggle.props.className).toMatch(/\bopacity-50\b/);
    await fireEvent.press(toggle);
    expect(change).not.toHaveBeenCalled();
  });
});
