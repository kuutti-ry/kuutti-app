import { act, render, screen, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";
import { type LocalePreference, useLocaleSettings } from "@/lib/locale";
import { clearSession, saveSession } from "@/lib/session";
import { renderWithTheme, underProviders } from "@/test/render";
import { PushNotifications } from "./PushNotifications";

// The push on this phone (#102, ADR-055 §2, §9): the foreground handler; the
// token registered at the start while signed in, on a new token and on a
// change of the app's language, and never while signed out; a tap opening
// its conversation or today's round once, and nothing for a tap the app
// cannot read, an action that is not the tap, or a tap while signed out;
// and none of it on the web target.

const notifications = jest.mocked(Notifications);
const phone = jest.requireMock("expo-notifications") as {
  __respond: (response: unknown) => void;
  __newToken: (token: Notifications.DevicePushToken) => void;
};
const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock };
};

const CONVERSATION = "0b4f3a0e-7c2f-4e2b-9a9a-1a2b3c4d5e6f";
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const signIn = () =>
  saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
const allowed = {
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
  ios: { status: 2 },
};
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

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
  phone.__respond(null);
  notifications.getPermissionsAsync.mockResolvedValue(allowed as never);
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
    await act(async () => phone.__newToken(device));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(notifications.getExpoPushTokenAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ devicePushToken: device }),
    );

    await view.rerender(underProviders(<InLanguage language="fi" />));
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]?.language).toBe("fi");
    // The token listener follows the language too.
    await act(async () => phone.__newToken(device));
    await waitFor(() => expect(seen).toHaveLength(4));
    expect(seen[3]?.language).toBe("fi");
  });

  it("registers nothing and listens for no token while signed out, and stops on a sign-out", async () => {
    const seen = api();
    await renderWithTheme(<PushNotifications />);
    await settle();
    expect(seen).toEqual([]);
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();

    await act(async () => {
      await signIn();
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    await act(async () => {
      await clearSession();
    });
    await act(async () => phone.__newToken({ type: "ios", data: "after-sign-out" }));
    await settle();
    expect(seen).toHaveLength(1);
  });
});

describe("a tap on a push", () => {
  beforeEach(async () => {
    api();
    await signIn();
  });

  it.each([
    ["a message", { kind: "message", conversationId: CONVERSATION }, `/chats/${CONVERSATION}`],
    ["a match", { kind: "match", conversationId: CONVERSATION }, `/chats/${CONVERSATION}`],
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

  it("at a cold start waits for the session, then opens the conversation", async () => {
    phone.__respond(tap({ kind: "message", conversationId: CONVERSATION }));
    await renderWithTheme(<PushNotifications />);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/chats/${CONVERSATION}`));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no kind", { conversationId: CONVERSATION }],
    ["a kind the app does not know", { kind: "promotion" }],
    ["a message without its conversation", { kind: "message" }],
    ["a conversation that is no id", { kind: "match", conversationId: "../settings" }],
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
    phone.__respond(tap({ kind: "message", conversationId: CONVERSATION }));
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
    expect(notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
