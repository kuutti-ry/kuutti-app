import * as Sentry from "@sentry/react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState, Platform, View } from "react-native";
import { useLock } from "@/features/identity";
import { type LocalePreference, useLocaleSettings } from "@/lib/locale";
import { clearSession, saveSession } from "@/lib/session";
import { renderWithTheme, underProviders } from "@/test/render";
import { PushNotifications } from "./PushNotifications";

// The push on this phone (#102, ADR-055 §2, §9): the foreground handler; the
// token registered at the start while signed in, on a new token, on a
// change of the app's language and as the app comes back to the front, once
// when nothing changed, and never while signed out; the phone's list cleared
// on a sign-out; a tap opening the conversations or today's round once,
// waiting under the lock, and nothing for a tap the app cannot read, an
// action that is not the tap, a tap while signed out or one whose lock was
// left through the bank; and none of it on the web target.

const notifications = jest.mocked(Notifications);
const phone = jest.requireMock("expo-notifications") as {
  __respond: (response: unknown) => void;
  __newToken: (token: Notifications.DevicePushToken) => void;
};
const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};
const secureStore = jest.requireMock("expo-secure-store") as { __store: Map<string, string> };

const CONVERSATION = "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f";
const CODE = "246810";
const PASSCODE = "Your Kuutti passcode";
const BANK = "Sign in with the bank instead";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
/** Expo's token for a device token the phone hands over. */
const expoToken = (seed: string) => `ExponentPushToken[${(seed + "a".repeat(22)).slice(0, 22)}]`;
// Each sign-in a session of its own, as the API gives: the app sends a
// registration once per session, token and language.
let sessions = 0;
const signIn = () => {
  sessions += 1;
  return saveSession({
    sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(sessions).padStart(12, "0")}`,
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
};
const allowed = {
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
  ios: { status: 2 },
};
const denied = { ...allowed, status: "denied", granted: false, ios: { status: 1 } };
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

// The app's comings and goings, to the push's listener and the lock's alike.
let appState: Array<(state: string) => void>;
const toApp = (state: string) =>
  act(async () => {
    for (const listener of [...appState]) listener(state);
  });

let lock: ReturnType<typeof useLock>;
/** The push with the lock's own settings at hand, as Settings › Lock has them. */
function WithLock() {
  lock = useLock();
  return <PushNotifications />;
}
/** The lock turned on with a passcode, to lock at the first time away. */
async function turnLockOn() {
  // One at a time, as Settings does: each change builds on the lock as it now is.
  await act(() => lock.setPasscode(CODE));
  await act(() => lock.setGrace(0));
}
async function unlock() {
  await fireEvent.changeText(screen.getByLabelText(PASSCODE), CODE);
  await settle();
}

/** What reached the API: each registration's body and its language. */
function api(): Array<{ body: unknown; language: string | null }> {
  const seen: Array<{ body: unknown; language: string | null }> = [];
  globalThis.fetch = jest.fn(async (input: Request) => {
    if (new URL(input.url).pathname === "/push-token") {
      seen.push({ body: await input.json(), language: input.headers.get("accept-language") });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return seen;
}

/** A tap on a push, as the module hands it over. */
const tap = (
  data: unknown,
  actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER,
  id = "n1",
) => ({
  actionIdentifier,
  notification: {
    date: 0,
    request: {
      identifier: id,
      content: { title: null, body: "x", data },
      trigger: { type: "push" },
    },
  },
});

/** The push under the app's language as the person set it in Settings. */
function InLanguage({ language }: { language: LocalePreference }) {
  const { setPreference } = useLocaleSettings();
  useEffect(() => setPreference(language), [language, setPreference]);
  return <PushNotifications />;
}

beforeEach(async () => {
  jest.clearAllMocks();
  // The phone's language and the lock, whatever a test before chose in the app.
  secureStore.__store.clear();
  phone.__respond(null);
  notifications.getPermissionsAsync.mockResolvedValue(allowed as never);
  appState = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
    const heard = listener as (state: string) => void;
    if (event === "change") appState.push(heard);
    const remove = () => {
      appState = appState.filter((other) => other !== heard);
    };
    return { remove } as never;
  });
  await clearSession();
});
afterEach(() => jest.restoreAllMocks());

describe("PushNotifications", () => {
  it("shows a push that comes while the app is in front as a banner and in the list, silent and with no badge", async () => {
    await renderWithTheme(<PushNotifications />);
    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = notifications.setNotificationHandler.mock.calls[0]?.[0];
    await expect(handler?.handleNotification({} as never)).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it("registers at the start while signed in, again for a new token and for a new language", async () => {
    const seen = api();
    await signIn();
    const view = await renderWithTheme(<InLanguage language="system" />);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({
      body: { token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]", platform: "ios" },
      language: "en",
    });

    const device = { type: "ios", data: "a-new-device-token" } as const;
    notifications.getExpoPushTokenAsync.mockResolvedValueOnce({
      type: "expo",
      data: expoToken("new"),
    });
    await act(async () => phone.__newToken(device));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(notifications.getExpoPushTokenAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ devicePushToken: device }),
    );
    expect(seen[1]).toEqual({ body: { token: expoToken("new"), platform: "ios" }, language: "en" });

    await view.rerender(underProviders(<InLanguage language="fi" />));
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]?.language).toBe("fi");
    // The token listener follows the language too.
    notifications.getExpoPushTokenAsync.mockResolvedValueOnce({
      type: "expo",
      data: expoToken("newer"),
    });
    await act(async () => phone.__newToken(device));
    await waitFor(() => expect(seen).toHaveLength(4));
    expect(seen[3]).toEqual({
      body: { token: expoToken("newer"), platform: "ios" },
      language: "fi",
    });
  });

  it("sends the token once when iOS hands it over again after the fetch", async () => {
    const seen = api();
    await signIn();
    await renderWithTheme(<PushNotifications />);
    await waitFor(() => expect(seen).toHaveLength(1));
    await act(async () => phone.__newToken({ type: "ios", data: "the-same-device-token" }));
    await settle();
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(1);
  });

  it("registers as the app comes back to the front once the phone's settings allowed it meanwhile", async () => {
    const seen = api();
    notifications.getPermissionsAsync.mockResolvedValue(denied as never);
    await signIn();
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(seen).toEqual([]);

    // Away in the phone's settings: nothing is sent until the app is in front again.
    notifications.getPermissionsAsync.mockResolvedValue(allowed as never);
    await toApp("background");
    await settle();
    expect(seen).toEqual([]);
    await toApp("active");
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({
      body: { token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]", platform: "ios" },
      language: "en",
    });
  });

  it("sends nothing again as the app comes back to the front with nothing changed, and asks Expo nothing", async () => {
    const seen = api();
    await signIn();
    await renderWithTheme(<PushNotifications />);
    await waitFor(() => expect(seen).toHaveLength(1));
    const fetched = notifications.getExpoPushTokenAsync.mock.calls.length;
    await toApp("background");
    await toApp("active");
    await settle();
    expect(seen).toHaveLength(1);
    // A fetch would tell Expo of every return to the app.
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(fetched);
  });

  it("retries a start whose token Expo would not give, as the app comes back to the front", async () => {
    const seen = api();
    const error = new Error("offline");
    notifications.getExpoPushTokenAsync.mockRejectedValueOnce(error);
    await signIn();
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(seen).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    await toApp("active");
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("clears the phone's list of pushes on a sign-out, and not at the start or on a sign-in", async () => {
    api();
    await signIn();
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();
    await act(async () => {
      await clearSession();
    });
    expect(notifications.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      await signIn();
    });
    await settle();
    expect(notifications.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("clears nothing at a start signed out", async () => {
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();
  });

  it("reports a list that would not clear on a sign-out, and throws nothing", async () => {
    api();
    await signIn();
    const error = new Error("no list");
    notifications.dismissAllNotificationsAsync.mockRejectedValueOnce(error);
    await renderWithTheme(<PushNotifications />);
    await settle();
    await act(async () => {
      await clearSession();
    });
    await settle();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("registers nothing and listens for no token while signed out, and stops on a sign-out", async () => {
    const seen = api();
    await renderWithTheme(<PushNotifications />);
    await toApp("active");
    await settle();
    expect(seen).toEqual([]);
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();

    await act(async () => {
      await signIn();
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    const reads = notifications.getPermissionsAsync.mock.calls.length;
    await act(async () => {
      await clearSession();
    });
    await act(async () => phone.__newToken({ type: "ios", data: "after-sign-out" }));
    await toApp("active");
    await settle();
    expect(seen).toHaveLength(1);
    // Not even begun: the listeners went with the session.
    expect(notifications.getPermissionsAsync).toHaveBeenCalledTimes(reads);
  });
});

describe("a tap on a push", () => {
  beforeEach(async () => {
    api();
    await signIn();
  });

  it.each([
    ["a message", { kind: "message" }, "/chats"],
    ["a match", { kind: "match" }, "/chats"],
    ["the round", { kind: "round" }, "/round"],
  ])("on %s opens what it is about, once", async (_, data, path) => {
    await renderWithTheme(<PushNotifications />);
    await settle();
    await act(async () => phone.__respond(tap(data)));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(path));
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    // Signed out and in again, nothing opens a second time.
    await act(async () => {
      await clearSession();
    });
    await act(async () => {
      await signIn();
    });
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("at a cold start waits for the session, then opens the conversations", async () => {
    phone.__respond(tap({ kind: "message" }));
    await renderWithTheme(<PushNotifications />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/chats"));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no kind", {}],
    ["a kind the app does not know", { kind: "promotion" }],
    // No push names its conversation any more (the maintainer's of 25/10/2026).
    ["a conversation", { kind: "message", conversationId: CONVERSATION }],
    ["a word too many", { kind: "round", name: "Henna" }],
    ["no data at all", undefined],
  ])("opens nothing for a push with %s, and lets it go", async (_, data) => {
    await renderWithTheme(<PushNotifications />);
    await settle();
    await act(async () => phone.__respond(tap(data)));
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for an action that is not the tap itself", async () => {
    await renderWithTheme(<PushNotifications />);
    await settle();
    await act(async () => phone.__respond(tap({ kind: "round" }, "dismiss")));
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a tap while signed out, not even after a sign-in", async () => {
    await clearSession();
    phone.__respond(tap({ kind: "message" }));
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    await act(async () => {
      await signIn();
    });
    await settle();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("a tap on a push under the lock", () => {
  beforeEach(async () => {
    api();
    await signIn();
  });

  it("waits while the lock is shown, and opens once it is unlocked", async () => {
    await renderWithTheme(<WithLock />);
    await turnLockOn();
    // Tapped while away: the cover holds it, and the return locks.
    await toApp("background");
    await act(async () => phone.__respond(tap({ kind: "message" })));
    await toApp("active");
    await settle();
    expect(screen.getByLabelText(PASSCODE)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    await unlock();
    expect(router.push).toHaveBeenCalledWith("/chats");
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    // Locked and unlocked again, nothing opens a second time.
    await toApp("background");
    await toApp("active");
    await unlock();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("at a cold start waits for the lock, read and shown, and opens once it is unlocked", async () => {
    const view = await renderWithTheme(<WithLock />);
    await turnLockOn();
    // The app gone; the push tapped starts it again.
    await view.rerender(<View />);
    phone.__respond(tap({ kind: "round" }));
    await view.rerender(underProviders(<PushNotifications />));
    await settle();
    expect(screen.getByLabelText(PASSCODE)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();

    await unlock();
    expect(router.push).toHaveBeenCalledWith("/round");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("opens nothing when the lock is left through the bank, not even after a sign-in", async () => {
    await renderWithTheme(<WithLock />);
    await turnLockOn();
    await toApp("background");
    await toApp("active");
    await act(async () => phone.__respond(tap({ kind: "match" })));
    await settle();
    expect(router.push).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole("button", { name: BANK }));
    await settle();
    expect(screen.queryByLabelText(PASSCODE)).toBeNull();
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    await act(async () => {
      await signIn();
    });
    await settle();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("opens at once while the lock is on and open", async () => {
    await renderWithTheme(<WithLock />);
    await turnLockOn();
    await act(async () => phone.__respond(tap({ kind: "round" })));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/round"));
  });
});

describe("the web target", () => {
  it("has none of it", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    const seen = api();
    await signIn();
    phone.__respond(tap({ kind: "round" }));
    // Bare: on the web it reads nothing, not even the session.
    await render(<PushNotifications />);
    await settle();
    expect(screen.toJSON()).toBeNull();
    expect(notifications.setNotificationHandler).not.toHaveBeenCalled();
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    await clearSession();
    expect(notifications.dismissAllNotificationsAsync).not.toHaveBeenCalled();
  });
});
