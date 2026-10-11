import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import * as ReactNative from "react-native";
import { AccessibilityInfo, Animated, Platform, Pressable, Text } from "react-native";
import { ThemeProvider, useTheme } from "./ThemeProvider";

// The theme (#12, #143): light and dark through NativeWind, high contrast as a
// second token set that follows the OS until the person chooses, both choices
// kept across restarts, and a change that fades in unless motion is reduced.

// NativeWind's colour-scheme setter needs its compiled stylesheet, which the
// test runner has none of: the provider's call is seen, not applied
// (as in SettingsScreen.test.tsx).
let mockColorScheme: "light" | "dark" = "light";
const mockSetColorScheme = jest.fn();
jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: mockColorScheme, setColorScheme: mockSetColorScheme }),
}));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

/** The OS's accessibility settings, as the provider and useReducedMotion read and follow them. */
function osSettings({
  darker = false,
  highText = false,
  reduceMotion = false,
}: {
  darker?: boolean;
  highText?: boolean;
  reduceMotion?: boolean;
} = {}) {
  const listeners = new Map<string, (enabled: boolean) => void>();
  const darkerRead = jest
    .spyOn(AccessibilityInfo, "isDarkerSystemColorsEnabled")
    .mockResolvedValue(darker);
  const highTextRead = jest
    .spyOn(AccessibilityInfo, "isHighTextContrastEnabled")
    .mockResolvedValue(highText);
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduceMotion);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation((event: string, handler) => {
    listeners.set(event, handler as unknown as (enabled: boolean) => void);
    return { remove: () => listeners.delete(event) } as never;
  });
  // React Native's jest setup mocks these already, so spyOn hands back the same mock: start it afresh.
  darkerRead.mockClear();
  highTextRead.mockClear();
  return {
    darkerRead,
    highTextRead,
    events: () => [...listeners.keys()],
    change: (event: string, enabled: boolean) => listeners.get(event)?.(enabled),
  };
}

function Probe() {
  const theme = useTheme();
  return (
    <>
      <Text testID="scheme">{theme.scheme}</Text>
      <Text testID="preference">{theme.preference}</Text>
      <Text testID="contrast">{String(theme.highContrast)}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="dark"
        onPress={() => theme.setPreference("dark")}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="system"
        onPress={() => theme.setPreference("system")}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="contrast on"
        onPress={() => theme.setHighContrast(true)}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="contrast off"
        onPress={() => theme.setHighContrast(false)}
      />
    </>
  );
}

const show = async () => {
  const view = await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  await act(async () => undefined);
  return view;
};
const textOf = (id: string) => screen.getByTestId(id).props.children as string;
type HostNode = { props: Record<string, unknown>; children: Array<HostNode | string> | null };
/** The class list of the root view the token sets hang on. */
const rootClass = (): string => {
  const visit = (node: HostNode | string | null): string | null => {
    if (node === null || typeof node === "string") return null;
    const className = node.props.className;
    if (typeof className === "string" && className.includes("theme-root")) return className;
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const tree = screen.toJSON() as HostNode | HostNode[] | null;
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    const found = visit(root);
    if (found) return found;
  }
  throw new Error("no theme-root in the tree");
};

beforeEach(() => {
  store.clear();
  mockColorScheme = "light";
  mockSetColorScheme.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("follows the OS: no high contrast unless asked, the scheme NativeWind reports", async () => {
    osSettings();
    mockColorScheme = "dark";
    await show();
    expect(textOf("scheme")).toBe("dark");
    expect(textOf("preference")).toBe("system");
    expect(textOf("contrast")).toBe("false");
    expect(rootClass()).not.toMatch(/high-contrast/);
  });

  it("takes iOS's Increase Contrast, and follows it when it changes while the app runs", async () => {
    const os = osSettings({ darker: true });
    await show();
    expect(os.darkerRead).toHaveBeenCalled();
    expect(os.highTextRead).not.toHaveBeenCalled();
    expect(textOf("contrast")).toBe("true");
    expect(rootClass()).toMatch(/\bhigh-contrast\b/);
    await act(async () => os.change("darkerSystemColorsChanged", false));
    expect(textOf("contrast")).toBe("false");
  });

  it("takes Android's high-contrast text instead", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const os = osSettings({ highText: true });
    await show();
    expect(os.highTextRead).toHaveBeenCalled();
    expect(os.darkerRead).not.toHaveBeenCalled();
    expect(os.events()).toContain("highTextContrastChanged");
    expect(textOf("contrast")).toBe("true");
  });

  it("uses the dark high-contrast set when both are on", async () => {
    osSettings({ darker: true });
    mockColorScheme = "dark";
    await show();
    expect(rootClass()).toMatch(/\bhigh-contrast-dark\b/);
  });

  it("applies the scheme and the contrast chosen last time, over the OS", async () => {
    osSettings({ darker: true });
    store.set("kuutti.preference.scheme", "dark");
    store.set("kuutti.preference.highContrast", "false");
    await show();
    await waitFor(() => expect(textOf("preference")).toBe("dark"));
    expect(mockSetColorScheme).toHaveBeenCalledWith("dark");
    expect(textOf("contrast")).toBe("false");
  });

  it("takes a stored high contrast even when the OS asks for none", async () => {
    osSettings();
    store.set("kuutti.preference.highContrast", "true");
    await show();
    await waitFor(() => expect(textOf("contrast")).toBe("true"));
  });

  it("ignores a stored scheme it does not know", async () => {
    osSettings();
    store.set("kuutti.preference.scheme", "sepia");
    await show();
    expect(textOf("preference")).toBe("system");
    expect(mockSetColorScheme).not.toHaveBeenCalled();
  });

  it("stores an explicit scheme, and forgets it for the OS's", async () => {
    osSettings();
    await show();
    await fireEvent.press(screen.getByLabelText("dark"));
    expect(textOf("preference")).toBe("dark");
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("dark");
    await waitFor(() => expect(store.get("kuutti.preference.scheme")).toBe("dark"));
    await fireEvent.press(screen.getByLabelText("system"));
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("system");
    await waitFor(() => expect(store.has("kuutti.preference.scheme")).toBe(false));
  });

  it("stores the contrast choice either way, and the class follows", async () => {
    osSettings();
    await show();
    await fireEvent.press(screen.getByLabelText("contrast on"));
    expect(rootClass()).toMatch(/\bhigh-contrast\b/);
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
    await fireEvent.press(screen.getByLabelText("contrast off"));
    expect(rootClass()).not.toMatch(/high-contrast/);
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("false"));
  });

  it("fades a change of appearance in, briefly", async () => {
    osSettings();
    const timing = jest.spyOn(Animated, "timing");
    await show();
    expect(timing).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("contrast on"));
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0]?.[1]).toMatchObject({ toValue: 1, duration: 150 });
  });

  it("changes the appearance at once under reduce motion", async () => {
    osSettings({ reduceMotion: true });
    const timing = jest.spyOn(Animated, "timing");
    await show();
    await fireEvent.press(screen.getByLabelText("contrast on"));
    expect(textOf("contrast")).toBe("true");
    expect(timing).not.toHaveBeenCalled();
  });

  it("refuses to be read outside its provider", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(render(<Probe />)).rejects.toThrow("useTheme needs a ThemeProvider above it");
  });
});

describe("ThemeProvider on the web preview", () => {
  const classList = { add: jest.fn(), remove: jest.fn() };
  const globals = globalThis as { document?: unknown };

  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "web");
    classList.add.mockClear();
    classList.remove.mockClear();
    globals.document = { body: { classList } };
  });
  afterEach(() => {
    delete globals.document;
  });

  it("asks the OS nothing about contrast and resolves the system scheme itself", async () => {
    const os = osSettings();
    jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("dark");
    await show();
    expect(os.darkerRead).not.toHaveBeenCalled();
    expect(os.highTextRead).not.toHaveBeenCalled();
    expect(mockSetColorScheme).toHaveBeenCalledWith("dark");
  });

  it("sets an explicit scheme as it is, and the system's as light when the browser says so", async () => {
    osSettings();
    jest.spyOn(ReactNative, "useColorScheme").mockReturnValue("light");
    await show();
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("light");
    await fireEvent.press(screen.getByLabelText("dark"));
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("dark");
  });

  it("puts the high-contrast set on the body too, where portalled dialogs live, and takes it off again", async () => {
    osSettings();
    const view = await show();
    expect(classList.add).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("contrast on"));
    expect(classList.add).toHaveBeenCalledWith("high-contrast");
    await view.unmount();
    expect(classList.remove).toHaveBeenCalledWith("high-contrast");
  });
});
