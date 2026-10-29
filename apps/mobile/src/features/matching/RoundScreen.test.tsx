import type { ProfileCard, RoundEntry, RoundResponse } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, AppState, Dimensions, Platform, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { RoundScreen } from "./RoundScreen";

// Today's round on the phone (#379, ADR-034): one card at a time with its
// reason, like and pass as buttons, Undo on the last decision, a match that
// leads to the conversation, block or report from the card, the end, an
// empty round and one not built in their own words, and every refusal of the
// routes said: a day that ended, a card gone, the day's likes and cards used
// up, a like that made a match. A new day's round is never touched by the old
// day's answers, and a round left open past midnight is read anew.

const {
  __router: router,
  __focus: focusRound,
  __blur: blurRound,
} = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
  __blur: () => void;
};
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const refusal = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code, message: "x", requestId: "r" } }, status, headers);
const noContent = () => new Response(null, { status: 204 });

const DAY = "2026-10-20";
const NEXT_DAY = "2026-10-21";
/** 12:00 in Finland on DAY: a test that brings the round back in sight sets the phone's clock. */
const NOON = Date.parse("2026-10-20T09:00:00Z");
const CONVERSATION = "3f9a2c1e-5b7d-4f01-8a2b-1c3d4e5f6a70";
const PHOTO = "0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01" as ProfileCard["photos"][number]["id"];

function card(n: number, name: string): ProfileCard {
  return {
    accountId: `6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4${n}`,
    displayName: name,
    age: { years: 30 + n, verifiedByBank: true },
    gender: null,
    pond: null,
    photos: [],
    fields: {},
    bio: null,
    bioPreset: null,
    prompts: [],
    shared: { hobbies: [], languages: [] },
  };
}
const entry = (
  position: number,
  name: string,
  reason: RoundEntry["reason"] = "matches_filters",
  decision: RoundEntry["decision"] = null,
): RoundEntry => ({ position, reason, decision, card: card(position, name) });

const ROUND: RoundResponse = {
  day: DAY,
  entries: [entry(1, "Henna", "liked_you"), entry(2, "Katja"), entry(4, "Minna", "seen_before")],
};

type Call = { method: string; path: string; body: unknown };
type Answer = (call: Call) => Response | Promise<Response> | undefined;
/**
 * The API as the screen sees it: `answer` first, then the defaults (the
 * round, a seen recorded, a decision with no match, a block done).
 */
function api(answer: Answer = () => undefined, round: RoundResponse = ROUND) {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    const call = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const given = await answer(call);
    if (given) return given;
    if (call.path === "/rounds/today") return json(round);
    if (call.path.endsWith("/seen")) return noContent();
    if (call.path.endsWith("/decision")) return json({ match: null });
    if (call.path === "/blocks") return noContent();
    return refusal("not_found", 404);
  }) as unknown as typeof fetch;
  return {
    calls,
    decisions: () =>
      calls
        .filter((c) => c.path.endsWith("/decision"))
        .map(
          (c) =>
            `${c.path.split("/")[2]}/${c.path.split("/")[4]} ${(c.body as { decision: string }).decision}`,
        ),
    seen: () =>
      calls.filter((c) => c.path.endsWith("/seen")).map((c) => Number(c.path.split("/")[4])),
    reads: () => calls.filter((c) => c.path === "/rounds/today").length,
  };
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const show = async () => {
  await renderWithTheme(<RoundScreen />);
  await settle();
};
const press = async (name: string) => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name }));
  });
  await settle();
};
const heading = (name: string) => screen.getByRole("heading", { name });
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
/** The app's AppState listeners, while subscribed. */
const appState = new Set<(state: string) => void>();
const appBecomes = async (state: string) => {
  await act(async () => {
    for (const listener of [...appState]) listener(state);
  });
  await settle();
};
/** The kinds of node a text sits inside, its own first. */
const ancestorsOf = (words: string) => {
  const kinds: unknown[] = [];
  for (let node = screen.getByText(words).parent; node; node = node.parent) kinds.push(node.type);
  return kinds;
};

beforeEach(async () => {
  store.clear();
  router.push.mockReset();
  router.back.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (AccessibilityInfo.sendAccessibilityEvent as jest.Mock).mockClear();
  appState.clear();
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    const each = listener as (state: string) => void;
    appState.add(each);
    return { remove: () => appState.delete(each) } as never;
  });
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

describe("today's round", () => {
  it("shows one card at a time in the round's order, each with its reason, and decides each with a button", async () => {
    const sent = api();
    await show();
    expect(heading("Today's round")).toBeTruthy();
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.getByText("Liked you")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Katja, 32" })).toBeNull();
    // Like and pass are buttons with their words, pass first (at the left), neither a swipe.
    const decisions = screen
      .getAllByRole("button")
      .map((button) => button.props.accessibilityLabel)
      .filter((label) => label === "Like" || label === "Pass");
    expect(decisions).toEqual(["Pass", "Like"]);
    noProblems();
    // Nothing to take back yet.
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();

    await press("Like");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.getByText("Matches your filters")).toBeTruthy();
    await press("Pass");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.getByText("Seen before")).toBeTruthy();
    await press("Pass");

    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/2 pass`, `${DAY}/4 pass`]);
    // Each card reported itself seen once, as it came on the screen.
    expect(sent.seen()).toEqual([1, 2, 4]);
    expect(sent.reads()).toBe(1);
    // The screen reader is taken to each card's first line, and to the end.
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledTimes(4);
  });

  it("goes back home with the header's arrow", async () => {
    api();
    await show();
    await press("Back to home");
    expect(router.back).toHaveBeenCalled();
  });

  it("starts at the first card not decided yet, so a card decided earlier today is not shown again", async () => {
    api(undefined, {
      day: DAY,
      entries: [entry(1, "Henna", "liked_you", "pass"), entry(2, "Katja")],
    });
    await show();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Henna, 31" })).toBeNull();
  });

  it("says when every card was decided earlier today that the round is done", async () => {
    api(undefined, { day: DAY, entries: [entry(1, "Henna", "liked_you", "like")] });
    await show();
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
  });

  it.each([
    ["an empty round", [], "There is nobody to show you today. Come back tomorrow."],
    ["a round not built", null, "Your round is not ready yet. Come back tomorrow."],
  ] as const)(
    "says %s in its own words, with no card and no button to decide",
    async (_what, entries, words) => {
      const sent = api(undefined, { day: DAY, entries: entries === null ? null : [...entries] });
      await show();
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
      expect(sent.seen()).toEqual([]);
    },
  );

  it("reads today's round again when a decision finds that the day ended, and says so", async () => {
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(reads === 1 ? ROUND : { day: NEXT_DAY, entries: [entry(1, "Riikka")] });
      }
      if (call.path.startsWith(`/rounds/${DAY}/`) && call.path.endsWith("/decision")) {
        return refusal("round_expired", 409);
      }
      return undefined;
    });
    await show();
    await press("Like");
    expect(screen.getByText("That round ended at midnight, so this was not saved.")).toBeTruthy();
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    expect(sent.seen()).toEqual([1, 1]);
  });

  it("reads today's round again when a card's seen report finds that the day ended, and says so", async () => {
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(reads === 1 ? ROUND : { day: NEXT_DAY, entries: [entry(1, "Riikka")] });
      }
      if (call.path === `/rounds/${DAY}/entries/1/seen`) return refusal("round_expired", 409);
      return undefined;
    });
    await show();
    await settle();
    expect(screen.getByText("Yesterday's round ended at midnight. This is today's.")).toBeTruthy();
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });

  it("says that liking back a liked-you card is a match, and leads to the conversation", async () => {
    // Back from the conversation on the round's own day, which reads nothing anew.
    jest.spyOn(Date, "now").mockReturnValue(NOON);
    const sent = api((call) =>
      call.path === `/rounds/${DAY}/entries/1/decision`
        ? json({ match: { conversationId: CONVERSATION } })
        : undefined,
    );
    await show();
    await press("Like");
    expect(heading("It's a match")).toBeTruthy();
    expect(
      screen.getByText(
        "You both liked each other, so a conversation is open for you two under Conversations.",
      ),
    ).toBeTruthy();
    // The next card waits behind the match: neither shown nor reported seen.
    expect(screen.queryByRole("heading", { name: "Katja, 32" })).toBeNull();
    expect(sent.seen()).toEqual([1]);
    // A like that made a match is final (ADR-038 §3): nothing offers it back.
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
    noProblems();

    await press("Go to the conversation");
    expect(router.push).toHaveBeenCalledWith(`/chats/${CONVERSATION}`);
    // The conversation covers the round, which stays mounted under it: the
    // match stays in front of the next card, neither shown nor reported seen.
    await act(async () => blurRound());
    await settle();
    expect(heading("It's a match")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Katja, 32" })).toBeNull();
    expect(sent.seen()).toEqual([1]);
    // Back from the conversation, the round goes on, the next card reported once.
    await act(async () => focusRound());
    await settle();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.seen()).toEqual([1, 2]);
    await act(async () => {
      blurRound();
      focusRound();
    });
    await settle();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.seen()).toEqual([1, 2]);
  });

  it("goes on with the round from a match without opening the conversation", async () => {
    api((call) =>
      call.path.endsWith("/decision")
        ? json({ match: { conversationId: CONVERSATION } })
        : undefined,
    );
    await show();
    await press("Like");
    await press("Back to the round");
    expect(router.push).not.toHaveBeenCalled();
    expect(heading("Katja, 32")).toBeTruthy();
  });

  it("brings the last card back with Undo, says its decision, and lets it change until midnight", async () => {
    const sent = api();
    await show();
    await press("Like");
    expect(heading("Katja, 32")).toBeTruthy();
    noProblems();
    await press("Undo your last decision");

    expect(heading("Henna, 31")).toBeTruthy();
    expect(
      screen.getByText("You liked this person. You can change that until midnight."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Like" }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByRole("button", { name: "Pass" }).props.accessibilityState).toMatchObject({
      selected: false,
    });
    // One step back only: the card before it is not offered.
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
    // Seen once, whatever brought it back.
    expect(sent.seen()).toEqual([1, 2]);

    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    await press("Undo your last decision");
    expect(
      screen.getByText("You passed on this person. You can change that until midnight."),
    ).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/1 pass`]);
  });

  it("says that a like which made a match stays, when changing it is refused, and goes on", async () => {
    api((call) =>
      call.path === `/rounds/${DAY}/entries/2/decision` &&
      (call.body as { decision: string }).decision === "pass"
        ? refusal("match_made", 409)
        : undefined,
    );
    await show();
    await press("Like");
    await press("Like");
    await press("Undo your last decision");
    expect(heading("Katja, 32")).toBeTruthy();
    await press("Pass");
    expect(
      screen.getByText(
        "This like made a match, so it stays. You can still end the conversation under Conversations.",
      ),
    ).toBeTruthy();
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
  });

  it("sends a fish from a card that answers nobody's like, and says it back after Undo (#378)", async () => {
    const sent = api(undefined, { day: DAY, entries: [entry(2, "Katja"), entry(4, "Minna")] });
    await show();
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.props.accessibilityLabel)
      .filter((label) => ["Send a fish", "Pass", "Like"].includes(label));
    expect(buttons).toEqual(["Send a fish", "Pass", "Like"]);
    noProblems();
    await press("Send a fish");
    expect(heading("Minna, 34")).toBeTruthy();
    await press("Undo your last decision");
    expect(
      screen.getByText("You sent this person a fish. You can change that until midnight."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send a fish" }).props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(sent.decisions()).toEqual([`${DAY}/2 fish`]);
  });

  it.each([
    ["liked the reader", "liked_you", "Liked you"],
    ["sent the reader a fish", "fish", "Sent you a fish"],
  ] as const)(
    "offers no fish on a card that %s, which a like answers (ADR-039 §2)",
    async (_what, reason, label) => {
      api(undefined, { day: DAY, entries: [entry(1, "Henna", reason)] });
      await show();
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Like" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Send a fish" })).toBeNull();
    },
  );

  it("says the earliest day for the next fish when the week's fish is sent, and keeps the card for a like", async () => {
    // 10:00 UTC on 20.10.; the window opens at midnight in Finland before 23.10. (21:00 UTC on 22.10.).
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T10:00:00Z"));
    const wait = (Date.parse("2026-10-22T21:00:00Z") - Date.parse("2026-10-20T10:00:00Z")) / 1000;
    api(
      (call) =>
        call.path.endsWith("/decision") && (call.body as { decision: string }).decision === "fish"
          ? refusal("fish_budget_exceeded", 429, { "retry-after": String(wait) })
          : undefined,
      { day: DAY, entries: [entry(2, "Katja")] },
    );
    await show();
    await press("Send a fish");
    expect(
      screen.getByText(
        "You cannot send a fish just now, but you can still like. The earliest day for the next one: 23.10.2026",
      ),
    ).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    await press("Like");
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
  });

  it("names the right day for the next fish when the phone's clock is a minute behind", async () => {
    // The API counts the wait from its 10:00 UTC to midnight in Finland before
    // 23.10.; the phone thinks it is 9:59, so the wait ends at 23:59 on 22.10. by its clock.
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T09:59:00Z"));
    const wait = (Date.parse("2026-10-22T21:00:00Z") - Date.parse("2026-10-20T10:00:00Z")) / 1000;
    api(
      (call) =>
        call.path.endsWith("/decision")
          ? refusal("fish_budget_exceeded", 429, { "retry-after": String(wait) })
          : undefined,
      { day: DAY, entries: [entry(2, "Katja")] },
    );
    await show();
    await press("Send a fish");
    expect(screen.getByText(/The earliest day for the next one: 23\.10\.2026$/)).toBeTruthy();
  });

  it.each([
    ["no wait", {}],
    ["a wait that is no number", { "retry-after": "soon" }],
  ] as const)(
    "says the week's fish is sent without a day when the refusal names %s",
    async (_what, headers) => {
      api(
        (call) =>
          call.path.endsWith("/decision")
            ? refusal("fish_budget_exceeded", 429, headers)
            : undefined,
        { day: DAY, entries: [entry(2, "Katja")] },
      );
      await show();
      await press("Send a fish");
      expect(screen.getByText("You cannot send a fish just now. You can still like.")).toBeTruthy();
    },
  );

  it("takes a card that was liked into a match elsewhere as liked, when its first decision here is refused", async () => {
    api((call) =>
      call.path === `/rounds/${DAY}/entries/1/decision` ? refusal("match_made", 409) : undefined,
    );
    await show();
    await press("Pass");
    expect(screen.getByText(/This like made a match, so it stays/)).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
  });

  it("blocks from a round card, and the card leaves the screen (ADR-030 §11)", async () => {
    const sent = api();
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Block or report" }));
    });
    await press("Block");
    await press("Block");
    await screen.findByText("Blocked. You will not see each other again.");
    await press("Done");
    await waitFor(() => expect(heading("Katja, 32")).toBeTruthy());
    expect(sent.calls.find((c) => c.path === "/blocks")?.body).toEqual({
      accountId: card(1, "Henna").accountId,
    });
    expect(sent.decisions()).toEqual([]);
  });

  it("takes a card that is gone meanwhile off the screen, and says so", async () => {
    api((call) =>
      call.path === `/rounds/${DAY}/entries/1/decision` ? refusal("not_found", 404) : undefined,
    );
    await show();
    await press("Like");
    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Henna, 31" })).toBeNull();
  });

  it("takes a card off the screen when its seen report finds it gone", async () => {
    const sent = api((call) =>
      call.path === `/rounds/${DAY}/entries/2/seen` ? refusal("not_found", 404) : undefined,
    );
    await show();
    await press("Like");
    await settle();
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Katja, 32" })).toBeNull();
    // What Undo brings back is still the last decision's card.
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(sent.seen()).toEqual([1, 2, 4]);
  });

  it("takes a card brought back by Undo off the screen when it is gone meanwhile, and goes on", async () => {
    api((call) =>
      call.path === `/rounds/${DAY}/entries/1/decision` &&
      (call.body as { decision: string }).decision === "pass"
        ? refusal("not_found", 404)
        : undefined,
    );
    await show();
    await press("Like");
    await press("Undo your last decision");
    await press("Pass");
    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
  });

  it.each([
    ["the API failed", () => refusal("internal", 500)],
    [
      "the network",
      () => {
        throw new TypeError("Network request failed");
      },
    ],
  ])(
    "says nothing when a seen report fails otherwise (%s), and the card stays",
    async (_why, failure) => {
      api((call) => (call.path.endsWith("/seen") ? failure() : undefined));
      await show();
      expect(heading("Henna, 31")).toBeTruthy();
      expect(screen.queryByText("That card is no longer available.")).toBeNull();
    },
  );

  /**
   * The old day's card 1 waits on its seen report while a like finds the day
   * ended and the new day's round, with its own card 1, is read; then the
   * report answers.
   */
  const lateSeen = (late: () => Response) => {
    let answer = () => {};
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(reads === 1 ? ROUND : { day: NEXT_DAY, entries: [entry(1, "Riikka")] });
      }
      if (call.path === `/rounds/${DAY}/entries/1/seen`) {
        return new Promise<Response>((resolve) => {
          answer = () => resolve(late());
        });
      }
      if (call.path.startsWith(`/rounds/${DAY}/`) && call.path.endsWith("/decision")) {
        return refusal("round_expired", 409);
      }
      return undefined;
    });
    return { sent, answer: () => answer() };
  };

  it("changes nothing when a seen report finds its card gone after the day was read anew", async () => {
    const { sent, answer } = lateSeen(() => refusal("not_found", 404));
    await show();
    await press("Like");
    expect(heading("Riikka, 31")).toBeTruthy();
    await act(async () => answer());
    await settle();
    // The new day's card at the same place stays.
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });

  it("reads nothing more when a seen report finds the day ended after it was read anew", async () => {
    const { sent, answer } = lateSeen(() => refusal("round_expired", 409));
    await show();
    await press("Like");
    expect(heading("Riikka, 31")).toBeTruthy();
    await act(async () => answer());
    await settle();
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(screen.getByText("That round ended at midnight, so this was not saved.")).toBeTruthy();
    // Each read serves the cards again (ADR-008).
    expect(sent.reads()).toBe(2);
  });

  it.each([
    ["a like recorded", () => json({ match: null })],
    ["a like that made a match", () => json({ match: { conversationId: CONVERSATION } })],
    ["the day ended", () => refusal("round_expired", 409)],
    ["the card gone", () => refusal("not_found", 404)],
    ["a failure", () => refusal("internal", 500)],
  ])(
    "changes nothing of the new day's round when a decision answers after it was read: %s",
    async (_what, late) => {
      let expire = () => {};
      let answer = () => {};
      let reads = 0;
      const sent = api((call) => {
        if (call.path === "/rounds/today") {
          reads += 1;
          return json(
            reads === 1
              ? ROUND
              : { day: NEXT_DAY, entries: [entry(1, "Riikka"), entry(2, "Saara")] },
          );
        }
        if (call.path === `/rounds/${DAY}/entries/1/seen`) {
          return new Promise<Response>((resolve) => {
            expire = () => resolve(refusal("round_expired", 409));
          });
        }
        if (call.path === `/rounds/${DAY}/entries/1/decision`) {
          return new Promise<Response>((resolve) => {
            answer = () => resolve(late());
          });
        }
        return undefined;
      });
      await show();
      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: "Like" }));
      });
      await act(async () => expire());
      await settle();
      expect(heading("Riikka, 31")).toBeTruthy();
      await act(async () => answer());
      await settle();
      expect(heading("Riikka, 31")).toBeTruthy();
      expect(
        screen.getByText("Yesterday's round ended at midnight. This is today's."),
      ).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "It's a match" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
      expect(sent.reads()).toBe(2);
      // The new round goes on as it would have.
      await press("Like");
      expect(heading("Saara, 32")).toBeTruthy();
      expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${NEXT_DAY}/1 like`]);
    },
  );

  it("says that the day's likes are used up, and keeps the card for a pass", async () => {
    const sent = api((call) =>
      call.path.endsWith("/decision") && (call.body as { decision: string }).decision === "like"
        ? refusal("like_budget_exceeded", 429, { "retry-after": "3600" })
        : undefined,
    );
    await show();
    await press("Like");
    expect(
      screen.getByText(
        "You have used today's likes. New ones come after midnight; you can still pass.",
      ),
    ).toBeTruthy();
    expect(heading("Henna, 31")).toBeTruthy();
    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    // The notice was for the like; the pass that went through clears it.
    expect(screen.queryByText(/used today's likes/)).toBeNull();
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/1 pass`]);
  });

  it("says that the day's cards are used up instead of the round, with nothing to try again", async () => {
    api((call) =>
      call.path === "/rounds/today"
        ? refusal("card_budget_exceeded", 429, { "retry-after": "3600" })
        : undefined,
    );
    await show();
    expect(
      screen.getByText("You have seen many profiles today. New ones come after midnight."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["the API failed", () => refusal("internal", 500)],
    ["a gateway's page", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    [
      "the network",
      () => {
        throw new TypeError("Network request failed");
      },
    ],
  ])(
    "says a decision that did not go through (%s), and keeps the card for another try",
    async (_why, failure) => {
      let failed = false;
      const sent = api((call) => {
        if (call.path.endsWith("/decision") && !failed) {
          failed = true;
          return failure();
        }
        return undefined;
      });
      await show();
      await press("Like");
      expect(screen.getByText("That was not saved. Try again.")).toBeTruthy();
      expect(heading("Henna, 31")).toBeTruthy();
      await press("Like");
      expect(heading("Katja, 32")).toBeTruthy();
      expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/1 like`]);
    },
  );

  it.each([
    ["the API failed", () => refusal("internal", 500), "Kuutti's server had a problem."],
    [
      "the network",
      () => {
        throw new TypeError("Network request failed");
      },
      "Kuutti could not be reached.",
    ],
  ])(
    "says why the round did not load (%s), and reads it again on Try again",
    async (_why, failure, why) => {
      let reads = 0;
      api((call) => {
        if (call.path !== "/rounds/today") return undefined;
        reads += 1;
        return reads === 1 ? failure() : undefined;
      });
      await show();
      expect(screen.getByText("Today's round did not load.")).toBeTruthy();
      expect(screen.getByText(new RegExp(`^${why}`))).toBeTruthy();
      await press("Try again");
      expect(heading("Henna, 31")).toBeTruthy();
    },
  );

  it("takes one decision at a time: both buttons are dimmed while one is on its way", async () => {
    let release = () => {};
    const sent = api((call) =>
      call.path.endsWith("/decision")
        ? new Promise<Response>((resolve) => {
            release = () => resolve(json({ match: null }));
          })
        : undefined,
    );
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Like" }));
    });
    for (const name of ["Like", "Pass"]) {
      expect(screen.getByRole("button", { name }).props.accessibilityState).toMatchObject({
        disabled: true,
      });
    }
    // Nothing to take back while it is on its way.
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Pass" }));
    });
    await act(async () => release());
    await settle();
    expect(sent.decisions()).toEqual([`${DAY}/1 like`]);
    expect(heading("Katja, 32")).toBeTruthy();
  });

  it("offers no block or report while a decision is on its way, so none races it (ADR-030 §11)", async () => {
    let release = () => {};
    api((call) =>
      call.path.endsWith("/decision")
        ? new Promise<Response>((resolve) => {
            release = () => resolve(json({ match: null }));
          })
        : undefined,
    );
    await show();
    expect(screen.getByRole("button", { name: "Block or report" })).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Like" }));
    });
    // Neither the button beside the name nor the name's own action.
    expect(screen.queryByRole("button", { name: "Block or report" })).toBeNull();
    expect(heading("Henna, 31").props.accessibilityActions).toBeUndefined();
    await act(async () => release());
    await settle();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block or report" })).toBeTruthy();
  });

  it("reads nothing more once the screen is left, even when a decision then finds the day ended", async () => {
    let release = () => {};
    const sent = api((call) =>
      call.path.endsWith("/decision")
        ? new Promise<Response>((resolve) => {
            release = () => resolve(refusal("round_expired", 409));
          })
        : undefined,
    );
    const view = await renderWithTheme(<RoundScreen />);
    await settle();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Like" }));
    });
    await view.rerender(underProviders(<View />));
    await act(async () => release());
    await settle();
    // A read would serve the cards again (ADR-008).
    expect(sent.reads()).toBe(1);
  });

  it("announces a notice on iOS, which has no live regions", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    api((call) => (call.path.endsWith("/decision") ? refusal("not_found", 404) : undefined));
    await show();
    await press("Like");
    expect(announced()).toEqual(["That card is no longer available."]);
  });

  it("leaves the announcing to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    api((call) => (call.path.endsWith("/decision") ? refusal("not_found", 404) : undefined));
    await show();
    await press("Like");
    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(announced()).toEqual([]);
  });

  it("keeps a notice in sight under the header, outside the scrolled card", async () => {
    api((call) => (call.path.endsWith("/decision") ? refusal("not_found", 404) : undefined));
    await show();
    await press("Like");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(ancestorsOf("That card is no longer available.")).not.toContain("RCTScrollView");
    // The card itself scrolls.
    expect(ancestorsOf("Matches your filters")).toContain("RCTScrollView");
  });

  it.each([
    [
      "the day's photos are used up",
      () => refusal("photo_budget_exceeded", 429),
      "That is enough photos for today. They load again after midnight.",
    ],
    ["any other refusal", () => refusal("not_found", 404), "The photo could not be shown."],
    [
      "a gateway's page, without the API's words",
      () => new Response("<html></html>", { status: 502 }),
      "The photo could not be shown.",
    ],
  ])("says under the card when its photo is refused: %s", async (_what, failure, words) => {
    const withPhoto = entry(1, "Henna", "liked_you");
    withPhoto.card.photos = [
      {
        id: PHOTO,
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1200,
        height: 1600,
        caption: null,
        description: null,
      },
    ];
    api((call) => (call.path.startsWith("/photos/") ? failure() : undefined), {
      day: DAY,
      entries: [withPhoto, entry(2, "Katja")],
    });
    await show();
    await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
    // The words are the card's: the next one starts without them.
    await press("Like");
    expect(screen.queryByText(words)).toBeNull();
  });

  it("keeps a photo's refusal to its day: the new day's card at the same place starts without it", async () => {
    const withPhoto = entry(1, "Henna", "liked_you");
    withPhoto.card.photos = [
      {
        id: PHOTO,
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        width: 1200,
        height: 1600,
        caption: null,
        description: null,
      },
    ];
    let reads = 0;
    api((call) => {
      if (call.path.startsWith("/photos/")) return refusal("not_found", 404);
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(
          reads === 1
            ? { day: DAY, entries: [withPhoto] }
            : { day: NEXT_DAY, entries: [entry(1, "Riikka")] },
        );
      }
      if (call.path.endsWith("/decision")) return refusal("round_expired", 409);
      return undefined;
    });
    await show();
    await waitFor(() => expect(screen.getByText("The photo could not be shown.")).toBeTruthy());
    await press("Like");
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(screen.queryByText("The photo could not be shown.")).toBeNull();
  });
});

describe("a round left open past midnight", () => {
  // After NOON: 0:30 in Finland on 21.10., and 23:00 on 20.10.
  const AFTER_MIDNIGHT = Date.parse("2026-10-20T21:30:00Z");
  const LATE_EVENING = Date.parse("2026-10-20T20:00:00Z");
  /** The first read is `first`; any later one is the next day's round. */
  const days = (first: RoundResponse) => {
    let reads = 0;
    return api((call) => {
      if (call.path !== "/rounds/today") return undefined;
      reads += 1;
      return json(reads === 1 ? first : { day: NEXT_DAY, entries: [entry(1, "Riikka")] });
    });
  };

  it.each([
    [
      "finished",
      [entry(1, "Henna", "liked_you", "like")],
      "That was today's round. The next one comes tomorrow.",
    ],
    ["empty", [], "There is nobody to show you today. Come back tomorrow."],
    ["not built", null, "Your round is not ready yet. Come back tomorrow."],
  ] as const)(
    "is read anew when the app comes back on the next day, and says so: %s",
    async (_what, entries, words) => {
      const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
      const sent = days({ day: DAY, entries: entries === null ? null : [...entries] });
      await show();
      expect(screen.getByText(words)).toBeTruthy();
      now.mockReturnValue(AFTER_MIDNIGHT);
      await appBecomes("background");
      expect(sent.reads()).toBe(1);
      await appBecomes("active");
      expect(
        screen.getByText("Yesterday's round ended at midnight. This is today's."),
      ).toBeTruthy();
      expect(heading("Riikka, 31")).toBeTruthy();
      expect(sent.reads()).toBe(2);
    },
  );

  it("is not read again when the app comes back on the same day", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    const sent = days({ day: DAY, entries: [entry(1, "Henna", "liked_you", "like")] });
    await show();
    now.mockReturnValue(LATE_EVENING);
    await appBecomes("active");
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
    // Each read serves the cards again (ADR-008).
    expect(sent.reads()).toBe(1);
  });

  it("is not read again when the phone's clock is still on the day before the API's", async () => {
    // The API's midnight has passed; the phone says 23:59 on 20.10.
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T20:59:00Z"));
    const sent = days({ day: NEXT_DAY, entries: [entry(1, "Henna", "liked_you", "like")] });
    await show();
    await appBecomes("active");
    // Its clock reaches the round's day.
    now.mockReturnValue(Date.parse("2026-10-20T21:00:30Z"));
    await appBecomes("active");
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("is read anew as it comes back from a conversation on the next day, never under it", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(reads === 1 ? ROUND : { day: NEXT_DAY, entries: [entry(1, "Riikka")] });
      }
      if (call.path === `/rounds/${DAY}/entries/1/decision`) {
        return json({ match: { conversationId: CONVERSATION } });
      }
      return undefined;
    });
    await show();
    await press("Like");
    await press("Go to the conversation");
    await act(async () => blurRound());
    now.mockReturnValue(AFTER_MIDNIGHT);
    await appBecomes("active");
    // Under the conversation, nothing is read and nothing reported seen.
    expect(sent.reads()).toBe(1);
    await act(async () => focusRound());
    await settle();
    expect(screen.getByText("Yesterday's round ended at midnight. This is today's.")).toBeTruthy();
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    // Henna's, then Riikka's; yesterday's next card never.
    expect(sent.seen()).toEqual([1, 1]);
  });
});

describe("where the decision buttons sit (#82)", () => {
  const KEY = "kuutti.preference.decisionButtons";
  const STRANGERS: RoundResponse = { day: DAY, entries: [entry(2, "Katja"), entry(4, "Minna")] };
  const CONTROLS = ["Undo your last decision", "Send a fish", "Pass", "Like"];
  /** The round's own controls, in the order a screen reader meets them. */
  const controls = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.props.accessibilityLabel as string)
      .filter((label) => CONTROLS.includes(label));
  const column = () => screen.queryByTestId("round-one-handed");
  /** Whether a control is inside the one-handed column. */
  const inColumn = (name: string) => {
    for (let node = screen.getByRole("button", { name }).parent; node; node = node.parent) {
      if (node.props.testID === "round-one-handed") return true;
    }
    return false;
  };
  const placed = async (choice: object | null) => {
    if (choice) store.set(KEY, JSON.stringify(choice));
    api(undefined, STRANGERS);
    await show();
    await settle();
  };

  it("places Pass at the left and Like at the right for the right hand, the default, with the fish above on the right", async () => {
    await placed(null);
    expect(controls()).toEqual(["Send a fish", "Pass", "Like"]);
    expect(column()).toBeNull();
    expect(screen.getByRole("button", { name: "Send a fish" }).props.className).toMatch(
      /\bself-end\b/,
    );
    await press("Pass");
    // Undo stays in the header, above the card, as before.
    expect(controls()).toEqual(["Undo your last decision", "Send a fish", "Pass", "Like"]);
    expect(inColumn("Undo your last decision")).toBe(false);
    noProblems();
  });

  // jest's window reports a font scale of 2; these set their own (#467).
  const atFontScale = (fontScale: number) =>
    jest.spyOn(Dimensions, "get").mockReturnValue({ width: 375, height: 812, scale: 3, fontScale });

  it.each([
    ["the default size", 1, true],
    ["just under 130 %", 1.29, true],
    ["130 %", 1.3, false],
    // What Android sends: its scale is a float (1.2999999523).
    ["130 % as Android sends it", Math.fround(1.3), false],
    ["iOS's largest standard size", 1.353, false],
    ["the app's largest", 2, false],
  ] as const)(
    "draws Undo in the header at %s (x%s) with its word: %s, and always with its label and target",
    async (_size, fontScale, worded) => {
      atFontScale(fontScale);
      await placed(null);
      await press("Pass");
      const undo = screen.getByRole("button", { name: "Undo your last decision" });
      expect(within(undo).queryByText("Undo") !== null).toBe(worded);
      expect(undo.props.className).toMatch(worded ? /\bpx-5\b/ : /(^| )p-2( |$)/);
      expect(inColumn("Undo your last decision")).toBe(false);
      noProblems();
      await press("Undo your last decision");
      expect(heading("Katja, 32")).toBeTruthy();
    },
  );

  it("keeps Undo's word one-handed at the largest text, where it has the thumb's room", async () => {
    atFontScale(2);
    await placed({ oneHanded: true });
    await press("Pass");
    const undo = screen.getByRole("button", { name: "Undo your last decision" });
    expect(inColumn("Undo your last decision")).toBe(true);
    expect(within(undo).getByText("Undo")).toBeTruthy();
  });

  it("mirrors them for the left hand: Like at the left, Pass at the right, the fish on the left", async () => {
    await placed({ hand: "left" });
    expect(controls()).toEqual(["Send a fish", "Like", "Pass"]);
    expect(screen.getByRole("button", { name: "Send a fish" }).props.className).toMatch(
      /\bself-start\b/,
    );
    // Each keeps its own shape: Like the pill, Pass the rectangle.
    expect(screen.getByRole("button", { name: "Like" }).props.className).toMatch(
      /\brounded-full\b/,
    );
    expect(screen.getByRole("button", { name: "Pass" }).props.className).toMatch(/\brounded-md\b/);
    noProblems();
  });

  it.each([
    ["right", /\bself-end\b/],
    ["left", /\bself-start\b/],
  ] as const)(
    "puts Undo, the fish, Pass and Like in one column on the %s, one-handed, Undo down from the header",
    async (hand, side) => {
      await placed({ hand, oneHanded: true });
      expect(column()?.props.className).toMatch(side);
      expect(controls()).toEqual(["Send a fish", "Pass", "Like"]);
      await press("Pass");
      expect(controls()).toEqual(["Undo your last decision", "Send a fish", "Pass", "Like"]);
      for (const name of CONTROLS) expect(inColumn(name)).toBe(true);
      noProblems();
      // And it still undoes.
      await press("Undo your last decision");
      expect(heading("Katja, 32")).toBeTruthy();
    },
  );

  it.each([
    ["right", /\bself-end\b/],
    ["left", /\bself-start\b/],
  ] as const)(
    "keeps Undo at the thumb on the %s, one-handed, after the round's last decision, and it still takes it back",
    async (hand, side) => {
      store.set(KEY, JSON.stringify({ hand, oneHanded: true }));
      api(undefined, { day: DAY, entries: [entry(2, "Katja")] });
      await show();
      await settle();
      await press("Pass");
      expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
      expect(controls()).toEqual(["Undo your last decision"]);
      expect(inColumn("Undo your last decision")).toBe(true);
      expect(column()?.props.className).toMatch(side);
      noProblems();
      await press("Undo your last decision");
      expect(heading("Katja, 32")).toBeTruthy();
      expect(
        screen.getByText("You passed on this person. You can change that until midnight."),
      ).toBeTruthy();
    },
  );

  it("shows no Undo, one-handed, at a round's end with nothing to take back", async () => {
    store.set(KEY, JSON.stringify({ oneHanded: true }));
    api(undefined, { day: DAY, entries: [entry(2, "Katja", "matches_filters", "pass")] });
    await show();
    await settle();
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
    expect(controls()).toEqual([]);
    expect(column()).toBeNull();
  });

  it("leaves the fish out of the column on a card that answers a like", async () => {
    store.set(KEY, JSON.stringify({ oneHanded: true }));
    api(undefined, { day: DAY, entries: [entry(1, "Henna", "liked_you")] });
    await show();
    await settle();
    expect(controls()).toEqual(["Pass", "Like"]);
    expect(inColumn("Like")).toBe(true);
  });
});

describe("the short pool (#99, ADR-042)", () => {
  const RELAXATIONS = `/rounds/${DAY}/relaxations`;
  const offered = {
    short: true,
    offers: [
      { field: "smoking", kind: "unanswered", more: 10 },
      { field: "smoking", kind: "aside", more: 0 },
    ],
    relaxed: [],
  };
  const EMPTY: RoundResponse = { day: DAY, entries: [] };
  const relaxedCard: RoundEntry = { ...entry(5, "Liisa", "relaxed"), relaxedField: "smoking" };
  const INCLUDE = "Include those who did not answer: Smoking. About 10 more people";
  const ASIDE = "Set aside for today: Smoking. A few more people";

  it("offers to relax a deal-breaker for today at the end of a short round, with the pool's growth in steps", async () => {
    const sent = api((call) => (call.path === RELAXATIONS ? json(offered) : undefined), EMPTY);
    await show();
    expect(screen.getByText("There is nobody to show you today. Come back tomorrow.")).toBeTruthy();
    expect(heading("Few people today")).toBeTruthy();
    expect(screen.getByRole("button", { name: INCLUDE })).toBeTruthy();
    expect(screen.getByRole("button", { name: ASIDE })).toBeTruthy();
    noProblems();
    // Reading the offers relaxes nothing.
    expect(sent.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("adds the relaxation's cards after the last on a tap, the first on the screen with its deal-breaker named", async () => {
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return json({ entries: [relaxedCard] });
      return undefined;
    }, EMPTY);
    await show();

    await press(INCLUDE);

    expect(sent.calls.find((c) => c.method === "POST" && c.path === RELAXATIONS)?.body).toEqual({
      field: "smoking",
      kind: "unanswered",
    });
    expect(heading("Liisa, 35")).toBeTruthy();
    expect(screen.getByText("Relaxed for today: Smoking")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo for today: Smoking" })).toBeTruthy();
    noProblems();
    expect(sent.reads()).toBe(1);
  });

  it("takes back the relaxation's undecided cards with one tap on a relaxed card", async () => {
    let relaxed = false;
    const sent = api(
      (call) => {
        if (call.path === RELAXATIONS) {
          // An undo gives no room back (ADR-042 §5): nothing more is offered today.
          return json(
            relaxed
              ? { short: false, offers: [], relaxed: [] }
              : { short: true, offers: [], relaxed: [{ field: "smoking", kind: "unanswered" }] },
          );
        }
        if (call.path === `${RELAXATIONS}/smoking` && call.method === "DELETE") {
          relaxed = true;
          return json({ removed: [5] });
        }
        return undefined;
      },
      { day: DAY, entries: [entry(1, "Henna", "matches_filters", "like"), relaxedCard] },
    );
    await show();
    expect(heading("Liisa, 35")).toBeTruthy();

    await press("Undo for today: Smoking");

    expect(screen.queryByRole("heading", { name: "Liisa, 35" })).toBeNull();
    expect(screen.getByText("That was today's round. The next one comes tomorrow.")).toBeTruthy();
    // The panel read again, and has nothing more to offer.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo for today: Smoking" })).toBeNull(),
    );
    expect(screen.queryByRole("heading", { name: "Few people today" })).toBeNull();
    expect(sent.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      `${RELAXATIONS}/smoking`,
    ]);
  });

  it("undoes a relaxation from the panel, where nothing it brought is left undecided", async () => {
    let undone = false;
    const sent = api((call) => {
      if (call.path === RELAXATIONS) {
        // Another deal-breaker is still offered: the undone one's places stay given, kids' room is left.
        return json(
          undone
            ? { short: true, offers: [{ field: "hasKids", kind: "aside", more: 10 }], relaxed: [] }
            : { short: true, offers: [], relaxed: [{ field: "smoking", kind: "aside" }] },
        );
      }
      if (call.method === "DELETE") {
        undone = true;
        return json({ removed: [] });
      }
      return undefined;
    }, EMPTY);
    await show();
    expect(screen.queryByRole("heading", { name: "Few people today" })).toBeNull();

    await press("Undo for today: Smoking");

    await waitFor(() => expect(heading("Few people today")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Undo for today: Smoking" })).toBeNull();
    expect(sent.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("names on a card the deal-breakers its person did not answer", async () => {
    api(undefined, {
      day: DAY,
      entries: [{ ...entry(1, "Henna"), notAnswered: ["smoking", "languages"] }],
    });
    await show();
    expect(screen.getByText("Did not answer: Smoking")).toBeTruthy();
    expect(screen.getByText("Did not answer: Languages")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Undo for today/ })).toBeNull();
  });

  it.each([
    ["found nobody after all", () => json({ entries: [] }), "Nobody new to show today after all."],
    [
      "was made already",
      () => refusal("already_relaxed", 409),
      "You relaxed that one for today already.",
    ],
    [
      "used up the day's cards",
      () => refusal("card_budget_exceeded", 429, { "retry-after": "600" }),
      "You have seen many profiles today. New ones come after midnight.",
    ],
    ["failed", () => refusal("internal_error", 500), "That did not go through. Try again."],
  ])("says when a relaxation %s, and offers what is left", async (_case, answer, words) => {
    api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return answer();
      return undefined;
    }, EMPTY);
    await show();

    await press(INCLUDE);

    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByRole("button", { name: INCLUDE })).toBeTruthy();
  });

  it("reads the round anew when a relaxation finds that the day ended", async () => {
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return refusal("round_expired", 409);
      return undefined;
    }, EMPTY);
    await show();

    await press(INCLUDE);

    expect(sent.reads()).toBe(2);
    expect(screen.getByText("That round ended at midnight, so this was not saved.")).toBeTruthy();
  });

  it.each([
    ["is not short", () => json({ short: false, offers: [], relaxed: [] })],
    ["cannot be read", () => refusal("internal_error", 500)],
  ])("shows no panel when the round %s", async (_case, answer) => {
    api((call) => (call.path === RELAXATIONS ? answer() : undefined), EMPTY);
    await show();
    expect(screen.getByText("There is nobody to show you today. Come back tomorrow.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Few people today" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Smoking/ })).toEqual([]);
  });
});

describe("undoing a relaxation from a card (#99, ADR-042 §6)", () => {
  const RELAXATIONS = `/rounds/${DAY}/relaxations`;
  const relaxedCard: RoundEntry = { ...entry(5, "Liisa", "relaxed"), relaxedField: "smoking" };
  const round = (decision: RoundEntry["decision"] = null): RoundResponse => ({
    day: DAY,
    entries: [entry(1, "Henna", "matches_filters", "like"), { ...relaxedCard, decision }],
  });

  it.each([
    [
      "the day ended",
      () => refusal("round_expired", 409),
      "That round ended at midnight, so this was not saved.",
    ],
    ["it failed", () => refusal("internal_error", 500), "That did not go through. Try again."],
  ])("keeps the card and says so when %s", async (what, answer, words) => {
    const sent = api((call) => {
      if (call.method === "DELETE") return answer();
      if (call.path === RELAXATIONS) return json({ short: false, offers: [], relaxed: [] });
      return undefined;
    }, round());
    await show();

    await press("Undo for today: Smoking");

    expect(screen.getByText(words)).toBeTruthy();
    if (what === "the day ended") expect(sent.reads()).toBe(2);
    else expect(heading("Liisa, 35")).toBeTruthy();
  });

  it("offers no undo on a relaxed card already decided, which Undo brought back", async () => {
    api(
      (call) =>
        call.path === RELAXATIONS ? json({ short: false, offers: [], relaxed: [] }) : undefined,
      { day: DAY, entries: [{ ...relaxedCard }, entry(6, "Saara")] },
    );
    await show();
    await press("Like");
    await press("Undo your last decision");
    expect(heading("Liisa, 35")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo for today: Smoking" })).toBeNull();
  });

  it("says that the day's relaxations changed on another device, and offers what is left", async () => {
    api(
      (call) => {
        if (call.path === RELAXATIONS && call.method === "GET") {
          return json({
            short: true,
            offers: [{ field: "smoking", kind: "aside", more: 10 }],
            relaxed: [],
          });
        }
        if (call.path === RELAXATIONS) return refusal("relaxations_changed", 409);
        return undefined;
      },
      { day: DAY, entries: [] },
    );
    await show();

    await press("Set aside for today: Smoking. About 10 more people");

    expect(
      screen.getByText("Your relaxations for today changed meanwhile. Look again and choose."),
    ).toBeTruthy();
  });
});
