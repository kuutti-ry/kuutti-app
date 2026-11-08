import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import type { View } from "react-native";
import { RevealProvider, useRevealOn } from "./reveal";

// A panel's part brought into sight by the page around it (#511).

const frame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

function withReveal(reveal: (part: View) => void) {
  return ({ children }: { children: ReactNode }) => (
    <RevealProvider value={reveal}>{children}</RevealProvider>
  );
}

afterEach(() => jest.restoreAllMocks());

describe("useRevealOn", () => {
  it("asks the page to show the part a frame after something new is in it, once for each", async () => {
    const reveal = jest.fn();
    const part = {} as View;
    const hook = await renderHook(({ shown }: { shown: string | null }) => useRevealOn(shown), {
      initialProps: { shown: null as string | null },
      wrapper: withReveal(reveal),
    });
    hook.result.current.current = part;
    await frame();
    expect(reveal).not.toHaveBeenCalled();
    await hook.rerender({ shown: "first" });
    await frame();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(part);
    await hook.rerender({ shown: "first" });
    await frame();
    expect(reveal).toHaveBeenCalledTimes(1);
    await hook.rerender({ shown: "second" });
    await frame();
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a part not drawn, nor once the panel has gone", async () => {
    // Frames held back until the test runs them. Under jest a frame is a timer of
    // no delay, which on a busy machine fired between the rerender and the unmount
    // below, and the test failed with nothing wrong.
    const frames = new Map<number, (time: number) => void>();
    let last = 0;
    jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation((run) => {
      last += 1;
      frames.set(last, run);
      return last;
    });
    jest.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(Number(id));
    });
    const runFrames = () => {
      for (const [id, run] of frames) {
        frames.delete(id);
        run(0);
      }
    };

    const reveal = jest.fn();
    const hook = await renderHook(({ shown }: { shown: string | null }) => useRevealOn(shown), {
      initialProps: { shown: "made" as string | null },
      wrapper: withReveal(reveal),
    });
    runFrames();
    expect(reveal).not.toHaveBeenCalled();
    hook.result.current.current = {} as View;
    await hook.rerender({ shown: "again" });
    await hook.unmount();
    runFrames();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("scrolls nothing on a page that gives no way to", async () => {
    const hook = await renderHook(() => useRevealOn("made"));
    hook.result.current.current = {} as View;
    await frame();
    expect(hook.result.current.current).toBeTruthy();
  });
});
