import { act, screen } from "@testing-library/react-native";
import { createRef } from "react";
import { DeviceEventEmitter, Platform, type ScrollView, StyleSheet, Text } from "react-native";
import { renderWithTheme } from "@/test/render";
import { KeyboardScrollView } from "./KeyboardScrollView";

// A field stays in sight above the keyboard (#103): iOS by the scroll view's
// insets, Android by the padding, never both, or the keyboard's height is
// taken twice. SettingsPage, onboarding and the home screen stand on this.

/** The scroll view, and the view around it that gives way to the keyboard. */
const page = () => {
  const scroll = screen.container.queryAll((node) => node.type === "RCTScrollView")[0];
  let around = scroll?.parent ?? null;
  while (around && typeof around.type !== "string") around = around.parent;
  if (!scroll || !around) throw new Error("no scroll view on the page");
  return { scroll, around, padding: StyleSheet.flatten(around.props.style).paddingBottom };
};

/** The page from y 100 to 800, and the keyboard's top at 500. */
const keyboardUp = async () => {
  await act(async () => {
    const { around } = page();
    around.props.onLayout({
      persist: () => undefined,
      nativeEvent: { layout: { x: 0, y: 100, width: 400, height: 700 } },
    });
  });
  await act(async () => {
    for (const event of ["keyboardWillShow", "keyboardDidShow"]) {
      DeviceEventEmitter.emit(event, {
        endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
      });
    }
  });
};

afterEach(() => jest.restoreAllMocks());

describe("KeyboardScrollView", () => {
  it.each([
    ["android", 300],
    ["ios", 0],
  ] as const)("on %s pads for the keyboard only where the window does not", async (os, padding) => {
    jest.replaceProperty(Platform, "OS", os);
    await renderWithTheme(
      <KeyboardScrollView>
        <Text>Field</Text>
      </KeyboardScrollView>,
    );
    expect(page().padding).toBe(0);
    await keyboardUp();
    expect(page().padding).toBe(padding);
    expect(page().scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it("lets a tap on a button under the field count with the keyboard up", async () => {
    await renderWithTheme(<KeyboardScrollView />);
    expect(page().scroll.props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("hands the page's own props and ref to the scroll view", async () => {
    const ref = createRef<ScrollView>();
    await renderWithTheme(
      <KeyboardScrollView ref={ref} keyboardShouldPersistTaps="always">
        <Text>Field</Text>
      </KeyboardScrollView>,
    );
    expect(page().scroll.props.keyboardShouldPersistTaps).toBe("always");
    expect(ref.current).not.toBeNull();
    expect(screen.getByText("Field")).toBeTruthy();
  });
});
