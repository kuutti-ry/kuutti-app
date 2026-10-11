import { act, renderHook } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, Platform } from "react-native";
import { useHapticTap } from "./haptics";

// The light tap of a completed action (#12): on a phone with motion allowed,
// never under reduce-motion, never on the web preview.

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

const impact = Haptics.impactAsync as jest.Mock;

async function tapWith(reduceMotion: boolean) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduceMotion);
  const { result } = await renderHook(() => useHapticTap());
  await act(async () => undefined);
  result.current();
}

beforeEach(() => impact.mockClear());
afterEach(() => jest.restoreAllMocks());

describe("useHapticTap", () => {
  it("taps lightly on a phone with motion allowed", async () => {
    await tapWith(false);
    expect(impact).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledWith("light");
  });

  it("stays still when the person asked for reduced motion", async () => {
    await tapWith(true);
    expect(impact).not.toHaveBeenCalled();
  });

  it("stays still on the web preview, where there is nothing to buzz", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await tapWith(false);
    expect(impact).not.toHaveBeenCalled();
  });
});
