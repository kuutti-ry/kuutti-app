import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithTheme } from "@/test/render";
import { Input } from "./input";

// The text field (#12): its label is required (a placeholder is not one), it
// grows with the OS font size, and a read-only field looks it.

describe("Input", () => {
  it("is found by its label, scales with the OS font up to twice, and reports what is typed", async () => {
    const typed = jest.fn();
    await renderWithTheme(<Input accessibilityLabel="Your name" onChangeText={typed} />);
    const input = screen.getByLabelText("Your name");
    expect(input.props.maxFontSizeMultiplier).toBe(2);
    expect(input.props.className).toMatch(/\bmin-h-touch\b/);
    expect(input.props.className).not.toMatch(/opacity-50/);
    expect(input.props.className).not.toMatch(/\bborder-dashed\b/);
    await fireEvent.changeText(input, "Aino");
    expect(typed).toHaveBeenCalledWith("Aino");
  });

  it("looks read-only when it cannot be edited", async () => {
    await renderWithTheme(<Input accessibilityLabel="Locked" editable={false} />);
    const input = screen.getByLabelText("Locked");
    expect(input.props.editable).toBe(false);
    // Drawn, not faded (#467): a dashed outline and the text muted.
    expect(input.props.className).not.toMatch(/opacity-/);
    expect(input.props.className).toMatch(/\bborder-dashed\b/);
    // Not the placeholder's own placeholder:text-muted-foreground.
    expect(input.props.className).toMatch(/(^| )text-muted-foreground( |$)/);
    expect(input.props.className).not.toMatch(/\btext-foreground\b/);
  });
});
