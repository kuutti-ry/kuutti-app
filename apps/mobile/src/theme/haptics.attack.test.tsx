import { act, renderHook } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, Platform } from "react-native";
import { attack } from "@/test/attack";
import { useHapticTap } from "./haptics";

jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: "light" },
}));
const impact = jest.mocked(Haptics.impactAsync);
beforeEach(() => {
  impact.mockClear();
  jest.replaceProperty(Platform, "OS", "ios");
});
afterEach(() => jest.restoreAllMocks());

async function tap(reduced: boolean, web = false) {
  if (web) jest.replaceProperty(Platform, "OS", "web");
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduced);
  const { result } = await renderHook(() => useHapticTap());
  await act(async () => undefined);
  await act(async () => result.current());
  return impact.mock.calls.length;
}
attack(
  "mobile accessibility: a completed action vibrates after the person requested reduced motion",
  {
    attempt: () => tap(true),
    control: () => tap(false),
    succeeds: (calls) => expect(calls).toBeGreaterThan(0),
  },
);
attack("mobile accessibility: a web preview invokes a native haptic", {
  attempt: () => tap(false, true),
  control: () => tap(false),
  succeeds: (calls) => expect(calls).toBeGreaterThan(0),
});
