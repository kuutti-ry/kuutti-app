import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, Platform } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Notices } from "./Notices";

// The home screen's notices (#176, ADR-032): the unread ones under a heading,
// a warning with its reason in words, an invitation that counted with what it
// earned and never who (#107), Got it marking it read and taking it off, a
// failure said and the notice kept, nothing at all without one.

const { __focus: focus } = jest.requireMock("expo-router") as { __focus: () => void };
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const notice = (n: number, readAt: string | null = null) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  kind: "warning",
  at: "2026-10-18T09:00:00.000Z",
  readAt,
  reason: "harassment",
});
const BODY = "Reason: Harassment. A warning by itself changes nothing in how you use the app.";
const counted = (n: number, reward: { fish: number; likes: number }) => ({
  id: `00000000-0000-4000-8000-00000000001${n}`,
  kind: "invitation_counted",
  at: "2026-10-22T03:00:00.000Z",
  readAt: null,
  reward,
});

function api(notices: unknown[], read: () => Response = () => new Response(null, { status: 204 })) {
  const seen: string[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    seen.push(`${request.method} ${path}`);
    return request.method === "POST" ? read() : json({ notices });
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("Notices", () => {
  it("shows an unread warning with its reason, and Got it marks it read and takes it off", async () => {
    const seen = api([notice(1), notice(2, "2026-10-18T10:00:00.000Z")]);
    await renderWithTheme(<Notices />);
    expect(await screen.findByRole("heading", { name: "Notices" })).toBeTruthy();
    expect(screen.getAllByText("A warning from a moderator")).toHaveLength(1);
    expect(screen.getByText(BODY)).toBeTruthy();
    noProblems();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Got it" })));
    await settle();
    expect(seen).toContain(`POST /notices/${notice(1).id}/read`);
    expect(screen.queryByText("A warning from a moderator")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Notices" })).toBeNull();
  });

  it("shows an invitation that counted with what it earned, never who, beside a warning", async () => {
    const seen = api([counted(1, { fish: 1, likes: 0 }), notice(1)]);
    await renderWithTheme(<Notices />);
    expect(await screen.findByText("An invitation of yours counted")).toBeTruthy();
    expect(
      screen.getByText("Somebody you invited has finished their profile. You earned a fish."),
    ).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    // The invitation's notice first, as the API ordered them.
    const flat = JSON.stringify(screen.toJSON());
    expect(flat.indexOf("An invitation of yours counted")).toBeLessThan(
      flat.indexOf("A warning from a moderator"),
    );
    noProblems();
    const first = screen.getAllByRole("button", { name: "Got it" })[0];
    await act(async () => fireEvent.press(first as ReturnType<typeof screen.getByRole>));
    await settle();
    expect(seen).toContain(`POST /notices/${counted(1, { fish: 1, likes: 0 }).id}/read`);
    expect(screen.queryByText("An invitation of yours counted")).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
  });

  it.each([
    [{ fish: 0, likes: 3 }, "You earned 3 extra likes."],
    [{ fish: 2, likes: 1 }, "You earned 2 fish and an extra like."],
    [{ fish: 0, likes: 0 }, "Thank you for inviting them."],
  ])("says what a counted invitation earned, %j", async (reward, words) => {
    api([counted(2, reward)]);
    await renderWithTheme(<Notices />);
    expect(
      await screen.findByText(`Somebody you invited has finished their profile. ${words}`),
    ).toBeTruthy();
  });

  it("keeps a notice whose mark failed, says so, and tells VoiceOver", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    api([notice(1)], () =>
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    );
    await renderWithTheme(<Notices />);
    await screen.findByText(BODY);
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Got it" })));
    await settle();
    const words = "The notice could not be marked as read. Try again.";
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(words);
  });

  it("shows nothing when there is nothing unread, or the notices cannot be read, and reads again on focus", async () => {
    api([notice(1, "2026-10-18T10:00:00.000Z")]);
    await renderWithTheme(<Notices />);
    await settle();
    const nothing = () => {
      expect(screen.queryByRole("heading", { name: "Notices" })).toBeNull();
      expect(screen.queryByText("A warning from a moderator")).toBeNull();
    };
    nothing();
    globalThis.fetch = jest.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await act(async () => focus());
    await settle();
    nothing();
    api([notice(3)]);
    await act(async () => focus());
    expect(await screen.findByText(BODY)).toBeTruthy();
  });
});
