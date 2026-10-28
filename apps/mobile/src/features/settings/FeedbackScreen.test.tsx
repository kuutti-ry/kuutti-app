import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { FeedbackScreen } from "./FeedbackScreen";

// Give feedback (#171, ADR-023): the kind in words, the words themselves, the
// build read by the app; thanks after a send; the cap and a failure in their
// own words; nothing for a device without a session.

jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));
jest.mock("@/lib/build", () => ({ buildInfo: () => ({ version: "0.22.0", commit: "abc1234" }) }));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

type Sent = { method: string; path: string; body: unknown };
/** The API as the screen sees it: every feedback request recorded, answered as told. */
function api(answer: () => Response) {
  const sent: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/feedback") {
      const text = await request.text();
      sent.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
      return answer();
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
  return sent;
}
const press = (name: string, role: "button" | "radio" = "button") =>
  act(async () => {
    fireEvent.press(screen.getByRole(role, { name }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
const type = (words: string) =>
  act(async () => {
    fireEvent.changeText(screen.getByLabelText("Your feedback"), words);
  });
const sendButton = () => screen.getByRole("button", { name: /^Send/ });

beforeEach(async () => {
  store.clear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await clearSession();
});

describe("the feedback screen", () => {
  it("sends the kind, the words and the build, says thank you, and offers the empty form again", async () => {
    const sent = api(() => new Response(null, { status: 204 }));
    await saveSession(tokens);
    await renderWithTheme(<FeedbackScreen />);
    // The session loads first; the form follows.
    await screen.findByLabelText("Your feedback");
    expectPinnedHeader("Give feedback", "Back");
    expect(screen.getByRole("heading", { name: "What is it about?" })).toBeTruthy();
    noProblems();
    await press("An idea", "radio");
    expect(screen.getByRole("radio", { name: "✓ An idea" })).toBeTruthy();
    await type("  The map is slow on my phone.  ");
    await press("Send");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Thank you" })).toBeTruthy());
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/feedback",
        body: {
          kind: "idea",
          text: "The map is slow on my phone.",
          appVersion: "0.22.0",
          platform: "ios",
          locale: "en",
        },
      },
    ]);
    expect(screen.getByText("The moderators will read it. Nobody is mailed.")).toBeTruthy();
    noProblems();
    await press("Send more");
    expect(screen.getByLabelText("Your feedback").props.value).toBe("");
    expect(screen.queryByRole("radio", { name: /✓/ })).toBeNull();
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
  });

  it("keeps Send off until a kind is chosen and something is written", async () => {
    const sent = api(() => new Response(null, { status: 204 }));
    await saveSession(tokens);
    await renderWithTheme(<FeedbackScreen />);
    // The session loads first; the form follows.
    await screen.findByLabelText("Your feedback");
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    await press("A bug", "radio");
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    await type("   ");
    expect(sendButton().props.accessibilityState?.disabled).toBe(true);
    await type("The photos screen shows yesterday's tip.");
    expect(sendButton().props.accessibilityState?.disabled).toBe(false);
    await press("Send");
    await settle();
    expect(sent.map((s) => (s.body as { kind: string }).kind)).toEqual(["bug"]);
  });

  it("says when the day's feedback is sent, and when sending failed, keeping the words", async () => {
    let status = 429;
    api(() =>
      json(
        { error: { code: status === 429 ? "feedback_budget_exceeded" : "internal_error" } },
        status,
      ),
    );
    await saveSession(tokens);
    await renderWithTheme(<FeedbackScreen />);
    // The session loads first; the form follows.
    await screen.findByLabelText("Your feedback");
    await press("Praise", "radio");
    await type("The onboarding was quick.");
    await press("Send");
    await waitFor(() =>
      expect(
        screen.getByText("That is enough feedback for today. You can send more after midnight."),
      ).toBeTruthy(),
    );
    expect(screen.getByLabelText("Your feedback").props.value).toBe("The onboarding was quick.");
    status = 500;
    await press("Send");
    await waitFor(() => expect(screen.getByText("Sending did not work. Try again.")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Thank you" })).toBeNull();
  });

  it("says there is no session on a signed-out device", async () => {
    api(() => new Response(null, { status: 204 }));
    await renderWithTheme(<FeedbackScreen />);
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByLabelText("Your feedback")).toBeNull();
  });
});
