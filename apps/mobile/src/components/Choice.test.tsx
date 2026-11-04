import { fireEvent, screen } from "@testing-library/react-native";
import type * as React from "react";
import { PixelRatio } from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { hasCutText } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { MAX_FONT_SCALE } from "@/theme/a11y";
import { Choice } from "./Choice";

// One option of a group (#511), and on a screen that asks one thing a whole-width
// row (#581): a radio where one answer stands, a checkbox where several can, the
// chosen one marked in words too, the flag decoration only.

const show = (props: Partial<React.ComponentProps<typeof Choice>> = {}) => {
  const onPress = jest.fn();
  return renderWithTheme(<Choice label="Women" chosen={false} onPress={onPress} {...props} />).then(
    () => onPress,
  );
};

describe("Choice", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is a radio where one answer stands: a screen reader says the others go", async () => {
    await show();
    expect(screen.getByRole("radio", { name: "Women" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is a checkbox where several can stand together, so no other answer seems to go", async () => {
    await show({ several: true });
    expect(screen.getByRole("checkbox", { name: "Women" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["a radio", false, "radio"],
    ["a checkbox", true, "checkbox"],
  ])("says as %s whether it is chosen, in its state and in words", async (_what, several, role) => {
    await show({ several, chosen: true });
    const chosen = screen.getByRole(role, { name: "✓ Women" });
    expect(chosen.props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByText("✓ Women")).toBeTruthy();
    await show({ several, chosen: false });
    const other = screen.getByRole(role, { name: "Women" });
    expect(other.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByText("Women")).toBeTruthy();
  });

  it("is filled when chosen and outlined when not: more than the mark tells them apart", async () => {
    await show({ chosen: true });
    expect(screen.getByRole("radio").props.className).toMatch(/\bbg-primary\b/);
    await show({ chosen: false });
    expect(screen.getByRole("radio").props.className).toMatch(/\bborder-input\b/);
    expect(screen.getByRole("radio").props.className).not.toMatch(/\bbg-primary\b/);
  });

  it("answers a press", async () => {
    const onPress = await show();
    await fireEvent.press(screen.getByRole("radio", { name: "Women" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("takes no press while it is held, and says so", async () => {
    const onPress = await show({ disabled: true, chosen: true, several: true });
    const held = screen.getByRole("checkbox", { name: "✓ Women" });
    expect(held.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
    await fireEvent.press(held);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("draws a flag before the text and leaves it out of the name", async () => {
    await show({ label: "Svenska", flag: "🇸🇪", chosen: true });
    expect(screen.getByText("🇸🇪 ✓ Svenska")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "✓ Svenska" })).toBeTruthy();
  });

  it("says its spoken words in place of marks, and draws the marks", async () => {
    await show({ label: "✕ and ○", spoken: "Cross and circle", chosen: true });
    expect(screen.getByText("✓ ✕ and ○")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "✓ Cross and circle" })).toBeTruthy();
  });

  it("has the 44 pt target, and wraps a long line at the largest text, never cutting it", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(MAX_FONT_SCALE);
    await show({
      label: "I was too lazy to write anything here, so this placeholder says I am a nice fellow.",
    });
    const tree = screen.toJSON() as HostNode;
    expect(pressables(tree).flatMap((node) => a11yProblems(node))).toEqual([]);
    expect(hasCutText(tree)).toBe(false);
  });
});
