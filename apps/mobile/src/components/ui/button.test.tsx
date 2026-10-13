import { fireEvent, screen } from "@testing-library/react-native";
import X from "lucide-react-native/icons/x";
import { StyleSheet } from "react-native";
import { renderWithTheme } from "@/test/render";
import { Button } from "./button";
import { Icon } from "./icon";
import { Text } from "./text";

// The button (#12, TD-9): a 44 pt target whatever its size, a role a screen
// reader announces, plain text that labels itself, and a disabled state that
// is said and not only drawn.

describe("Button", () => {
  it("wraps plain text so it labels itself, and presses", async () => {
    const pressed = jest.fn();
    await renderWithTheme(<Button onPress={pressed}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({ minHeight: 44, minWidth: 44 });
    expect(button.props.accessibilityState).toEqual({ disabled: false });
    expect(screen.getByText("Save").props.className).toMatch(/text-primary-foreground/);
    await fireEvent.press(button);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("says it is disabled, looks it, and ignores presses", async () => {
    const pressed = jest.fn();
    await renderWithTheme(
      <Button disabled onPress={pressed}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.props.accessibilityState).toEqual({ disabled: true });
    expect(button.props.className).toMatch(/\bopacity-50\b/);
    await fireEvent.press(button);
    expect(pressed).not.toHaveBeenCalled();
  });

  it("takes a caller's role and state, keeping its own disabled flag", async () => {
    await renderWithTheme(
      <Button accessibilityRole="radio" accessibilityState={{ selected: true }}>
        Dark
      </Button>,
    );
    expect(screen.getByRole("radio", { name: "Dark" }).props.accessibilityState).toEqual({
      selected: true,
      disabled: false,
    });
  });

  it("labels an icon-only button with the label it was given, and keeps the child as it is", async () => {
    await renderWithTheme(
      <Button variant="outline" size="icon" accessibilityLabel="Close">
        <Icon as={X} />
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("draws a chosen choice (default) and an unchosen one (outline) the same size: both have a 1 px border (#239)", async () => {
    await renderWithTheme(
      <>
        <Button accessibilityState={{ selected: true }}>Gemini</Button>
        <Button variant="outline" accessibilityState={{ selected: false }}>
          Cancer
        </Button>
      </>,
    );
    const chosen = screen.getByRole("button", { name: "Gemini" }).props.className;
    const unchosen = screen.getByRole("button", { name: "Cancer" }).props.className;
    expect(chosen).toMatch(/(^| )border( |$)/);
    expect(chosen).toMatch(/\bborder-transparent\b/);
    expect(unchosen).toMatch(/(^| )border( |$)/);
  });

  it.each([
    ["destructive", /text-destructive-foreground/],
    ["outline", /text-foreground/],
    ["secondary", /text-secondary-foreground/],
    ["ghost", /text-foreground/],
  ] as const)("hands the %s variant's text colour to its text", async (variant, pattern) => {
    await renderWithTheme(
      <Button variant={variant} accessibilityLabel="Label">
        <Text>Label</Text>
      </Button>,
    );
    expect(screen.getByText("Label").props.className).toMatch(pattern);
  });
});
