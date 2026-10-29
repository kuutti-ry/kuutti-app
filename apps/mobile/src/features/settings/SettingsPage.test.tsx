import { act, renderHook } from "@testing-library/react-native";
import type { ScrollView, View } from "react-native";
import { useReveal } from "./SettingsPage";

// Bringing a part of Settings into sight as its row opens (#511).

const mockReduceMotion = jest.fn(() => false);
jest.mock("@/theme/useReducedMotion", () => ({ useReducedMotion: () => mockReduceMotion() }));

/** A page of `shown` points scrolled to `offset`, and a part at `top` that is `height` tall. */
async function page(shown: number, offset: number) {
  const { result } = await renderHook(() => useReveal());
  const scrollTo = jest.fn();
  const content = {} as View;
  result.current.scrollProps.ref.current = {
    getInnerViewRef: () => content,
    scrollTo,
  } as unknown as ScrollView;
  await act(async () => {
    result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: shown } } });
    result.current.scrollProps.onScroll({
      nativeEvent: { contentOffset: { x: 0, y: offset } },
    } as never);
  });
  const part = (top: number, height: number) =>
    ({
      measureLayout: (to: unknown, done: (x: number, y: number, w: number, h: number) => void) => {
        expect(to).toBe(content);
        done(0, top, 100, height);
      },
    }) as unknown as View;
  return { reveal: result.current.reveal, part, scrollTo };
}

describe("useReveal", () => {
  beforeEach(() => mockReduceMotion.mockReturnValue(false));

  it("scrolls by the least that shows a part below the fold", async () => {
    const { reveal, part, scrollTo } = await page(600, 0);
    reveal(part(500, 300));
    expect(scrollTo).toHaveBeenCalledWith({ y: 200, animated: true });
  });

  it("shows a part taller than the page from its top, never past it", async () => {
    const { reveal, part, scrollTo } = await page(600, 0);
    reveal(part(400, 900));
    expect(scrollTo).toHaveBeenCalledWith({ y: 400, animated: true });
  });

  it("leaves a part in sight where it is", async () => {
    const { reveal, part, scrollTo } = await page(600, 300);
    reveal(part(500, 300));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("jumps, without the scroll moving, under reduce motion", async () => {
    mockReduceMotion.mockReturnValue(true);
    const { reveal, part, scrollTo } = await page(600, 0);
    reveal(part(700, 100));
    expect(scrollTo).toHaveBeenCalledWith({ y: 200, animated: false });
  });

  it("does nothing before the page is there", async () => {
    const { result } = await renderHook(() => useReveal());
    const measureLayout = jest.fn();
    result.current.reveal({ measureLayout } as unknown as View);
    expect(measureLayout).not.toHaveBeenCalled();
  });
});
