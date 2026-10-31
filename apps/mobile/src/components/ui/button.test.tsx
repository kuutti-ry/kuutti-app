import { fireEvent, screen } from "@testing-library/react-native";
import X from "lucide-react-native/icons/x";
import { useContext } from "react";
import { Text as RNText, StyleSheet } from "react-native";
import { renderWithTheme, underProviders } from "@/test/render";
import { Button } from "./button";
import { Icon } from "./icon";
import { Text, TextClassContext } from "./text";

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
    await fireEvent.press(button);
    expect(pressed).not.toHaveBeenCalled();
  });

  // Drawn, not faded (#467): opacity took the label to about 3:1 in the
  // high-contrast sets. Every variant, disabled, is the same shape.
  it.each(["default", "destructive", "outline", "secondary", "ghost"] as const)(
    "draws the %s variant disabled as a dashed outline with a muted label, never faded",
    async (variant) => {
      await renderWithTheme(
        <Button variant={variant} disabled>
          Save
        </Button>,
      );
      const classes = screen.getByRole("button", { name: "Save" }).props.className as string;
      expect(classes).not.toMatch(/opacity-/);
      expect(classes).toMatch(/(^| )border( |$)/);
      expect(classes).toMatch(/\bborder-dashed\b/);
      expect(classes).not.toMatch(/\bborder-solid\b/);
      expect(classes).toMatch(/\bborder-input\b/);
      expect(classes).toMatch(/(^| )bg-transparent( |$)/);
      expect(classes).not.toMatch(/(^| )bg-(primary|destructive|secondary|background)( |$)/);
      // No pressed fill either, which the web also draws under a hover.
      expect(classes).toMatch(/\bactive:bg-transparent\b/);
      expect(classes).not.toMatch(/\bactive:bg-(primary|destructive|secondary|accent)\b/);
      const label = screen.getByText("Save").props.className as string;
      expect(label).toMatch(/\btext-muted-foreground\b/);
      expect(label).not.toMatch(/\btext-(primary|destructive|secondary)-foreground\b/);
    },
  );

  // Android keeps a border's dash when its style goes away, so a button enabled
  // again has to say solid, on the same element (#548).
  it.each(["default", "destructive", "outline", "secondary", "ghost"] as const)(
    "says solid when the %s variant is enabled again, so Android drops the dash",
    async (variant) => {
      const { rerender } = await renderWithTheme(
        <Button variant={variant} disabled>
          Save
        </Button>,
      );
      await rerender(underProviders(<Button variant={variant}>Save</Button>));
      const classes = screen.getByRole("button", { name: "Save" }).props.className as string;
      expect(classes).toMatch(/\bborder-solid\b/);
      expect(classes).not.toMatch(/\bborder-dashed\b/);
    },
  );

  it("hands an icon of a disabled button the muted colour too, through the text class", async () => {
    // Icon takes its colour from TextClassContext, which jest cannot see on the
    // svg once NativeWind has turned it into style: read the context itself.
    function Probe() {
      return <RNText testID="probe">{useContext(TextClassContext)}</RNText>;
    }
    await renderWithTheme(
      <Button variant="outline" size="icon" accessibilityLabel="Fewer" disabled>
        <Icon as={X} />
        <Probe />
      </Button>,
    );
    expect(screen.getByTestId("probe").props.children).toMatch(/\btext-muted-foreground\b/);
    expect(screen.getByRole("button", { name: "Fewer" }).props.className).toMatch(
      /\bborder-dashed\b/,
    );
  });

  it("draws an enabled button solid and in its own colours", async () => {
    await renderWithTheme(<Button variant="outline">Cancel</Button>);
    const classes = screen.getByRole("button", { name: "Cancel" }).props.className as string;
    expect(classes).not.toMatch(/\bborder-dashed\b/);
    expect(classes).toMatch(/\bbg-background\b/);
    expect(screen.getByText("Cancel").props.className).toMatch(/(^| )text-foreground( |$)/);
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

  it.each(["destructive", "secondary", "ghost"] as const)(
    "gives the %s variant the same transparent 1 px border, so disabling it never resizes it (#239, #467)",
    async (variant) => {
      await renderWithTheme(<Button variant={variant}>Block</Button>);
      const classes = screen.getByRole("button", { name: "Block" }).props.className as string;
      expect(classes).toMatch(/(^| )border( |$)/);
      expect(classes).toMatch(/\bborder-transparent\b/);
    },
  );

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
