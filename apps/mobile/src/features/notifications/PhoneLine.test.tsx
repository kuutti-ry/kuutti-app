import * as Sentry from "@sentry/react-native";
import { act, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { AppState, Linking, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { PhoneLine } from "./PhoneLine";

// Whether this phone lets Kuutti notify it, on Settings › Notifications
// (#102, ADR-055 §9): each state in words, the way to the phone's settings
// under a refusal, the phone's own question for a phone never asked, read
// again as the app comes back to the front, and the token registered
// whenever the permission becomes allowed here.

const notifications = jest.mocked(Notifications);
const status = (ios: number, root: string) => ({
  status: root,
  granted: root === "granted",
  canAskAgain: true,
  expires: "never",
  ios: { status: ios },
});
const NOT_ASKED = status(0, "undetermined");
const ALLOWED = status(2, "granted");
const DENIED = status(1, "denied");
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

let appState: Array<(state: string) => void>;
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

beforeEach(async () => {
  jest.clearAllMocks();
  appState = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appState.push(listener as (state: string) => void);
    return { remove: jest.fn() } as never;
  });
  phoneSays(NOT_ASKED);
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
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

  it("reads the phone again back in front, and registers once it allows them", async () => {
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
    await waitFor(() => expect(seen).toHaveLength(1));

    // Allowed still: nothing registered twice.
    await toApp("active");
    await settle();
    expect(seen).toHaveLength(1);
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
});
