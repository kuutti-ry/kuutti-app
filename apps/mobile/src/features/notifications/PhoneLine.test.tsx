import * as Sentry from "@sentry/react-native";
import { act, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, AppState, Linking, Platform, View } from "react-native";
import { useLocaleSettings } from "@/lib/locale";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { PhoneLine } from "./PhoneLine";

// What this phone's answer leaves to do, first on Settings › Notifications
// (#102, ADR-055 §9, #581): the row's value says the answer, so a phone that
// allows them draws nothing, a refusal only the way to the phone's settings, a
// phone never asked only the phone's own question, asked once however often
// the button is pressed, and only a device that cannot show them draws a line.
// Read again as the app comes back to the front, a change said aloud on both
// platforms, the token registered on a yes to the phone's question, nothing
// done after the screen has gone, and on the web the line alone.

// NativeWind's colour-scheme setter needs its compiled stylesheet, which the
// test runner has none of: the web preview's theme effect calls it, seen, not applied.
jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

const notifications = jest.mocked(Notifications);
const status = (ios: number, root: string) => ({
  status: root,
  granted: root === "granted",
  canAskAgain: root !== "denied",
  expires: "never",
  ios: { status: ios },
});
const NOT_ASKED = status(0, "undetermined");
const ALLOWED = status(2, "granted");
const DENIED = status(1, "denied");
/** What Android 13 and later answer for a phone never asked: denied, and askable. */
const ANDROID_NOT_ASKED = { status: "denied", granted: false, canAskAgain: true, expires: "never" };
const ALLOW = "Allow notifications";
const OPEN = "Open the phone's settings";
const LINES = {
  allowed: "This phone shows Kuutti's notifications.",
  denied:
    "This phone does not show Kuutti's notifications. You can allow them in the phone's settings.",
  undetermined: "This phone has not been asked yet whether Kuutti may notify it.",
  unavailable: "This device cannot show Kuutti's notifications.",
};

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const phoneSays = (answer: ReturnType<typeof status>) =>
  notifications.getPermissionsAsync.mockResolvedValue(answer as never);
const phoneCannotSay = () =>
  notifications.getPermissionsAsync.mockRejectedValue(new Error("no module"));

/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children);
/** What a screen reader was told, by the call: `queued` is iOS's, `plain` Android's (sayAloud). */
const told = () => ({
  queued: (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mock.calls,
  plain: (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls,
});
const NOTHING_TOLD = { queued: [], plain: [] };
/** The phone's answer, held until the test gives it. */
function held() {
  let give: (answer: ReturnType<typeof status>) => void = () => undefined;
  const answer = new Promise<never>((resolve) => {
    give = resolve as never;
  });
  return { answer, give };
}

let appState: Array<(state: string) => void>;
let removed: jest.Mock[];
const toApp = (state: string) =>
  act(async () => {
    for (const listener of appState) listener(state);
  });

function api(): unknown[] {
  const seen: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request) => {
    if (new URL(input.url).pathname === "/push-token") seen.push(await input.json());
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return seen;
}

// A session of its own for each test: the app sends a registration once per
// session, token and language.
let sessions = 0;

beforeEach(async () => {
  jest.clearAllMocks();
  appState = [];
  removed = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appState.push(listener as (state: string) => void);
    const remove = jest.fn();
    removed.push(remove);
    return { remove } as never;
  });
  phoneSays(NOT_ASKED);
  await clearSession();
  sessions += 1;
  await saveSession({
    sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(sessions).padStart(12, "0")}`,
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("PhoneLine", () => {
  it.each<[string, () => unknown, string[]]>([
    ["allows them", () => phoneSays(ALLOWED), []],
    ["refuses them", () => phoneSays(DENIED), [OPEN]],
    ["was never asked", () => phoneSays(NOT_ASKED), [ALLOW]],
    ["cannot be read", phoneCannotSay, [LINES.unavailable]],
  ])(
    "draws only what a phone that %s leaves to do, and says nothing of the first read",
    async (_what, answers, expected) => {
      answers();
      await renderWithTheme(<PhoneLine />);
      await settle();
      expect(notifications.getPermissionsAsync).toHaveBeenCalled();
      expect(drawn()).toEqual(expected);
      expect(told()).toEqual(NOTHING_TOLD);
      noProblems();
    },
  );

  it("leaves no empty view behind for a phone that allows them, whose gap the panel would draw", async () => {
    phoneSays(ALLOWED);
    await renderWithTheme(
      <View testID="panel">
        <PhoneLine />
      </View>,
    );
    await settle();
    expect(screen.getByTestId("panel").children.length).toBe(0);
  });

  it("takes a refusal to the phone's settings, and reports settings that would not open", async () => {
    phoneSays(DENIED);
    const open = jest.spyOn(Linking, "openSettings").mockResolvedValue();
    await renderWithTheme(<PhoneLine />);
    const user = userEvent.setup();
    await user.press(await screen.findByRole("button", { name: OPEN }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    const error = new Error("no settings");
    open.mockRejectedValueOnce(error);
    await user.press(screen.getByRole("button", { name: OPEN }));
    await settle();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("asks a phone never asked with its own question, says the yes, and registers on it", async () => {
    const seen = api();
    notifications.requestPermissionsAsync.mockImplementationOnce(async () => {
      phoneSays(ALLOWED);
      return ALLOWED as never;
    });
    await renderWithTheme(<PhoneLine />);
    await userEvent.setup().press(await screen.findByRole("button", { name: ALLOW }));
    await waitFor(() => expect(drawn()).toEqual([]));
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(told().queued).toEqual([[LINES.allowed, { queue: true }]]);
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("on Android takes a phone never asked for one, with its question, though the phone answers denied", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    notifications.getPermissionsAsync.mockResolvedValue(ANDROID_NOT_ASKED as never);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByRole("button", { name: ALLOW })).toBeTruthy();
    expect(screen.queryByRole("button", { name: OPEN })).toBeNull();
  });

  it("after the phone's no offers the way to its settings, says the refusal, and registers nothing", async () => {
    const seen = api();
    notifications.requestPermissionsAsync.mockImplementationOnce(async () => {
      phoneSays(DENIED);
      return DENIED as never;
    });
    await renderWithTheme(<PhoneLine />);
    await userEvent.setup().press(await screen.findByRole("button", { name: ALLOW }));
    expect(await screen.findByRole("button", { name: OPEN })).toBeTruthy();
    expect(told().queued).toEqual([[LINES.denied, { queue: true }]]);
    await settle();
    expect(seen).toEqual([]);
  });

  it("reads the phone again back in front, and leaves the registration to the push", async () => {
    const seen = api();
    phoneSays(DENIED);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByRole("button", { name: OPEN })).toBeTruthy();

    // Away in the phone's settings: nothing is read until the app is in front again.
    phoneSays(ALLOWED);
    await toApp("background");
    await settle();
    expect(screen.getByRole("button", { name: OPEN })).toBeTruthy();
    await toApp("active");
    await waitFor(() => expect(drawn()).toEqual([]));
    // The push registers as the app comes back, on every screen (PushNotifications.test).
    await settle();
    expect(seen).toEqual([]);
  });

  it("stops listening for the app's coming back once the screen has gone", async () => {
    const view = await renderWithTheme(<PhoneLine />);
    expect(await screen.findByRole("button", { name: ALLOW })).toBeTruthy();
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toHaveBeenCalled();
    await view.rerender(underProviders(<View />));
    expect(removed[0]).toHaveBeenCalledTimes(1);
  });

  it("asks the phone once however often Allow is pressed, the button dimmed while the question is open", async () => {
    const seen = api();
    const question = held();
    notifications.requestPermissionsAsync.mockImplementationOnce(() => question.answer);
    await renderWithTheme(<PhoneLine />);
    const user = userEvent.setup();
    await user.press(await screen.findByRole("button", { name: ALLOW }));
    const allow = screen.getByRole("button", { name: ALLOW });
    expect(allow.props.accessibilityState?.disabled).toBe(true);
    await user.press(allow);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    phoneSays(ALLOWED);
    await act(async () => question.give(ALLOWED));
    await waitFor(() => expect(drawn()).toEqual([]));
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("lets Allow be pressed again after a question closed without an answer", async () => {
    notifications.requestPermissionsAsync.mockResolvedValueOnce(NOT_ASKED as never);
    await renderWithTheme(<PhoneLine />);
    const user = userEvent.setup();
    await user.press(await screen.findByRole("button", { name: ALLOW }));
    await settle();
    // Nothing changed, so nothing is said.
    expect(told()).toEqual(NOTHING_TOLD);
    const allow = screen.getByRole("button", { name: ALLOW });
    expect(allow.props.accessibilityState?.disabled).toBe(false);
    await user.press(allow);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it("does nothing with the phone's answer to the question after the screen has gone", async () => {
    const seen = api();
    const question = held();
    notifications.requestPermissionsAsync.mockImplementationOnce(() => question.answer);
    const view = await renderWithTheme(<PhoneLine />);
    await userEvent.setup().press(await screen.findByRole("button", { name: ALLOW }));
    await view.rerender(underProviders(<View />));
    phoneSays(ALLOWED);
    await act(async () => question.give(ALLOWED));
    await settle();
    expect(seen).toEqual([]);
    expect(told()).toEqual(NOTHING_TOLD);
  });

  describe.each<[string, "ios" | "android", (words: string) => unknown]>([
    ["iOS, queued", "ios", (words) => ({ queued: [[words, { queue: true }]], plain: [] })],
    ["Android, plainly", "android", (words) => ({ queued: [], plain: [[words]] })],
  ])("says a change after the first read on %s", (_name, os, toldOnce) => {
    it.each<[string, () => unknown, () => unknown, string]>([
      ["to allowed", () => phoneSays(DENIED), () => phoneSays(ALLOWED), LINES.allowed],
      ["to refused", () => phoneSays(ALLOWED), () => phoneSays(DENIED), LINES.denied],
      ["to not asked", () => phoneSays(DENIED), () => phoneSays(NOT_ASKED), LINES.undetermined],
      ["to not readable", () => phoneSays(ALLOWED), phoneCannotSay, LINES.unavailable],
    ])("%s, once", async (_change, before, after, words) => {
      jest.replaceProperty(Platform, "OS", os);
      api();
      before();
      await renderWithTheme(<PhoneLine />);
      await settle();
      expect(told()).toEqual(NOTHING_TOLD);
      after();
      await toApp("active");
      await waitFor(() => expect(told()).toEqual(toldOnce(words)));
      // Read again unchanged: nothing said twice.
      await toApp("active");
      await settle();
      expect(told()).toEqual(toldOnce(words));
    });
  });

  it("says nothing as the language changes with the phone's answer the same: the words moved, not the answer", async () => {
    const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
    let speak: (preference: "fi") => void = () => undefined;
    function Language() {
      speak = useLocaleSettings().setPreference;
      return null;
    }
    phoneSays(DENIED);
    await renderWithTheme(
      <>
        <Language />
        <PhoneLine />
      </>,
    );
    await settle();
    await act(async () => speak("fi"));
    expect(await screen.findByRole("button", { name: "Avaa puhelimen asetukset" })).toBeTruthy();
    await settle();
    store.delete("kuutti.preference.locale");
    expect(told()).toEqual(NOTHING_TOLD);
  });

  it("leaves the one line it draws out of any live region: a change is said, and TalkBack would hear it twice", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    phoneCannotSay();
    await renderWithTheme(<PhoneLine />);
    const line = await screen.findByText(LINES.unavailable);
    expect(line.props.accessibilityLiveRegion).toBeUndefined();
  });

  it("on the web target says that the device cannot show them, and reads, listens for and asks nothing", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    const seen = api();
    await renderWithTheme(<PhoneLine />);
    expect(screen.getByText(LINES.unavailable)).toBeTruthy();
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    for (const call of [
      notifications.getPermissionsAsync,
      notifications.requestPermissionsAsync,
      notifications.setNotificationChannelAsync,
      notifications.getExpoPushTokenAsync,
      notifications.addPushTokenListener,
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(seen).toEqual([]);
    expect(told()).toEqual(NOTHING_TOLD);
  });
});
