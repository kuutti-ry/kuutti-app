import { screen } from "@testing-library/react-native";
import { AccessibilityInfo, Platform } from "react-native";
import { renderWithTheme, underProviders } from "@/test/render";
import { Notice } from "./Notice";

// What came of a change (#511): a live region for Android and the web, and
// said aloud on iOS, which has none.

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
