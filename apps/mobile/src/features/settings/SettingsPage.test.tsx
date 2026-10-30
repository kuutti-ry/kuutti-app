import { act, renderHook } from "@testing-library/react-native";
import { Keyboard, Platform, type ScrollView, type View } from "react-native";
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

  it("brings a part above the page's top down to its top, as when the open row above closed", async () => {
    const { reveal, part, scrollTo } = await page(600, 900);
    reveal(part(700, 300));
    expect(scrollTo).toHaveBeenCalledWith({ y: 700, animated: true });
  });

  it("brings a part cut by the page's top down to its top", async () => {
    const { reveal, part, scrollTo } = await page(600, 900);
    reveal(part(850, 200));
    expect(scrollTo).toHaveBeenCalledWith({ y: 850, animated: true });
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

  it("checks a part revealed again as the page settles shorter, as the safe area arrives", async () => {
    const { result } = await renderHook(() => useReveal());
    const scrollTo = jest.fn();
    const content = {} as View;
    result.current.scrollProps.ref.current = {
      getInnerViewRef: () => content,
      scrollTo,
    } as unknown as ScrollView;
    const part = {
      measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
        done(0, 700, 100, 120),
    } as unknown as View;
    await act(async () => {
      result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: 855 } } });
    });
    result.current.reveal(part);
    // In sight on a page of 855 points.
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => {
      result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: 780 } } });
    });
    expect(scrollTo).toHaveBeenCalledWith({ y: 40, animated: true });
  });

  /** A page of 780 points at its top, and a part at `top.at` that is 120 tall, revealed at 10 seconds. */
  async function settling() {
    const { result } = await renderHook(() => useReveal());
    const scrollTo = jest.fn();
    const content = {} as View;
    result.current.scrollProps.ref.current = {
      getInnerViewRef: () => content,
      scrollTo,
    } as unknown as ScrollView;
    const top = { at: 600 };
    const part = {
      measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
        done(0, top.at, 100, 120),
    } as unknown as View;
    await act(async () => {
      result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: 780 } } });
    });
    const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
    result.current.reveal(part);
    return { props: result.current.scrollProps, scrollTo, top, now };
  }

  afterEach(() => jest.restoreAllMocks());

  it("checks a part revealed again as the rows above it grow, until the person touches the list", async () => {
    const { props, scrollTo, top, now } = await settling();
    expect(scrollTo).not.toHaveBeenCalled();
    // The values above it arrive, seconds later, and push it 200 points down.
    top.at = 800;
    now.mockReturnValue(14_000);
    props.onContentSizeChange();
    expect(scrollTo).toHaveBeenCalledWith({ y: 140, animated: true });
    // Once touched, the list is the person's: nothing moves it again.
    scrollTo.mockClear();
    props.onTouchStart();
    top.at = 1000;
    props.onContentSizeChange();
    props.onLayout({ nativeEvent: { layout: { height: 500 } } });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("lets a part revealed go after ten seconds, touched or not", async () => {
    const { props, scrollTo, top, now } = await settling();
    top.at = 800;
    now.mockReturnValue(20_000);
    props.onContentSizeChange();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("lets a part go as the keyboard comes up, for a field chosen by touch or by a screen reader", async () => {
    const added = jest.spyOn(Keyboard, "addListener");
    const { props, scrollTo, top, now } = await settling();
    const shown = added.mock.calls.find(([event]) => event === "keyboardDidShow")?.[1];
    expect(shown).toBeDefined();
    await act(async () => shown?.({} as never));
    // The page shortened for the keyboard, the part below the field: left where it is.
    top.at = 800;
    now.mockReturnValue(11_000);
    props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("lets a part go once the list scrolls, long after the reveal's own scroll, as a screen reader's swipe does", async () => {
    const { props, scrollTo, top, now } = await settling();
    now.mockReturnValue(12_000);
    props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 300 } } } as never);
    top.at = 1200;
    props.onContentSizeChange();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps a part while the list moves by the reveal's own scroll, measured from where it ended", async () => {
    const { props, scrollTo, top, now } = await settling();
    top.at = 800;
    now.mockReturnValue(11_000);
    props.onContentSizeChange();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 140, animated: true });
    now.mockReturnValue(11_300);
    props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 140 } } } as never);
    top.at = 900;
    now.mockReturnValue(11_600);
    props.onContentSizeChange();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 240, animated: true });
  });

  it("on Android, measures a row tapped while typing once the keyboard has gone, against the whole page", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const visible = jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
    const { result } = await renderHook(() => useReveal());
    const scrollTo = jest.fn();
    const content = {} as View;
    result.current.scrollProps.ref.current = {
      getInnerViewRef: () => content,
      scrollTo,
    } as unknown as ScrollView;
    const part = {
      measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
        done(0, 300, 100, 600),
    } as unknown as View;
    // The page the keyboard shortened, as the row's press dismisses it.
    await act(async () => {
      result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: 400 } } });
    });
    result.current.reveal(part);
    // Against that page it would have gone to the part's top, 300.
    expect(scrollTo).not.toHaveBeenCalled();
    visible.mockReturnValue(false);
    await act(async () => {
      result.current.scrollProps.onLayout({ nativeEvent: { layout: { height: 780 } } });
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 120, animated: true });
  });

  it("does nothing before the page is there", async () => {
    const { result } = await renderHook(() => useReveal());
    const measureLayout = jest.fn();
    result.current.reveal({ measureLayout } as unknown as View);
    expect(measureLayout).not.toHaveBeenCalled();
  });
});
