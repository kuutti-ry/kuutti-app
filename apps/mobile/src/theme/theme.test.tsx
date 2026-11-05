import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Text } from "react-native";
import { renderWithTheme } from "@/test/render";
import { hitSlopFor } from "./a11y";
import { parseTokenSets } from "./contrast";
import { useMotionDuration, useReducedMotion } from "./useReducedMotion";

function mockReduceMotion(initial: boolean) {
  // Every mounted hook subscribes on its own, as on a device.
  const listeners = new Set<(enabled: boolean) => void>();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(initial);
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation((event: string, handler) => {
    const listener = handler as unknown as (enabled: boolean) => void;
    if (event === "reduceMotionChanged") listeners.add(listener);
    return { remove: () => listeners.delete(listener) } as never;
  });
  return {
    change: (enabled: boolean) => {
      for (const listener of listeners) listener(enabled);
    },
  };
}

describe("reduce motion", () => {
  afterEach(() => jest.restoreAllMocks());

  it("makes the theme transition instant when the OS setting is on", async () => {
    mockReduceMotion(true);
    const { result } = await renderHook(() => useMotionDuration(150));
    await act(async () => undefined);
    expect(result.current).toBe(0);
  });

  it("keeps the duration when the setting is off, and follows a change while running", async () => {
    const settings = mockReduceMotion(false);
    const { result } = await renderHook(() => ({
      reduced: useReducedMotion(),
      duration: useMotionDuration(150),
    }));
    await act(async () => undefined);
    expect(result.current).toEqual({ reduced: false, duration: 150 });
    await act(async () => settings.change(true));
    expect(result.current).toEqual({ reduced: true, duration: 0 });
  });
});

describe("touch targets", () => {
  it("extends a small control to 44 pt and leaves a large one alone", () => {
    expect(hitSlopFor(52, 32)).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
    expect(hitSlopFor(20, 20)).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
    expect(hitSlopFor(44, 60)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});

describe("tokens", () => {
  it("match the reviewed values in every set", () => {
    // A designer's edit shows up in review as a snapshot diff, per set.
    const sets = parseTokenSets(readFileSync(resolve(__dirname, "tokens.css"), "utf8"));
    expect(sets).toMatchSnapshot();
  });

  it("define the same names in every set, so no theme falls through to another", () => {
    const sets = parseTokenSets(readFileSync(resolve(__dirname, "tokens.css"), "utf8"));
    const names = (set: string) =>
      Object.keys(sets[set] ?? {})
        .filter((n) => n !== "radius")
        .sort();
    for (const set of [".dark:root", ".high-contrast", ".high-contrast-dark"]) {
      expect(names(set)).toEqual(names(":root"));
    }
  });

  it("back every colour class of the Tailwind config, the seeks bar's among them", () => {
    const defined = Object.keys(
      parseTokenSets(readFileSync(resolve(__dirname, "tokens.css"), "utf8"))[":root"] ?? {},
    );
    const { colors } = require("../../tailwind.config.js").theme.extend as {
      colors: Record<string, string | Record<string, string>>;
    };
    const used = [...JSON.stringify(colors).matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
    expect(used).toEqual(expect.arrayContaining(["seeks-men", "seeks-everyone", "seeks-women"]));
    expect(used.filter((name) => !defined.includes(name ?? ""))).toEqual([]);
  });
});

describe("ThemeProvider", () => {
  it("keeps theme-root on its root view, so switching high contrast on never remounts the app", async () => {
    // global.css explains why: without a variable from the first render,
    // NativeWind remounts the children, and the router with them, the moment
    // the high-contrast class arrives (seen on the simulator, 2026-09-19).
    await renderWithTheme(<Text>child</Text>);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain("theme-root");
  });
});
