import { act, renderHook, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Platform } from "react-native";
import { renderWithTheme, underProviders } from "@/test/render";
import { Notice, sayAloud, sayOnIos, useSaid, useSpokenOnIos } from "./Notice";

// What came of a change (#511): a live region for Android and the web, and
// said aloud on iOS, which has none. Words for a screen reader alone (#581):
// told on every platform, since no line is drawn for a live region to read.

describe("Notice", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is a polite live region for what was done, and an assertive one for what was refused", async () => {
    await renderWithTheme(<Notice words="Saved." />);
    expect(screen.getByText("Saved.").props.accessibilityLiveRegion).toBe("polite");
    await renderWithTheme(<Notice refused words="Not saved." />);
    expect(screen.getByText("Not saved.").props.accessibilityLiveRegion).toBe("assertive");
  });

  it("says its words aloud on iOS, queued, and again for a new answer with the same words", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    said.mockClear();
    const view = await renderWithTheme(<Notice words="Saved." answer={1} />);
    expect(said).toHaveBeenLastCalledWith("Saved.", { queue: true });
    await view.rerender(underProviders(<Notice words="Saved." answer={1} />));
    expect(said).toHaveBeenCalledTimes(1);
    await view.rerender(underProviders(<Notice words="Saved." answer={2} />));
    expect(said).toHaveBeenCalledTimes(2);
  });

  it("leaves the saying to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
    said.mockClear();
    await renderWithTheme(<Notice words="Saved." />);
    expect(said).not.toHaveBeenCalled();
  });
});

describe("sayAloud", () => {
  const calls = () => ({
    queued: jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockClear(),
    plain: jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear(),
  });
  afterEach(() => jest.restoreAllMocks());

  it("queues the words on iOS behind what is being said, as leaving a field moves the focus", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { queued, plain } = calls();
    sayAloud("Saved.");
    expect(queued.mock.calls).toEqual([["Saved.", { queue: true }]]);
    expect(plain).not.toHaveBeenCalled();
  });

  it.each(["android", "web"] as const)("tells the reader on %s with the plain call", (os) => {
    jest.replaceProperty(Platform, "OS", os);
    const { queued, plain } = calls();
    sayAloud("Saved.");
    expect(plain.mock.calls).toEqual([["Saved."]]);
    expect(queued).not.toHaveBeenCalled();
  });
});

describe("sayOnIos and useSpokenOnIos", () => {
  const plain = () => jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockClear();
  afterEach(() => jest.restoreAllMocks());

  function Spoken({ words }: { words: string | null }) {
    useSpokenOnIos(words);
    return null;
  }

  it("tells iOS's reader the words, plainly, since it has no live regions", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const said = plain();
    sayOnIos("Saved.");
    expect(said.mock.calls).toEqual([["Saved."]]);
  });

  it.each(["android", "web"] as const)("leaves %s to its live region", (os) => {
    jest.replaceProperty(Platform, "OS", os);
    const said = plain();
    sayOnIos("Saved.");
    expect(said).not.toHaveBeenCalled();
  });

  it("says the words on iOS as they come, once each, and nothing for none", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const said = plain();
    const view = await renderWithTheme(<Spoken words={null} />);
    expect(said).not.toHaveBeenCalled();
    await view.rerender(underProviders(<Spoken words="Loading…" />));
    await view.rerender(underProviders(<Spoken words="Loading…" />));
    expect(said.mock.calls).toEqual([["Loading…"]]);
    await view.rerender(underProviders(<Spoken words="Saved." />));
    expect(said.mock.calls).toEqual([["Loading…"], ["Saved."]]);
  });

  it("says nothing on Android, whose live region reads the line", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const said = plain();
    await renderWithTheme(<Spoken words="Saved." />);
    expect(said).not.toHaveBeenCalled();
  });
});

describe("useSaid", () => {
  it("counts each answer, so the same words said again are heard again, and forgets them on null", async () => {
    const { result } = await renderHook(() => useSaid<"saved" | "failed">());
    expect(result.current.said).toBeNull();
    await act(async () => result.current.say("saved"));
    expect(result.current.said).toEqual({ notice: "saved", answer: 1 });
    await act(async () => result.current.say("saved"));
    expect(result.current.said).toEqual({ notice: "saved", answer: 2 });
    await act(async () => result.current.say("failed"));
    expect(result.current.said).toEqual({ notice: "failed", answer: 3 });
    await act(async () => result.current.say(null));
    expect(result.current.said).toBeNull();
    await act(async () => result.current.say("saved"));
    expect(result.current.said).toEqual({ notice: "saved", answer: 1 });
  });
});
