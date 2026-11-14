import * as Sentry from "@sentry/react-native";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { attack } from "@/test/attack";
import { deferred } from "@/test/deferred";
import { registerOnReturn, registerPush } from "./phone";

// ADR-055: permission precedes token registration; an asynchronous token
// belongs to the session that asked, and an unchanged return tells Expo nothing.
const notifications = jest.mocked(Notifications);
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const allowed = {
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
  ios: { status: 2 },
} as Notifications.NotificationPermissionsStatus;
const denied = {
  ...allowed,
  granted: false,
  ios: { ...allowed.ios, status: 1 },
} as Notifications.NotificationPermissionsStatus;
const registration = { locale: "en", channel: "Kuutti" };
let sessions = 0;
const signIn = () => {
  sessions += 1;
  return saveSession({
    sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(sessions).padStart(12, "0")}`,
    accessToken: "a".repeat(43),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${"b".repeat(43)}.${"c".repeat(43)}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
};
let sent: unknown[];
beforeEach(async () => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, "OS", "ios");
  jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-13T12:00:00.000Z"));
  notifications.getPermissionsAsync.mockResolvedValue(allowed);
  notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: TOKEN });
  sent = [];
  globalThis.fetch = jest.fn(async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/push-token");
    sent.push(await request.json());
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await signIn();
});
afterEach(() => {
  expect(Sentry.captureException).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

async function permission(granted: boolean) {
  notifications.getPermissionsAsync.mockResolvedValue(granted ? allowed : denied);
  await registerPush(registration);
  return sent.length;
}
attack("mobile push: a denied notification permission still registers this phone's token", {
  attempt: () => permission(false),
  control: () => permission(true),
  succeeds: (calls) => expect(calls).toBeGreaterThan(0),
});

async function permissionAfterSignOut(signOut: boolean) {
  const entered = deferred<void>();
  const permission = deferred<Notifications.NotificationPermissionsStatus>();
  notifications.getPermissionsAsync.mockImplementationOnce(() => {
    entered.resolve();
    return permission.promise;
  });
  const registering = registerPush(registration);
  await entered.promise;
  if (signOut) await clearSession();
  permission.resolve(allowed);
  await registering;
  return notifications.getExpoPushTokenAsync.mock.calls.length;
}
attack("mobile push: permission answered after sign-out still asks Expo for a token", {
  attempt: () => permissionAfterSignOut(true),
  control: () => permissionAfterSignOut(false),
  succeeds: (calls) => expect(calls).toBeGreaterThan(0),
});

async function tokenAfterTransition(transition: "none" | "sign-out" | "replacement") {
  const entered = deferred<void>();
  const token = deferred<Notifications.ExpoPushToken>();
  notifications.getExpoPushTokenAsync.mockImplementationOnce(() => {
    entered.resolve();
    return token.promise;
  });
  const registering = registerPush(registration);
  await entered.promise;
  if (transition === "sign-out") await clearSession();
  else if (transition === "replacement") await signIn();
  token.resolve({ type: "expo", data: TOKEN });
  await registering;
  return sent.length;
}
for (const transition of ["sign-out", "replacement"] as const) {
  attack(
    `mobile push: a token answered after session ${transition} is registered for whoever is now signed in`,
    {
      attempt: () => tokenAfterTransition(transition),
      control: () => tokenAfterTransition("none"),
      succeeds: (calls) => expect(calls).toBeGreaterThan(0),
    },
  );
}

async function registeredAgain(changeLanguage: boolean) {
  await registerPush(registration);
  expect(sent).toHaveLength(1);
  await registerPush({ ...registration, locale: changeLanguage ? "fi" : "en" });
  return sent.length;
}
attack("mobile push: the same session, token and language register more than once", {
  attempt: () => registeredAgain(false),
  control: () => registeredAgain(true),
  succeeds: (calls) => expect(calls).toBeGreaterThan(1),
});

async function returned(changeLanguage: boolean) {
  await registerPush(registration);
  expect(sent).toHaveLength(1);
  await registerOnReturn({ ...registration, locale: changeLanguage ? "fi" : "en" });
  return notifications.getExpoPushTokenAsync.mock.calls.length;
}
attack("mobile push: returning with nothing changed tells Expo about the person's visit again", {
  attempt: () => returned(false),
  control: () => returned(true),
  succeeds: (calls) => expect(calls).toBeGreaterThan(1),
});
