import { act, screen, userEvent, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { PushOffer } from "./PushOffer";

// The home screen's one offer of notifications (#102, ADR-055 §9): shown
// only while the phone has not been asked and this phone has not answered
// the offer; Allow shows the phone's question and registers on a yes; No
// thanks asks nothing; either answer is kept and the offer never comes back.
// Where it shows, only once matching is open, is HomeScreen.test.tsx's.

const notifications = jest.mocked(Notifications);
const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const ASKED = "kuutti.preference.pushAsked";
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

beforeEach(async () => {
  jest.clearAllMocks();
  store.delete(ASKED);
  notifications.getPermissionsAsync.mockResolvedValue(NOT_ASKED as never);
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

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
});
