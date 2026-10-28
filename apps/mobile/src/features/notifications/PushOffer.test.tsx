import { act, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { Platform, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { PushOffer } from "./PushOffer";

// The home screen's one offer of notifications (#102, ADR-055 §9): shown
// only while the phone has not been asked and this phone has not answered
// the offer; Allow shows the phone's question and registers on a yes; No
// thanks asks nothing; both wait while the question is open, so it is asked
// once; either answer is kept and the offer never comes back; nothing
// offered for a read that answers after the home screen has gone.
// Where it shows, only once matching is open, is HomeScreen.test.tsx's.

const notifications = jest.mocked(Notifications);
const secure = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
  getItemAsync: (key: string) => Promise<string | null>;
};
const store = secure.__store;
const ASKED = "kuutti.preference.pushAsked";
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

/** The phone's question answered: from then on the phone says so when read. */
const phoneAnswers = (answer: ReturnType<typeof status>) =>
  notifications.requestPermissionsAsync.mockImplementationOnce(async () => {
    notifications.getPermissionsAsync.mockResolvedValue(answer as never);
    return answer as never;
  });

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const HEADING = "Shall Kuutti tell you?";

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
  store.delete(ASKED);
  notifications.getPermissionsAsync.mockResolvedValue(NOT_ASKED as never);
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

describe("PushOffer", () => {
  it("offers once, with the reason in words and two answers of equal weight", async () => {
    await renderWithTheme(<PushOffer />);
    expect(await screen.findByRole("header", { name: HEADING })).toBeTruthy();
    expect(screen.getByText(/never what or from whom/)).toBeTruthy();
    const allow = screen.getByRole("button", { name: "Allow notifications" });
    const decline = screen.getByRole("button", { name: "No thanks" });
    expect(allow.props.className).toBe(decline.props.className);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    // Showing it asks the phone nothing.
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("on Allow shows the phone's question, registers on its yes, and never offers again", async () => {
    const seen = api();
    phoneAnswers(ALLOWED);
    await renderWithTheme(<PushOffer />);
    await userEvent
      .setup()
      .press(await screen.findByRole("button", { name: "Allow notifications" }));
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(store.get(ASKED)).toBe("true");

    // Even were the phone asked again some day, this phone answered the offer.
    notifications.getPermissionsAsync.mockResolvedValue(NOT_ASKED as never);
    await renderWithTheme(<PushOffer />);
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("on Allow and the phone's no, registers nothing and goes", async () => {
    const seen = api();
    phoneAnswers(DENIED);
    await renderWithTheme(<PushOffer />);
    await userEvent
      .setup()
      .press(await screen.findByRole("button", { name: "Allow notifications" }));
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(seen).toEqual([]);
    expect(store.get(ASKED)).toBe("true");
  });

  it("on No thanks asks the phone nothing, goes, and stays gone", async () => {
    await renderWithTheme(<PushOffer />);
    await userEvent.setup().press(await screen.findByRole("button", { name: "No thanks" }));
    await settle();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(store.get(ASKED)).toBe("true");
    await renderWithTheme(<PushOffer />);
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("is not there once this phone has answered it", async () => {
    store.set(ASKED, "true");
    await renderWithTheme(<PushOffer />);
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "allows them already",
      () => notifications.getPermissionsAsync.mockResolvedValue(ALLOWED as never),
    ],
    [
      "refused them already",
      () => notifications.getPermissionsAsync.mockResolvedValue(DENIED as never),
    ],
    ["cannot be read", () => notifications.getPermissionsAsync.mockRejectedValue(new Error("x"))],
  ])("is not there while the phone %s", async (_, phone) => {
    phone();
    await renderWithTheme(<PushOffer />);
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("offers on Android to a phone never asked, which the phone answers as denied", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    notifications.getPermissionsAsync.mockResolvedValue(ANDROID_NOT_ASKED as never);
    await renderWithTheme(<PushOffer />);
    expect(await screen.findByText(HEADING)).toBeTruthy();
  });

  it("waits, both answers dimmed, while the phone's question is open, and asks it once", async () => {
    const seen = api();
    let answer: () => void = () => undefined;
    notifications.requestPermissionsAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => {
            notifications.getPermissionsAsync.mockResolvedValue(ALLOWED as never);
            resolve(ALLOWED as never);
          };
        }),
    );
    await renderWithTheme(<PushOffer />);
    const user = userEvent.setup();
    await user.press(await screen.findByRole("button", { name: "Allow notifications" }));
    await waitFor(() => expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    const allow = screen.getByRole("button", { name: "Allow notifications" });
    const decline = screen.getByRole("button", { name: "No thanks" });
    expect(allow.props.accessibilityState?.disabled).toBe(true);
    expect(decline.props.accessibilityState?.disabled).toBe(true);
    await user.press(allow);
    await user.press(decline);
    await settle();
    // Still waiting for the phone: asked once, the offer still there.
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByText(HEADING)).toBeTruthy();
    await act(async () => answer());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("offers nothing for a read that answers after the home screen has gone", async () => {
    let read: (stored: string | null) => void = () => undefined;
    const real = secure.getItemAsync;
    jest
      .spyOn(secure, "getItemAsync")
      .mockImplementation((key) =>
        key === ASKED ? new Promise((resolve) => (read = resolve)) : real(key),
      );
    const view = await renderWithTheme(<PushOffer />);
    expect(secure.getItemAsync).toHaveBeenCalledWith(ASKED);
    await view.rerender(underProviders(<View />));
    // Never answered: the offer, were the screen still there.
    await act(async () => read(null));
    await settle();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });
});
