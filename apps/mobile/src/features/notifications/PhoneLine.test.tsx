import * as Sentry from "@sentry/react-native";
import { act, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { AccessibilityInfo, AppState, Linking, Platform, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { PhoneLine } from "./PhoneLine";

// Whether this phone lets Kuutti notify it, on Settings › Notifications
// (#102, ADR-055 §9): each state in words, the way to the phone's settings
// under a refusal, the phone's own question for a phone never asked, asked
// once however often the button is pressed, read again as the app comes back
// to the front, a change said (VoiceOver told, TalkBack's region), the token
// registered on a yes to the phone's question, nothing done after the screen
// has gone, and on the web the line alone.

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

const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
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
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("PhoneLine", () => {
  it("says a phone that allows them, with nothing to press", async () => {
    phoneSays(ALLOWED);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says a refusal with the way to the phone's settings, and reports settings that would not open", async () => {
    phoneSays(DENIED);
    const open = jest.spyOn(Linking, "openSettings").mockResolvedValue();
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.denied)).toBeTruthy();
    noProblems();
    const user = userEvent.setup();
    await user.press(screen.getByRole("button", { name: "Open the phone's settings" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    const error = new Error("no settings");
    open.mockRejectedValueOnce(error);
    await user.press(screen.getByRole("button", { name: "Open the phone's settings" }));
    await settle();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("asks a phone never asked with its own question, and registers on its yes", async () => {
    const seen = api();
    notifications.requestPermissionsAsync.mockImplementationOnce(async () => {
      phoneSays(ALLOWED);
      return ALLOWED as never;
    });
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.undetermined)).toBeTruthy();
    noProblems();
    await userEvent.setup().press(screen.getByRole("button", { name: "Allow notifications" }));
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("on Android says a phone never asked as such, with its question, though the phone answers denied", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    notifications.getPermissionsAsync.mockResolvedValue(ANDROID_NOT_ASKED as never);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.undetermined)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow notifications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the phone's settings" })).toBeNull();
  });

  it("after the phone's no says the refusal and registers nothing", async () => {
    const seen = api();
    notifications.requestPermissionsAsync.mockImplementationOnce(async () => {
      phoneSays(DENIED);
      return DENIED as never;
    });
    await renderWithTheme(<PhoneLine />);
    await userEvent
      .setup()
      .press(await screen.findByRole("button", { name: "Allow notifications" }));
    expect(await screen.findByText(LINES.denied)).toBeTruthy();
    await settle();
    expect(seen).toEqual([]);
  });

  it("says a phone that cannot be read, with nothing to press", async () => {
    notifications.getPermissionsAsync.mockRejectedValue(new Error("no module"));
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.unavailable)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reads the phone again back in front, and leaves the registration to the push", async () => {
    const seen = api();
    phoneSays(DENIED);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.denied)).toBeTruthy();

    // Away in the phone's settings: nothing is read until the app is in front again.
    phoneSays(ALLOWED);
    await toApp("background");
    await settle();
    expect(screen.getByText(LINES.denied)).toBeTruthy();
    await toApp("active");
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    // The push registers as the app comes back, on every screen (PushNotifications.test).
    await settle();
    expect(seen).toEqual([]);
  });

  it("does nothing with an answer that comes after the screen has gone", async () => {
    const seen = api();
    let answer: (value: unknown) => void = () => undefined;
    notifications.getPermissionsAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    );
    const view = await renderWithTheme(<PhoneLine />);
    await view.rerender(underProviders(<View />));
    await act(async () => answer(ALLOWED));
    await settle();
    expect(screen.queryByText(LINES.allowed)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("stops listening for the app's coming back once the screen has gone", async () => {
    const view = await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.undetermined)).toBeTruthy();
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
    await user.press(await screen.findByRole("button", { name: "Allow notifications" }));
    const allow = screen.getByRole("button", { name: "Allow notifications" });
    expect(allow.props.accessibilityState?.disabled).toBe(true);
    await user.press(allow);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    phoneSays(ALLOWED);
    await act(async () => question.give(ALLOWED));
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("lets Allow be pressed again after a question closed without an answer", async () => {
    notifications.requestPermissionsAsync.mockResolvedValueOnce(NOT_ASKED as never);
    await renderWithTheme(<PhoneLine />);
    const user = userEvent.setup();
    await user.press(await screen.findByRole("button", { name: "Allow notifications" }));
    await settle();
    const allow = screen.getByRole("button", { name: "Allow notifications" });
    expect(allow.props.accessibilityState?.disabled).toBe(false);
    await user.press(allow);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  });

  it("does nothing with the phone's answer to the question after the screen has gone", async () => {
    const seen = api();
    const question = held();
    notifications.requestPermissionsAsync.mockImplementationOnce(() => question.answer);
    const view = await renderWithTheme(<PhoneLine />);
    await userEvent
      .setup()
      .press(await screen.findByRole("button", { name: "Allow notifications" }));
    await view.rerender(underProviders(<View />));
    phoneSays(ALLOWED);
    await act(async () => question.give(ALLOWED));
    await settle();
    expect(seen).toEqual([]);
  });

  it("tells VoiceOver of a change after the first read, once, and not of the first read", async () => {
    api();
    phoneSays(DENIED);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.denied)).toBeTruthy();
    expect(announced()).toEqual([]);
    phoneSays(ALLOWED);
    await toApp("active");
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    expect(announced()).toEqual([LINES.allowed]);
    // Read again unchanged: nothing said twice.
    await toApp("active");
    await settle();
    expect(announced()).toEqual([LINES.allowed]);
  });

  it("leaves the saying to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    api();
    phoneSays(DENIED);
    await renderWithTheme(<PhoneLine />);
    expect(await screen.findByText(LINES.denied)).toBeTruthy();
    phoneSays(ALLOWED);
    await toApp("active");
    expect(await screen.findByText(LINES.allowed)).toBeTruthy();
    expect(screen.getByText(LINES.allowed).props.accessibilityLiveRegion).toBe("polite");
    expect(announced()).toEqual([]);
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
  });
});
