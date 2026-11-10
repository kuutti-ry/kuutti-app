import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as Notifications from "expo-notifications";
import { clearSession, saveSession } from "@/lib/session";
import { noProblems } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { renderWithTheme } from "@/test/render";
import { NotificationChoices } from "./NotificationChoices";

// What a person may be notified of (#176, ADR-032): what this phone's answer
// leaves to do first (#102), then what a notification says, then the switches
// in the API's order, a line only under the one that does less than it seems
// to (#581); a press saved at once and the switch waiting meanwhile, a failure
// said in words with the switch as it was, a load that failed with Try again,
// and every switch labelled.

const INTRO =
  "A notification says that there is a new message, a new match or an announcement, never what it says or from whom.";
const KINDS = ["Messages", "Matches", "Moderators' decisions"];
const HINT = "Nothing is sent to your phones for these yet.";
/** Kuutti's announcements (#573, ADR-068 §6): off stops the push and the email, never the notice. */
const ANNOUNCEMENTS = "Announcements from Kuutti";
const ANNOUNCEMENTS_HINT =
  "When this is off, an announcement still shows in the app, with no push and no email.";
/** Every text on the screen, in order. */
const drawn = () => screen.queryAllByText(/./).map((node) => node.props.children);
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choices = (off: string[] = []) => ({
  choices: ["message", "match", "moderation", "announcement"].map((kind) => ({
    kind,
    enabled: !off.includes(kind),
  })),
});
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

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
  it("shows each kind as the API holds it, and saves a press at once", async () => {
    const seen = api((sent) =>
      sent.method === "GET" ? json(choices(["match"])) : json(choices(["match", "message"])),
    );
    await renderWithTheme(<NotificationChoices />);
    expect(await screen.findByRole("switch", { name: "Messages" })).toBeTruthy();
    for (const name of ["Messages", "Moderators' decisions", ANNOUNCEMENTS]) {
      expect(checked(name)).toBe(true);
    }
    expect(checked("Matches")).toBe(false);
    // The round's push went with the daily set (ADR-062 §12), and its switch with it.
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(screen.queryByRole("switch", { name: "A new round" })).toBeNull();
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

  it.each<[string, object | null, string[]]>([
    ["never asked", null, ["Allow notifications"]],
    [
      "refusing them",
      { granted: false, canAskAgain: false, ios: { status: 1 } },
      ["Open the phone's settings"],
    ],
    ["allowing them", { granted: true, canAskAgain: true, ios: { status: 2 } }, []],
  ])(
    "draws what a phone %s leaves to do first, then what a notification says, then the kinds, a line under Moderators' decisions and Announcements alone (#581, #573)",
    async (_phone, answer, phonePart) => {
      if (answer)
        jest.mocked(Notifications).getPermissionsAsync.mockResolvedValueOnce(answer as never);
      api(() => json(choices()));
      await renderWithTheme(<NotificationChoices />);
      await screen.findByRole("switch", { name: "Messages" });
      await settle();
      expect(drawn()).toEqual([
        ...phonePart,
        INTRO,
        ...KINDS,
        HINT,
        ANNOUNCEMENTS,
        ANNOUNCEMENTS_HINT,
      ]);
      noProblems();
    },
  );

  it.each([
    [
      "fi-FI",
      "Ilmoitus kertoo, että sinulle on uusi viesti, uusi mätsi tai tiedote, ei koskaan mitä siinä lukee tai keneltä se on.",
      "Viestit",
      "Näistä ei vielä lähetetä puhelimillesi mitään.",
      "Kuutin tiedotteet",
      "Kun tämä on pois päältä, tiedote näkyy silti sovelluksessa, mutta ilman ilmoitusta ja sähköpostia.",
    ],
    [
      "sv-FI",
      "En avisering säger att det finns ett nytt meddelande, en ny matchning eller ett meddelande från Kuutti, aldrig vad det står eller från vem.",
      "Meddelanden",
      "Inget skickas till dina telefoner om detta än.",
      "Meddelanden från Kuutti",
      "När det här är avstängt syns ett meddelande ändå i appen, utan avisering och utan e-post.",
    ],
  ])(
    "says what a notification says, and the lines of Moderators' decisions and Announcements, in %s",
    async (languageTag, intro, messages, hint, announcements, announcementsHint) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      api(() => json(choices()));
      await renderWithTheme(<NotificationChoices />);
      expect(await screen.findByRole("switch", { name: messages })).toBeTruthy();
      expect(screen.getByText(intro)).toBeTruthy();
      expect(screen.getByText(hint)).toBeTruthy();
      expect(screen.getByRole("switch", { name: announcements })).toBeTruthy();
      expect(screen.getByText(announcementsHint)).toBeTruthy();
    },
  );

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
    expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
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
    expect(await screen.findByText(FAILED_TO_LOAD)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));
    expect(await screen.findByRole("switch", { name: "Messages" })).toBeTruthy();
  });
});
