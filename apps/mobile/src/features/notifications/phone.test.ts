import * as Sentry from "@sentry/react-native";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { askPermission, permissionOf, readPermission, registerPush } from "./phone";

// The phone's side of the push (#102, ADR-055 §2, §9): the permission in the
// app's words on each platform, on the web and when the phone cannot be read;
// the question, which makes Android's channel first and never asks for a
// badge; and the registration, which sends the token and the platform and
// nothing else, only while allowed, in the app's language, one at a time, a
// failure reported and never thrown.

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
const android = (status: string, granted = status === "granted"): Status =>
  ({ status, granted, canAskAgain: true, expires: "never" }) as Status;

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

beforeEach(async () => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, "OS", "ios");
  notifications.getPermissionsAsync.mockResolvedValue(ios(0));
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
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

  it.each([
    ["granted", true, "allowed"],
    ["undetermined", false, "undetermined"],
    ["denied", false, "denied"],
  ])("on Android reads the root status %s as %s", (status, granted, expected) => {
    jest.replaceProperty(Platform, "OS", "android");
    expect(permissionOf(android(status, granted))).toBe(expected);
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second waits for the first, which waits for Expo.
    expect(seen).toEqual([]);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(seen.map(({ language }) => language)).toEqual(["en", "fi"]);
  });
});
