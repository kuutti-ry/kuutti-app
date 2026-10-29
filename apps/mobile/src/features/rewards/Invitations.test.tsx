import { formatDateTime } from "@kuutti/i18n";
import type { Invitations as InvitationsAnswer } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import { AccessibilityInfo, AppState, Platform, Share } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { Invitations } from "./Invitations";

// Settings › Invitations (#107, ADR-044): what an invitation earns in words;
// Make an invitation and the code shown once, read a character at a time and
// shared through the sheet it is handed; the open invitations, each
// withdrawn only after asking; how many counted and what waits; anybody who
// may not invite told when they may; a code from a friend for whoever may
// still type one; each refusal and failure in words; no accessibility
// problem in any of it.

const { __focus: focus } = jest.requireMock("expo-router") as { __focus: () => void };
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "x", requestId: "r" } }, status);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const press = async (element: ReturnType<typeof screen.getByRole>) => {
  await act(async () => fireEvent.press(element));
  await settle();
};
const button = (name: string) => screen.getByRole("button", { name });

const OLDER = { id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01", createdAt: "2026-10-20T08:30:00.000Z" };
const NEW = { id: "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a02", createdAt: "2026-10-22T12:15:00.000Z" };
const CODE = "ABCDE-FGHJK";
const made = (at: string) => `Made ${formatDateTime("en", new Date(at))}`;
const withdrawLabel = (at: string) =>
  `Withdraw the invitation made ${formatDateTime("en", new Date(at))}`;

const TEXT = {
  intro:
    "Invite a friend with a code. They get the app at kuutti.app, sign in with their bank and type the code before their profile is complete. Each code works once.",
  fish: "When a friend you invite finishes their profile, you get a fish. An earned fish is used by itself once your own fish are used up.",
  made: "Your invitation is ready. Its code is below.",
  once: "Kuutti shows this code only now and keeps no copy of it. Share it with one friend, or write it down.",
  withdrawn: "The invitation was withdrawn. Its code no longer works.",
  notYet: "You can invite friends once your profile is complete.",
  done: "The code is in. Your friend's invitation counts once your profile is complete.",
};

const answer = (over: Partial<InvitationsAnswer> = {}): InvitationsAnswer => ({
  canInvite: true,
  redeemable: false,
  reward: { fish: 1, likes: 0 },
  open: [],
  counted: 0,
  earned: { fish: 0, likes: 0 },
  ...over,
});

type Sent = { method: string; path: string; body: unknown };
/**
 * A tiny API holding the person's invitations as the routes change them; a
 * route's answer may be replaced for a refusal, or held for the test to give.
 */
function fakeApi(first: InvitationsAnswer) {
  const state = { invitations: first };
  const seen: Sent[] = [];
  const override: Partial<Record<"make" | "withdraw" | "redeem" | "read", () => Response>> = {};
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    seen.push({ method: request.method, path, body: text ? JSON.parse(text) : null });
    if (request.method === "GET") return override.read?.() ?? json(state.invitations);
    if (path === "/invitations/redeem") {
      if (override.redeem) return override.redeem();
      state.invitations = { ...state.invitations, redeemable: false };
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST") {
      if (override.make) return override.make();
      state.invitations = { ...state.invitations, open: [NEW, ...state.invitations.open] };
      return json({ id: NEW.id, code: CODE, createdAt: NEW.createdAt }, 201);
    }
    if (override.withdraw) return override.withdraw();
    const id = path.split("/").at(-1);
    state.invitations = {
      ...state.invitations,
      open: state.invitations.open.filter((invitation) => invitation.id !== id),
    };
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { state, seen, override };
}
const writes = (seen: Sent[]) => seen.filter((sent) => sent.method !== "GET");

beforeEach(async () => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  jest.replaceProperty(Platform, "OS", "ios");
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

describe("Invitations", () => {
  it("says it is loading, and a read that failed says why with Try again, which reads again", async () => {
    const waiting: Array<(response: Response) => void> = [];
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          waiting.push(resolve);
        }),
    ) as unknown as typeof fetch;
    await renderWithTheme(<Invitations />);
    expect(screen.getByText("Loading your invitations…").props.accessibilityLiveRegion).toBe(
      "polite",
    );
    await act(async () => waiting.shift()?.(refusal("internal_error", 500)));
    expect(screen.getByText("Your invitations could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    noProblems();
    await act(async () => fireEvent.press(button("Try again")));
    expect(screen.getByText("Loading your invitations…")).toBeTruthy();
    await act(async () => waiting.shift()?.(json(answer())));
    expect(button("Make an invitation")).toBeTruthy();
  });

  it("says what an invitation earns, how many counted, and nothing waiting, with no accessibility problems", async () => {
    fakeApi(answer());
    await renderWithTheme(<Invitations />);
    expect(await screen.findByText(TEXT.intro)).toBeTruthy();
    expect(screen.getByText(TEXT.fish)).toBeTruthy();
    expect(screen.getByText("No friend you invited has finished their profile yet.")).toBeTruthy();
    expect(screen.queryByText(/waiting\.$/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Waiting to be used" })).toBeNull();
    // Somebody who may invite cannot type a code: the two never meet.
    expect(screen.queryByLabelText("Invitation code")).toBeNull();
    noProblems();
  });

  it.each([
    [
      { fish: 0, likes: 5 },
      "When a friend you invite finishes their profile, you get 5 extra likes. An extra like is used by itself on a day your likes run out.",
    ],
    [
      { fish: 2, likes: 1 },
      "When a friend you invite finishes their profile, you get 2 fish and an extra like. They are used by themselves once your own fish or likes run out.",
    ],
    [
      { fish: 0, likes: 0 },
      "Invitations earn nothing just now, but every friend you bring is welcome.",
    ],
  ])("says the reward %j in words", async (reward, words) => {
    fakeApi(answer({ reward }));
    await renderWithTheme(<Invitations />);
    expect(await screen.findByText(words)).toBeTruthy();
  });

  it.each([
    [
      1,
      { fish: 2, likes: 0 },
      "One friend you invited has finished their profile.",
      ["You have 2 earned fish waiting."],
    ],
    [
      3,
      { fish: 1, likes: 1 },
      "3 friends you invited have finished their profiles.",
      ["You have an earned fish waiting.", "You have an extra like waiting."],
    ],
    [
      2,
      { fish: 0, likes: 4 },
      "2 friends you invited have finished their profiles.",
      ["You have 4 extra likes waiting."],
    ],
  ])("says %i counted and what waits, %j", async (counted, earned, countedWords, waiting) => {
    fakeApi(answer({ counted, earned }));
    await renderWithTheme(<Invitations />);
    expect(await screen.findByText(countedWords)).toBeTruthy();
    for (const words of waiting) expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryAllByText(/waiting\.$/)).toHaveLength(waiting.length);
  });

  it("makes an invitation and shows its code once, read a character at a time, and lists it", async () => {
    const { seen } = fakeApi(answer({ open: [OLDER] }));
    await renderWithTheme(<Invitations share={jest.fn()} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    expect(writes(seen)).toEqual([{ method: "POST", path: "/invitations", body: null }]);
    expect(screen.getByText(TEXT.made).props.accessibilityLiveRegion).toBe("assertive");
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(TEXT.made);
    const code = screen.getByText(CODE);
    expect(code.props.selectable).toBe(true);
    expect(code.props.accessibilityLabel).toBe("Invitation code: A B C D E, F G H J K");
    expect(screen.getByText("Your invitation code")).toBeTruthy();
    expect(screen.getByText(TEXT.once)).toBeTruthy();
    // The list was read again: the new one first, the older after it.
    expect(screen.getByRole("heading", { name: "Waiting to be used" })).toBeTruthy();
    const flat = JSON.stringify(screen.toJSON());
    expect(flat.indexOf(made(NEW.createdAt))).toBeGreaterThan(-1);
    expect(flat.indexOf(made(NEW.createdAt))).toBeLessThan(flat.indexOf(made(OLDER.createdAt)));
    expect(button(withdrawLabel(NEW.createdAt))).toBeTruthy();
    noProblems();
  });

  it("is dimmed while an invitation is on its way", async () => {
    fakeApi(answer());
    await renderWithTheme(<Invitations />);
    const make = await screen.findByRole("button", { name: "Make an invitation" });
    // From here each call waits for the test to answer it.
    const waiting: Array<(response: Response) => void> = [];
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          waiting.push(resolve);
        }),
    ) as unknown as typeof fetch;
    await act(async () => fireEvent.press(make));
    expect(button("Make an invitation").props.accessibilityState?.disabled).toBe(true);
    await act(async () => waiting.shift()?.(refusal("internal_error", 500)));
    await settle();
    // Still dimmed while the list is read again after it.
    expect(button("Make an invitation").props.accessibilityState?.disabled).toBe(true);
    await act(async () => waiting.shift()?.(json(answer())));
    await settle();
    expect(button("Make an invitation").props.accessibilityState?.disabled).toBe(false);
  });

  it("hands the share sheet the invitation's message with the code, and nothing about the sender", async () => {
    fakeApi(answer());
    const share = jest.fn(async () => ({ action: "sharedAction" as const }));
    await renderWithTheme(<Invitations share={share as never} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button("Share the code"));
    expect(share).toHaveBeenCalledWith({
      message:
        "You're invited to Kuutti, a free dating app for Finland where everyone signs in with their bank ID. Get the app at https://kuutti.app/ and type this code after signing in: ABCDE-FGHJK",
    });
    expect(
      screen.queryByText("The share did not open. You can copy the code above instead."),
    ).toBeNull();
  });

  it("says so when the share sheet does not open, and keeps the code to copy", async () => {
    fakeApi(answer());
    const share = jest.fn(async () => {
      throw new Error("no activity");
    });
    await renderWithTheme(<Invitations share={share as never} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button("Share the code"));
    const words = "The share did not open. You can copy the code above instead.";
    expect(screen.getByText(words)).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(words);
    expect(screen.getByText(CODE)).toBeTruthy();
  });

  it("hands the phone's own share sheet the message when no other is given", async () => {
    fakeApi(answer());
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
    await renderWithTheme(<Invitations />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button("Share the code"));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/: ABCDE-FGHJK$/),
    });
  });

  it("leaves its notices to TalkBack's reading of the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    fakeApi(answer());
    await renderWithTheme(<Invitations />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    expect(screen.getByText(TEXT.made).props.accessibilityLiveRegion).toBe("assertive");
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it.each([
    [
      "invitations_full",
      409,
      "You have as many invitations waiting as you can have. Withdraw one, or wait until a friend uses one.",
    ],
    ["invitation_not_yet", 409, "You can invite friends once your profile is complete."],
    ["internal_error", 500, "The invitation could not be made. Try again."],
  ])(
    "says the refusal %s of a new invitation in words, and shows no code",
    async (code, status, words) => {
      const api = fakeApi(answer());
      api.override.make = () => refusal(code, status);
      await renderWithTheme(<Invitations />);
      await press(await screen.findByRole("button", { name: "Make an invitation" }));
      expect(screen.getByText(words).props.accessibilityLiveRegion).toBe("assertive");
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(words);
      expect(screen.queryByText("Your invitation code")).toBeNull();
    },
  );

  it("says an invitation could not be made when its answer cannot be read, and shows no code", async () => {
    const api = fakeApi(answer());
    // A code not in its two groups: the contract refuses it, and nothing half-read is shown.
    api.override.make = () =>
      json({ id: NEW.id, code: "ABCDEFGHJK", createdAt: NEW.createdAt }, 201);
    await renderWithTheme(<Invitations />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    expect(screen.getByText("The invitation could not be made. Try again.")).toBeTruthy();
    expect(screen.queryByText("ABCDEFGHJK")).toBeNull();
  });

  it("withdraws an open invitation only after asking, and takes the code just made with it", async () => {
    const { seen } = fakeApi(answer({ open: [OLDER] }));
    await renderWithTheme(<Invitations share={jest.fn()} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button(withdrawLabel(NEW.createdAt)));
    expect(screen.getByText("Withdraw this invitation?")).toBeTruthy();
    expect(
      screen.getByText("Its code stops working at once. A friend who has it can no longer use it."),
    ).toBeTruthy();
    noProblems();
    // Kept: nothing sent, the code still there.
    await press(button("Keep it"));
    expect(screen.queryByText("Withdraw this invitation?")).toBeNull();
    expect(writes(seen)).toHaveLength(1);
    // The close control asks nothing either.
    await press(button(withdrawLabel(NEW.createdAt)));
    await press(button("Close"));
    expect(screen.queryByText("Withdraw this invitation?")).toBeNull();
    expect(writes(seen)).toHaveLength(1);
    await press(button(withdrawLabel(NEW.createdAt)));
    await press(button("Withdraw the invitation"));
    expect(writes(seen).at(-1)).toEqual({
      method: "DELETE",
      path: `/invitations/${NEW.id}`,
      body: null,
    });
    expect(screen.getByText(TEXT.withdrawn).props.accessibilityLiveRegion).toBe("assertive");
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(TEXT.withdrawn);
    expect(screen.queryByText(CODE)).toBeNull();
    expect(screen.queryByText(made(NEW.createdAt))).toBeNull();
    expect(screen.getByText(made(OLDER.createdAt))).toBeTruthy();
  });

  it("keeps the code just made when another invitation is withdrawn, and the heading goes with the last one", async () => {
    fakeApi(answer({ open: [OLDER] }));
    await renderWithTheme(<Invitations share={jest.fn()} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button(withdrawLabel(OLDER.createdAt)));
    await press(button("Withdraw the invitation"));
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(screen.queryByText(made(OLDER.createdAt))).toBeNull();
    await press(button(withdrawLabel(NEW.createdAt)));
    await press(button("Withdraw the invitation"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Waiting to be used" })).toBeNull(),
    );
  });

  type Foreground = ((state: string) => void) | undefined;
  it.each<[string, (foreground: Foreground) => void]>([
    ["the screen comes to the front again", () => focus()],
    ["the app comes back to the foreground", (foreground) => foreground?.("active")],
  ])(
    "takes the code just made away once a read no longer lists it, when %s",
    async (_when, read) => {
      let foreground: Foreground;
      jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
        foreground = listener as (state: string) => void;
        return { remove: jest.fn() } as never;
      });
      const api = fakeApi(answer({ open: [OLDER] }));
      await renderWithTheme(<Invitations share={jest.fn()} />);
      await press(await screen.findByRole("button", { name: "Make an invitation" }));
      expect(screen.getByText(CODE)).toBeTruthy();
      // A friend used it while the screen was open: the list no longer has it.
      api.state.invitations = answer({ open: [OLDER] });
      await act(async () => read(foreground));
      await settle();
      expect(screen.queryByText(CODE)).toBeNull();
      expect(screen.queryByRole("button", { name: "Share the code" })).toBeNull();
      expect(screen.queryByText("Your invitation code")).toBeNull();
      // Nor does the notice point at a code no longer there.
      expect(screen.queryByText(TEXT.made)).toBeNull();
      expect(screen.queryByText(made(NEW.createdAt))).toBeNull();
      expect(screen.getByText(made(OLDER.createdAt))).toBeTruthy();
    },
  );

  it("takes the code just made away when its withdrawal finds it used meanwhile", async () => {
    const api = fakeApi(answer({ open: [OLDER] }));
    await renderWithTheme(<Invitations share={jest.fn()} />);
    await press(await screen.findByRole("button", { name: "Make an invitation" }));
    await press(button(withdrawLabel(NEW.createdAt)));
    // Meanwhile a friend used it: the withdrawal is refused, and the list read after it lacks it.
    api.override.withdraw = () => refusal("not_found", 404);
    api.state.invitations = answer({ open: [OLDER] });
    await press(button("Withdraw the invitation"));
    expect(screen.getByText("The invitation could not be withdrawn. Try again.")).toBeTruthy();
    expect(screen.queryByText(CODE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Share the code" })).toBeNull();
  });

  it("keeps the code just made when the read after it fails, until a read has listed it and another no longer does", async () => {
    const api = fakeApi(answer({ open: [OLDER] }));
    await renderWithTheme(<Invitations share={jest.fn()} />);
    const make = await screen.findByRole("button", { name: "Make an invitation" });
    api.override.read = () => refusal("internal_error", 500);
    await press(make);
    // The list shown is the one from before the make, without the new one: the code stays.
    expect(screen.getByText(TEXT.made)).toBeTruthy();
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(button("Share the code")).toBeTruthy();
    expect(screen.queryByText(made(NEW.createdAt))).toBeNull();
    // The next read lists it, and the code stays with it.
    delete api.override.read;
    await act(async () => focus());
    await settle();
    expect(screen.getByText(made(NEW.createdAt))).toBeTruthy();
    expect(screen.getByText(CODE)).toBeTruthy();
    // A read that fails quietly takes nothing away.
    api.override.read = () => refusal("internal_error", 500);
    await act(async () => focus());
    await settle();
    expect(screen.getByText(CODE)).toBeTruthy();
    // Once a read no longer lists it, it goes.
    delete api.override.read;
    api.state.invitations = answer({ open: [OLDER] });
    await act(async () => focus());
    await settle();
    expect(screen.queryByText(CODE)).toBeNull();
  });

  it("says a withdrawal that failed, and reads the list again", async () => {
    const api = fakeApi(answer({ open: [OLDER] }));
    api.override.withdraw = () => refusal("not_found", 404);
    await renderWithTheme(<Invitations />);
    await press(await screen.findByRole("button", { name: withdrawLabel(OLDER.createdAt) }));
    // Meanwhile a friend used it: the list read after the refusal no longer has it.
    api.state.invitations = answer({ open: [] });
    await press(button("Withdraw the invitation"));
    const words = "The invitation could not be withdrawn. Try again.";
    expect(screen.getByText(words).props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.queryByText(made(OLDER.createdAt))).toBeNull();
  });

  it("says invitations open once the profile is complete, with no way to make one", async () => {
    fakeApi(answer({ canInvite: false }));
    await renderWithTheme(<Invitations />);
    expect(await screen.findByText(TEXT.notYet)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make an invitation" })).toBeNull();
    expect(screen.queryByText(TEXT.intro)).toBeNull();
    expect(screen.queryByLabelText("Invitation code")).toBeNull();
  });

  it("takes a code from a friend while one may be typed, and thanks the person after it", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const { seen } = fakeApi(answer({ canInvite: false, redeemable: true }));
    await renderWithTheme(<Invitations />);
    expect(await screen.findByRole("heading", { name: "Have an invitation code?" })).toBeTruthy();
    expect(screen.getByText(TEXT.notYet)).toBeTruthy();
    expect(
      screen.getByText(
        "If a friend gave you a code, type it here. Their invitation counts once your profile is complete.",
      ),
    ).toBeTruthy();
    noProblems();
    await act(async () =>
      fireEvent.changeText(screen.getByLabelText("Invitation code"), "ABCDE FGHJK"),
    );
    await press(button("Use the code"));
    expect(writes(seen)).toEqual([
      { method: "POST", path: "/invitations/redeem", body: { code: "ABCDE FGHJK" } },
    ]);
    // The list read again says no more codes; the thanks stays where the field was.
    await waitFor(() => expect(seen.filter((sent) => sent.method === "GET")).toHaveLength(2));
    expect(screen.getByText(TEXT.done).props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByLabelText("Invitation code")).toBeNull();
  });

  it("speaks the phone's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "sv-FI" }]);
    fakeApi(answer({ counted: 1 }));
    await renderWithTheme(<Invitations />);
    expect(await screen.findByRole("button", { name: "Skapa en inbjudan" })).toBeTruthy();
    expect(screen.getByText("En vän du bjudit in har gjort klart sin profil.")).toBeTruthy();
  });
});
