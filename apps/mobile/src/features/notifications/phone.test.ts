import * as Sentry from "@sentry/react-native";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { createElement } from "react";
import { Platform } from "react-native";
import { SessionProvider, useSession } from "@/features/identity";
import { clearSession, currentSession, saveSession } from "@/lib/session";
import {
  askPermission,
  permissionOf,
  readPermission,
  registerOnReturn,
  registerPush,
  unregisterPush,
} from "./phone";

// The phone's side of the push (#102, ADR-055 §2, §9): the permission in the
// app's words on each platform, on the web and when the phone cannot be read;
// the question, which makes Android's channel first and never asks for a
// badge; and the registration, which sends the token and the platform and
// nothing else, only while allowed, in the app's language, one at a time,
// once for the same session, token and language, never after a sign-out, a
// failure reported and never thrown; and the device token dropped after a
// logout the API never heard, in turn with the registrations.

// app.json's EAS project, which Expo's token is made for.
const PROJECT = "aaea145c-d019-4411-988a-52772edf1fa8";
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: { extra: { eas: { projectId: "aaea145c-d019-4411-988a-52772edf1fa8" } } },
  },
}));

const notifications = jest.mocked(Notifications);
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

type Status = Notifications.NotificationPermissionsStatus;
const ios = (status: number): Status =>
  ({
    status: "undetermined",
    granted: false,
    canAskAgain: true,
    expires: "never",
    ios: { status },
  }) as Status;
const android = (status: string, canAskAgain = true): Status =>
  ({ status, granted: status === "granted", canAskAgain, expires: "never" }) as Status;

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
type Sent = { method: string; path: string; body: unknown; language: string | null };
function api(status = 204): Sent[] {
  const seen: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request) => {
    const text = await input.text();
    seen.push({
      method: input.method,
      path: new URL(input.url).pathname,
      body: text ? JSON.parse(text) : null,
      language: input.headers.get("accept-language"),
    });
    return status === 204
      ? new Response(null, { status })
      : new Response(
          JSON.stringify({ error: { code: "internal_error", message: "x", requestId: "r" } }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        );
  }) as unknown as typeof fetch;
  return seen;
}

/**
 * A sign-in of its own, with a session id of its own: the app remembers the
 * last registration it sent per session, so each test starts from one it has
 * sent nothing for.
 */
let sessions = 0;
const signIn = () => {
  sessions += 1;
  return saveSession({
    sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(sessions).padStart(12, "0")}`,
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
};

/** Every promise already on its way runs to where it waits on something the test holds. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, "OS", "ios");
  notifications.getPermissionsAsync.mockResolvedValue(ios(0));
  await signIn();
});
afterEach(() => jest.restoreAllMocks());

describe("the phone's permission", () => {
  it.each([
    [Notifications.IosAuthorizationStatus.AUTHORIZED, "allowed"],
    [Notifications.IosAuthorizationStatus.PROVISIONAL, "allowed"],
    [Notifications.IosAuthorizationStatus.EPHEMERAL, "allowed"],
    [Notifications.IosAuthorizationStatus.DENIED, "denied"],
    [Notifications.IosAuthorizationStatus.NOT_DETERMINED, "undetermined"],
  ])("on iOS reads its own status %s as %s, whatever the root says", (status, expected) => {
    expect(permissionOf({ ...ios(status), granted: true, status: "granted" } as Status)).toBe(
      expected,
    );
  });

  it("on iOS reads an answer without its own part as one that cannot be told", () => {
    expect(permissionOf(android("granted"))).toBe("unavailable");
  });

  // What expo-notifications answers on Android: from Android 13 the root
  // status says denied until the phone has said yes, so a phone never asked
  // reads as denied, and only canAskAgain says that it can still be asked.
  it.each([
    ["allows them", "allowed", android("granted")],
    ["was never asked (its root status says denied)", "undetermined", android("denied")],
    [
      "refused them for good, or has them off before Android 13",
      "denied",
      android("denied", false),
    ],
  ])("on Android reads a phone that %s as %s", (_, expected, answer) => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(permissionOf(answer)).toBe(expected);
  });

  it("reads the phone as it stands, asking nothing", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    expect(await readPermission()).toBe("allowed");
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("is unavailable on the web target without asking the module", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    expect(await readPermission()).toBe("unavailable");
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it("is unavailable when the phone cannot be read, and reports the error alone", async () => {
    const error = new Error("no module");
    notifications.getPermissionsAsync.mockRejectedValue(error);
    expect(await readPermission()).toBe("unavailable");
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});

describe("the phone's question", () => {
  it("on Android makes the default channel, in the app's words and with no badge, before it asks", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const order: string[] = [];
    notifications.setNotificationChannelAsync.mockImplementation(async () => {
      order.push("channel");
      return null;
    });
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      order.push("question");
      return android("granted");
    });
    expect(await askPermission("Ilmoitukset")).toBe("allowed");
    expect(order).toEqual(["channel", "question"]);
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith("default", {
      name: "Ilmoitukset",
      importance: Notifications.AndroidImportance.DEFAULT,
      showBadge: false,
    });
  });

  it("asks for the banner and the sound, never the badge, and on iOS makes no channel", async () => {
    notifications.requestPermissionsAsync.mockResolvedValue(ios(1));
    expect(await askPermission("Notifications")).toBe("denied");
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledWith({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it("asks nothing on the web target", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    expect(await askPermission("Notifications")).toBe("unavailable");
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("reports a question that failed and leaves the phone unable to be told", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const error = new Error("no channel");
    notifications.setNotificationChannelAsync.mockRejectedValueOnce(error);
    expect(await askPermission("Notifications")).toBe("unavailable");
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("the registration", () => {
  it("sends the token and the platform and nothing else, in the app's language, while allowed", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    await registerPush({ locale: "fi", channel: "Ilmoitukset" });
    expect(seen).toEqual([
      {
        method: "PUT",
        path: "/push-token",
        body: { token: TOKEN, platform: "ios" },
        language: "fi",
      },
    ]);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: PROJECT,
      devicePushToken: undefined,
    });
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it("on Android makes or renames the channel first, and names the platform", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    notifications.getPermissionsAsync.mockResolvedValue(android("granted"));
    const seen = api();
    await registerPush({ locale: "sv", channel: "Aviseringar" });
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ name: "Aviseringar" }),
    );
    expect(seen.map(({ body, language }) => [body, language])).toEqual([
      [{ token: TOKEN, platform: "android" }, "sv"],
    ]);
  });

  it("makes Expo's token from the device token the phone just handed over", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    api();
    const device = { type: "ios", data: "abc123" } as const;
    await registerPush({ locale: "en", channel: "Notifications", device });
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: PROJECT,
      devicePushToken: device,
    });
  });

  it.each([
    ["not asked yet", 0],
    ["refused", 1],
  ])("sends nothing while the phone is %s", async (_, status) => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(status));
    const seen = api();
    await registerPush({ locale: "en", channel: "Notifications" });
    expect(seen).toEqual([]);
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("sends nothing on the web target", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    const seen = api();
    await registerPush({ locale: "en", channel: "Notifications" });
    expect(seen).toEqual([]);
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it("reports a refusal of the API's and a token Expo would not give, and throws neither", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    api(500);
    await expect(registerPush({ locale: "en", channel: "Notifications" })).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 500, code: "internal_error" }),
    );
    const error = new Error("offline");
    notifications.getExpoPushTokenAsync.mockRejectedValueOnce(error);
    await expect(registerPush({ locale: "en", channel: "Notifications" })).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenLastCalledWith(error);
  });

  it("registers one at a time, in the order asked, so the last language is the one kept", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    let release: () => void = () => undefined;
    notifications.getExpoPushTokenAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ type: "expo", data: TOKEN });
        }),
    );
    const first = registerPush({ locale: "en", channel: "Notifications" });
    const second = registerPush({ locale: "fi", channel: "Ilmoitukset" });
    await flush();
    // The second waits for the first, which waits for Expo.
    expect(seen).toEqual([]);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(seen.map(({ language }) => language)).toEqual(["en", "fi"]);
  });

  it("sends a registration identical to the last one once, as iOS hands the token over again after it is fetched", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    await registerPush({ locale: "en", channel: "Notifications" });
    // The token listener, called with the device token the fetch handed over.
    await registerPush({
      locale: "en",
      channel: "Notifications",
      device: { type: "ios", data: "a" },
    });
    expect(seen).toHaveLength(1);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(2);
  });

  it("still sends a changed language, a new token and a new sign-in's same token", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    const NEW = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
    await registerPush({ locale: "en", channel: "Notifications" });
    await registerPush({ locale: "fi", channel: "Ilmoitukset" });
    notifications.getExpoPushTokenAsync.mockResolvedValueOnce({ type: "expo", data: NEW });
    await registerPush({ locale: "fi", channel: "Ilmoitukset" });
    // Back to the first token, in the same language: changed again since the last one sent.
    await registerPush({ locale: "fi", channel: "Ilmoitukset" });
    await signIn();
    await registerPush({ locale: "fi", channel: "Ilmoitukset" });
    expect(seen.map(({ body, language }) => [(body as { token: string }).token, language])).toEqual(
      [
        [TOKEN, "en"],
        [TOKEN, "fi"],
        [NEW, "fi"],
        [TOKEN, "fi"],
        [TOKEN, "fi"],
      ],
    );
  });

  it("sends again a registration the API refused, since it took nothing", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    api(500);
    await registerPush({ locale: "en", channel: "Notifications" });
    const seen = api();
    await registerPush({ locale: "en", channel: "Notifications" });
    expect(seen).toHaveLength(1);
  });

  it("sends nothing after a sign-out, and the registration whose turn comes after it fetches no token", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    let release: () => void = () => undefined;
    notifications.getExpoPushTokenAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ type: "expo", data: TOKEN });
        }),
    );
    const first = registerPush({ locale: "en", channel: "Notifications" });
    const queued = registerPush({
      locale: "en",
      channel: "Notifications",
      device: { type: "ios", data: "a" },
    });
    await flush();
    await clearSession();
    release();
    await Promise.all([first, queued]);
    // Expo was making the first one's token at the sign-out; the queued one never asked it.
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("the device token dropped (#102)", () => {
  it("has the phone drop its device token", async () => {
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(notifications.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it("drops nothing on the web target", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await unregisterPush();
    expect(notifications.unregisterForNotificationsAsync).not.toHaveBeenCalled();
  });

  it("reports a phone that would not drop it, the error alone, and throws nothing", async () => {
    const error = new Error("no Play services");
    notifications.unregisterForNotificationsAsync.mockRejectedValueOnce(error);
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("waits for a registration on its way, which cannot register the device again after it", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    let release: () => void = () => undefined;
    notifications.getExpoPushTokenAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ type: "expo", data: TOKEN });
        }),
    );
    const registration = registerPush({ locale: "en", channel: "Notifications" });
    await flush();
    await clearSession();
    const dropped = unregisterPush();
    await flush();
    // Expo is still making the token, and with it registering the device.
    expect(notifications.unregisterForNotificationsAsync).not.toHaveBeenCalled();
    release();
    await Promise.all([registration, dropped]);
    expect(notifications.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("is what a logout the API never heard calls, and the sign-out completes when the phone would not drop it", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    const error = new Error("no Play services");
    notifications.unregisterForNotificationsAsync.mockRejectedValueOnce(error);
    // As the root layout gives it.
    const { result } = await renderHook(() => useSession(), {
      wrapper: ({ children }) =>
        createElement(SessionProvider, { onLogoutUnheard: unregisterPush, children }),
    });
    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    await act(async () => result.current.signOut());
    expect(result.current.status).toBe("signed-out");
    expect(currentSession()).toBeNull();
    await waitFor(() => expect(Sentry.captureException).toHaveBeenCalledWith(error));
    expect(notifications.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
  });
});

describe("a registration on the return to the front (ADR-055 §9)", () => {
  const fetches = () => notifications.getExpoPushTokenAsync.mock.calls.length;

  it("asks Expo nothing while this session's registration stands in its language", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    await registerPush({ locale: "en", channel: "Notifications" });
    const before = fetches();
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    expect(fetches()).toBe(before);
    expect(seen).toHaveLength(1);
  });

  it("registers when this session has none yet, and when the language is another", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    // The phone was allowed meanwhile in its own settings: nothing registered for this session yet.
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    await registerOnReturn({ locale: "fi", channel: "Ilmoitukset" });
    expect(seen.map(({ language }) => language)).toEqual(["en", "fi"]);
    // A new sign-in on the phone owes its own.
    await signIn();
    await registerOnReturn({ locale: "fi", channel: "Ilmoitukset" });
    expect(seen).toHaveLength(3);
  });

  it("registers after a try that failed, and asks nothing once one has gone", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(ios(2));
    const seen = api();
    // Registered for this session, then a try in the same language that failed for want of network.
    await registerPush({ locale: "en", channel: "Notifications" });
    notifications.getExpoPushTokenAsync.mockRejectedValueOnce(new Error("offline"));
    await registerPush({ locale: "en", channel: "Notifications" });
    const before = fetches();
    // Only the failure is owed: the return tries again, finds the same token, and sends nothing new.
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    expect(fetches()).toBe(before + 1);
    expect(seen).toHaveLength(1);
    // Gone through now: the next return asks nothing.
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    expect(fetches()).toBe(before + 1);
  });

  it("reads the phone, and asks Expo nothing, while the phone does not allow it", async () => {
    const seen = api();
    notifications.getPermissionsAsync.mockResolvedValue(ios(1));
    await registerOnReturn({ locale: "en", channel: "Notifications" });
    expect(fetches()).toBe(0);
    expect(seen).toEqual([]);
  });
});
