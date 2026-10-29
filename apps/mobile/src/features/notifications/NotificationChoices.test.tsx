import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { NotificationChoices } from "./NotificationChoices";

// What a person may be notified of (#176, ADR-032): the four switches in the
// API's order with their lines, the phone's own permission above them (#102),
// a press saved at once and the switch waiting meanwhile, a failure said in
// words with the switch as it was, a load that failed with Try again, and
// every switch labelled.

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choices = (off: string[] = []) => ({
  choices: ["round", "message", "match", "moderation"].map((kind) => ({
    kind,
    enabled: !off.includes(kind),
  })),
});
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

type Sent = { method: string; path: string; body: unknown };
function api(answer: (sent: Sent) => Response | Promise<Response>): Sent[] {
  const seen: Sent[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    const sent = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : null,
    };
    seen.push(sent);
    return answer(sent);
  }) as unknown as typeof fetch;
  return seen;
}
const checked = (name: string) =>
  screen.getByRole("switch", { name }).props.accessibilityState?.checked === true;

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  await clearSession();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("NotificationChoices", () => {
  it("shows each kind with its line, as the API holds it, and saves a press at once", async () => {
    const seen = api((sent) =>
      sent.method === "GET" ? json(choices(["match"])) : json(choices(["match", "message"])),
    );
    await renderWithTheme(<NotificationChoices />);
    expect(await screen.findByRole("switch", { name: "Messages" })).toBeTruthy();
    // Above the switches, what the phone itself lets Kuutti do (#102; PhoneLine.test.tsx).
    expect(
      await screen.findByText("This phone has not been asked yet whether Kuutti may notify it."),
    ).toBeTruthy();
    for (const name of ["A new round", "Messages", "Moderators' decisions"]) {
      expect(checked(name)).toBe(true);
    }
    expect(checked("Matches")).toBe(false);
    expect(
      screen.getByText("That there is a new message, never what it says or who sent it."),
    ).toBeTruthy();
    noProblems();
    await act(async () =>
      fireEvent(screen.getByRole("switch", { name: "Messages" }), "onCheckedChange", false),
    );
    await settle();
    expect(seen.at(-1)).toEqual({
      method: "PUT",
      path: "/account/notifications/message",
      body: { enabled: false },
    });
    expect(checked("Messages")).toBe(false);
  });

  it("says a change that failed and keeps the switch as it was", async () => {
    api((sent) =>
      sent.method === "GET"
        ? json(choices())
        : json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    );
    await renderWithTheme(<NotificationChoices />);
    await screen.findByRole("switch", { name: "Matches" });
    await act(async () =>
      fireEvent(screen.getByRole("switch", { name: "Matches" }), "onCheckedChange", false),
    );
    await settle();
    expect(screen.getByText("The change was not saved. Try again.")).toBeTruthy();
    expect(checked("Matches")).toBe(true);
  });

  it("says a load that failed, and reads again on Try again", async () => {
    let first = true;
    api(() => {
      if (first) {
        first = false;
        return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
      }
      return json(choices());
    });
    await renderWithTheme(<NotificationChoices />);
    expect(await screen.findByText("Your choices could not be loaded.")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));
    expect(await screen.findByRole("switch", { name: "A new round" })).toBeTruthy();
  });
});
