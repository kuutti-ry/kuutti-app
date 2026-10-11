import { act, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { renderWithTheme } from "@/test/render";
import { Skeleton } from "./skeleton";

// The loading placeholder (#12): hidden from screen readers (the screen says
// it is loading), and it pulses only when motion is allowed.

afterEach(() => jest.restoreAllMocks());

async function showWith(reduceMotion: boolean) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduceMotion);
  await renderWithTheme(<Skeleton testID="placeholder" className="h-4 w-10" />);
  await act(async () => undefined);
  return screen.getByTestId("placeholder", { includeHiddenElements: true });
}

describe("Skeleton", () => {
  it("pulses and stays out of the screen reader's way", async () => {
    const placeholder = await showWith(false);
    expect(placeholder.props.accessibilityElementsHidden).toBe(true);
    expect(placeholder.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(placeholder.props.className).toMatch(/\banimate-pulse\b/);
    expect(placeholder.props.className).toMatch(/\bh-4 w-10\b/);
  });

  it("holds still under reduce motion", async () => {
    const placeholder = await showWith(true);
    expect(placeholder.props.className).not.toMatch(/animate-pulse/);
  });
});
