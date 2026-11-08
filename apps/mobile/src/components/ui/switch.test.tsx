import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme, underProviders } from "@/test/render";
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
    // Enabled, it keeps its own look (#467): a solid track, the input thumb.
    expect(toggle.props.className).not.toMatch(/\bborder-dashed\b/);
    expect(toggle.props.className).toMatch(/\bbg-background\b/);
    expect(JSON.stringify(screen.toJSON())).toMatch(/size-6 rounded-full bg-input/);
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
    expect(toggle.props.className).not.toMatch(/\bborder-dashed\b/);
    expect(toggle.props.className).toMatch(/\bbg-primary\b/);
    expect(JSON.stringify(screen.toJSON())).toMatch(/size-6 rounded-full bg-primary-foreground/);
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
    // Drawn, not faded (#467): no fill, a dashed track, the thumb muted and
    // still at the on side.
    expect(toggle.props.className).not.toMatch(/opacity-/);
    expect(toggle.props.className).toMatch(/\bborder-dashed\b/);
    expect(toggle.props.className).not.toMatch(/\bborder-solid\b/);
    expect(toggle.props.className).toMatch(/\bbg-transparent\b/);
    expect(toggle.props.className).not.toMatch(/\bbg-primary\b/);
    expect(toggle.props.className).toMatch(/\bjustify-end\b/);
    expect(JSON.stringify(screen.toJSON())).toMatch(/size-6 rounded-full bg-muted-foreground/);
    await fireEvent.press(toggle);
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps an off thumb at the off side when disabled, muted the same", async () => {
    await renderWithTheme(
      <Switch accessibilityLabel="Research" checked={false} disabled onCheckedChange={jest.fn()} />,
    );
    const toggle = screen.getByRole("switch", { name: "Research" });
    expect(toggle.props.className).toMatch(/\bjustify-start\b/);
    expect(toggle.props.className).not.toMatch(/\bbg-background\b/);
    expect(JSON.stringify(screen.toJSON())).toMatch(/size-6 rounded-full bg-muted-foreground/);
  });

  // Android keeps a border's dash when its style goes away (#548).
  it("says solid when it is enabled again, so Android drops the dash", async () => {
    const { rerender } = await renderWithTheme(
      <Switch accessibilityLabel="Research" checked={false} disabled onCheckedChange={jest.fn()} />,
    );
    await rerender(
      underProviders(
        <Switch accessibilityLabel="Research" checked={false} onCheckedChange={jest.fn()} />,
      ),
    );
    const toggle = screen.getByRole("switch", { name: "Research" });
    expect(toggle.props.className).toMatch(/\bborder-solid\b/);
    expect(toggle.props.className).not.toMatch(/\bborder-dashed\b/);
  });
});
