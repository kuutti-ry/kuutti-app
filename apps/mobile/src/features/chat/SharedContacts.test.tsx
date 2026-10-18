import { screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, Platform } from "react-native";
import { renderWithTheme, underProviders } from "@/test/render";
import { SharedContacts } from "./SharedContacts";

// What the other person shares, under a conversation's header (#103): a line
// each, said when it appears while the screen is open (VoiceOver told,
// TalkBack's region), never what was there when it opened, and nothing for a
// line taken back.

const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
const INSTAGRAM = { kind: "instagram", value: "ville.k" } as const;
const TELEGRAM = { kind: "telegram", value: "ville_k" } as const;

beforeEach(() => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe("what the other person shares", () => {
  it("tells VoiceOver a line that appears, once, and nothing for the ones there at first or taken back", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const view = await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM]} />);
    expect(announced()).toEqual([]);
    await view.rerender(
      underProviders(<SharedContacts name="Ville" theirs={[INSTAGRAM, TELEGRAM]} />),
    );
    await view.rerender(
      underProviders(<SharedContacts name="Ville" theirs={[INSTAGRAM, TELEGRAM]} />),
    );
    await view.rerender(underProviders(<SharedContacts name="Ville" theirs={[TELEGRAM]} />));
    expect(announced()).toEqual(["Ville shares Telegram: ville_k"]);
    // A changed value is a new line.
    await view.rerender(
      underProviders(<SharedContacts name="Ville" theirs={[{ ...TELEGRAM, value: "ville_k2" }]} />),
    );
    expect(announced()).toEqual([
      "Ville shares Telegram: ville_k",
      "Ville shares Telegram: ville_k2",
    ]);
  });

  it("leaves a line that appears to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const view = await renderWithTheme(<SharedContacts name="Ville" theirs={[]} />);
    expect(screen.queryByText(/ville/)).toBeNull();
    await view.rerender(underProviders(<SharedContacts name="Ville" theirs={[INSTAGRAM]} />));
    const line = screen.getByText("Instagram: ville.k");
    expect(line.props.accessibilityLabel).toBe("Ville shares Instagram: ville.k");
    let region: unknown;
    for (let node = line.parent; node && region === undefined; node = node.parent) {
      region = node.props.accessibilityLiveRegion;
    }
    expect(region).toBe("polite");
    expect(announced()).toEqual([]);
  });
});
