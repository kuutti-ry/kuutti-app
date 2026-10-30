import { fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import {
  AccessibilityInfo,
  Clipboard,
  Dimensions,
  Linking,
  Platform,
  StyleSheet,
} from "react-native";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { SharedContacts } from "./SharedContacts";

// What the other person shares, under a conversation's header (#103): a line
// each, said when it appears while the screen is open (VoiceOver told,
// TalkBack's region), never what was there when it opened, and nothing for a
// line taken back; and Open and Copy beside each (#473), which name the kind
// and the person, never the value.

const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
const INSTAGRAM = { kind: "instagram", value: "ville.k" } as const;
const TELEGRAM = { kind: "telegram", value: "ville_k" } as const;
const PHONE = { kind: "phone", value: "+358401234567" } as const;
const REFUSED = "This did not open on your phone. You can copy it instead.";

const labels = () =>
  pressables(screen.toJSON() as HostNode).map((node) => String(node.props.accessibilityLabel));
const openWorks = () => jest.spyOn(Linking, "openURL").mockResolvedValue(true);
const clipboard = () => jest.spyOn(Clipboard, "setString").mockImplementation(() => undefined);
const press = (role: "link" | "button", name: string) =>
  fireEvent.press(screen.getByRole(role, { name }));

beforeEach(() => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  // React Native's jest setup makes these mocks already, and a spy on a mock keeps its calls.
  (Linking.openURL as jest.Mock).mockClear();
  (Clipboard.setString as jest.Mock).mockClear();
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

describe("A shared contact opens at its kind's own address", () => {
  it.each([
    ["a phone number", PHONE, "Call Ville", "Call", "tel:+358401234567"],
    [
      "a WhatsApp number",
      { kind: "whatsapp", value: "+358401234567" },
      "Open WhatsApp: Ville",
      "Open",
      "https://wa.me/358401234567",
    ],
    ["a Telegram username", TELEGRAM, "Open Telegram: Ville", "Open", "https://t.me/ville_k"],
    [
      "an Instagram username",
      INSTAGRAM,
      "Open Instagram: Ville",
      "Open",
      "https://www.instagram.com/ville.k/",
    ],
    [
      "a Snapchat username",
      { kind: "snapchat", value: "ville.k" },
      "Open Snapchat: Ville",
      "Open",
      "https://www.snapchat.com/add/ville.k",
    ],
  ] as const)("%s", async (_what, piece, label, button, address) => {
    const open = openWorks();
    await renderWithTheme(<SharedContacts name="Ville" theirs={[piece]} />);
    expect(screen.getByText(button)).toBeTruthy();
    await press("link", label);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(address);
    // Opening is not said: the person is looking at where it went.
    expect(announced()).toEqual([]);
  });
});

describe("opening and copying what the other person shares", () => {
  it("A contact not in the one form of its kind opens nothing and can still be copied", async () => {
    const copied = clipboard();
    await renderWithTheme(
      <SharedContacts name="Ville" theirs={[{ kind: "instagram", value: "Ville.K" }]} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Instagram: Ville.K").props.selectable).toBe(true);
    await press("button", "Copy Instagram: Ville");
    expect(copied).toHaveBeenCalledWith("Ville.K");
  });

  it("Copy puts the contact on the phone's clipboard and says so without the value", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const copied = clipboard();
    await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM, TELEGRAM]} />);
    await press("button", "Copy Instagram: Ville");
    expect(copied).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledWith("ville.k");
    expect(screen.getByText("Instagram copied.")).toBeTruthy();
    expect(announced()).toEqual(["Instagram copied."]);
    // The next one is told too: the words name the kind, so they change.
    await press("button", "Copy Telegram: Ville");
    expect(copied).toHaveBeenLastCalledWith("ville_k");
    expect(screen.queryByText("Instagram copied.")).toBeNull();
    expect(announced()).toEqual(["Instagram copied.", "Telegram copied."]);
  });

  it("leaves a copy to its own live region on Android, outside the lines' region", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    clipboard();
    await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM]} />);
    await press("button", "Copy Instagram: Ville");
    const said = screen.getByText("Instagram copied.");
    expect(said.props.accessibilityLiveRegion).toBe("polite");
    for (let node = said.parent; node; node = node.parent) {
      expect(node.props.accessibilityLiveRegion).toBeUndefined();
    }
    expect(announced()).toEqual([]);
  });

  it("A contact the phone cannot open says so in words, and Copy stays", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const logged = (["log", "info", "warn", "error"] as const).map((level) =>
      jest.spyOn(console, level),
    );
    // React Native's own refusal, which carries the address.
    jest
      .spyOn(Linking, "openURL")
      .mockRejectedValue(new Error(`Unable to open URL: tel:${PHONE.value}`));
    await renderWithTheme(<SharedContacts name="Ville" theirs={[PHONE]} />);
    await press("link", "Call Ville");
    const said = await screen.findByText(REFUSED);
    expect(said.props.accessibilityLiveRegion).toBe("assertive");
    expect(announced()).toEqual([REFUSED]);
    expect(screen.getByRole("button", { name: "Copy phone number: Ville" })).toBeTruthy();
    expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(PHONE.value);
  });

  it("says the same where the phone answers false, as the simulator does to a number", async () => {
    jest.spyOn(Linking, "openURL").mockResolvedValue(false);
    await renderWithTheme(<SharedContacts name="Ville" theirs={[PHONE]} />);
    await press("link", "Call Ville");
    expect(await screen.findByText(REFUSED)).toBeTruthy();
  });

  it("takes back what was said at the next press, and says nothing when it opens", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    clipboard();
    openWorks();
    await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM]} />);
    await press("button", "Copy Instagram: Ville");
    await press("link", "Open Instagram: Ville");
    expect(screen.queryByText("Instagram copied.")).toBeNull();
    expect(announced()).toEqual(["Instagram copied."]);
  });

  it("takes what was said away with the last line", async () => {
    clipboard();
    const view = await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM]} />);
    await press("button", "Copy Instagram: Ville");
    expect(screen.getByText("Instagram copied.")).toBeTruthy();
    await view.rerender(underProviders(<SharedContacts name="Ville" theirs={[]} />));
    expect(screen.queryByText("Instagram copied.")).toBeNull();
  });

  it("keeps the lines to a third of the window, where they scroll, and the words below them", async () => {
    clipboard();
    await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM, TELEGRAM, PHONE]} />);
    await press("button", "Copy Instagram: Ville");
    let scroll = screen.getByText("Instagram: ville.k").parent;
    while (scroll && scroll.type !== "RCTScrollView") scroll = scroll.parent;
    const { flexGrow, maxHeight } = StyleSheet.flatten(scroll?.props.style);
    expect(flexGrow).toBe(0);
    expect(maxHeight).toBeCloseTo(Dimensions.get("window").height / 3);
    for (let node = screen.getByText("Instagram copied.").parent; node; node = node.parent) {
      expect(node.type).not.toBe("RCTScrollView");
    }
  });

  it("names each button by the kind and the person, never the value, on a full target", async () => {
    await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM, PHONE]} />);
    expect(labels()).toEqual([
      "Open Instagram: Ville",
      "Copy Instagram: Ville",
      "Call Ville",
      "Copy phone number: Ville",
    ]);
    expect(pressables(screen.toJSON() as HostNode).flatMap((n) => a11yProblems(n))).toEqual([]);
  });

  it.each([
    [
      "fi-FI",
      ["Avaa Instagram: Ville", "Kopioi Instagram: Ville"],
      ["Avaa", "Kopioi"],
      "Instagram kopioitu.",
      ["Soita: Ville", "Kopioi puhelinnumero: Ville"],
      ["Soita", "Kopioi"],
      "Puhelinnumero kopioitu.",
    ],
    [
      "sv-FI",
      ["Öppna Instagram: Ville", "Kopiera Instagram: Ville"],
      ["Öppna", "Kopiera"],
      "Instagram kopierat.",
      ["Ring: Ville", "Kopiera telefonnummer: Ville"],
      ["Ring", "Kopiera"],
      "Telefonnumret kopierat.",
    ],
  ])(
    "shows and says the buttons in the phone's language, %s",
    async (languageTag, named, shown, copied, namedPhone, shownPhone, copiedPhone) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      clipboard();
      await renderWithTheme(<SharedContacts name="Ville" theirs={[INSTAGRAM, PHONE]} />);
      expect(labels()).toEqual([...named, ...namedPhone]);
      for (const words of [...shown, ...shownPhone]) {
        expect(screen.getAllByText(words).length).toBeGreaterThan(0);
      }
      await press("button", named[1] as string);
      expect(screen.getByText(copied)).toBeTruthy();
      await press("button", namedPhone[1] as string);
      expect(screen.getByText(copiedPhone)).toBeTruthy();
    },
  );
});
