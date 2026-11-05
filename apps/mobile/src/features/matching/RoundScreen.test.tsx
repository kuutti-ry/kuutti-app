import type { ProfileCard, RoundEntry, RoundResponse } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, AppState, Dimensions, Platform, StyleSheet, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { TOUCH_TARGET } from "@/theme/a11y";
import { RoundScreen } from "./RoundScreen";
import { FAILED_TO_LOAD } from "@/test/failed";

// The queue on the phone (#379, #502, ADR-034, ADR-062): one card at a time
// with its reason, like, pass and Later as buttons, Undo on the last decision,
// a match that leads to the conversation, block or report from the card, the
// next read once no card is left, the queue's end and a queue not open in their
// own words, the way into What you seek, and every refusal of the routes said:
// a day that ended, a card gone, the day's likes and cards used up, a like that
// made a match, too many conversations waiting. The likes left are said beside
// the buttons, and a fish, which counts in them, goes while one is left, or on a
// card already liked (#503). A new day is never touched by the old day's answers,
// and a queue left open past midnight is read anew.

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
    place: null,
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
): RoundEntry => ({
  position,
  reason,
  decision,
  card: card(position, name),
  distance: null,
  star: null,
});

const ROUND: RoundResponse = {
  day: DAY,
  entries: [entry(1, "Henna", "liked_you"), entry(2, "Katja"), entry(4, "Minna", "seen_before")],
  fishToSend: true,
  likesLeft: 10,
  yourTurn: 0,
};

type Call = { method: string; path: string; body: unknown };
type Answer = (call: Call) => Response | Promise<Response> | undefined;
/**
 * The API as the screen sees it: `answer` first, then the defaults (the first
 * read `round` and any later one the queue's end, a seen recorded, a decision
 * with no match, a block done).
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
    if (call.path === "/rounds/today") {
      const first = calls.filter((c) => c.path === "/rounds/today").length === 1;
      return json(first ? round : { ...round, entries: [] });
    }
    if (call.path.endsWith("/seen")) return noContent();
    if (call.path.endsWith("/decision"))
      return json({ match: null, fishToSend: true, likesLeft: 10, yourTurn: 0 });
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
/** Every line that speaks by itself where it appears, a notice above the card among them. */
const liveLines = () =>
  screen
    .queryAllByText(/./)
    .filter((node) => node.props.accessibilityLiveRegion === "polite")
    .map((node) => node.props.children);
/** Everything the screen draws, in order, so that what a state leaves out is seen to be left out. */
const said = (node: HostNode | string = screen.toJSON() as HostNode): string[] =>
  typeof node === "string" ? [node] : (node.children ?? []).flatMap((child) => said(child));
/** The words inside a component or an element: a line's own, or a button's. */
const wordsIn = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(wordsIn);
  const { props } = (node ?? {}) as { props?: { children?: unknown } };
  return props ? wordsIn(props.children) : [];
};
/** What the screen reader was last taken to, by its role and its words. */
const takenTo = () => {
  const [node, event] = (AccessibilityInfo.sendAccessibilityEvent as jest.Mock).mock.calls.at(
    -1,
  ) as [{ props: { accessibilityRole?: string } }, string];
  return { event, role: node.props.accessibilityRole, words: wordsIn(node) };
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

describe("the queue", () => {
  it("shows one card at a time in the queue's order, each with its reason, and decides each with a button", async () => {
    const sent = api();
    await show();
    expect(heading("People")).toBeTruthy();
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

    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/2 pass`, `${DAY}/4 pass`]);
    // Each card reported itself seen once, as it came on the screen.
    expect(sent.seen()).toEqual([1, 2, 4]);
    // Only the read past the last card finds the end.
    expect(sent.reads()).toBe(2);
    // The screen reader is taken to each card's first line, and to the end.
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledTimes(4);
  });

  it("goes back home with the header's arrow", async () => {
    api();
    await show();
    await press("Back to home");
    expect(router.back).toHaveBeenCalled();
  });

  it("takes an answer with nothing undecided in it for the queue's end, so that no answer can read on by itself", async () => {
    const sent = api(undefined, {
      day: DAY,
      entries: [entry(1, "Henna", "liked_you", "like")],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it.each([
    ["the queue's end", [], "That's everybody for now.", 1],
    ["a queue not open", null, "There is nobody to show you yet.", 0],
  ] as const)(
    "says %s in its own words, with no card and no button to decide",
    async (_what, entries, words, ways) => {
      const sent = api(undefined, {
        day: DAY,
        entries: entries === null ? null : [...entries],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      });
      await show();
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
      expect(sent.seen()).toEqual([]);
      expect(sent.reads()).toBe(1);
      // Only the end has somewhere to go: the same one way for everybody.
      expect(screen.queryAllByRole("button", { name: "What you seek" })).toHaveLength(ways);
      noProblems();
    },
  );

  it("reads the queue again when a decision finds that the day ended, and says so", async () => {
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(
          reads === 1
            ? ROUND
            : {
                day: NEXT_DAY,
                entries: [entry(1, "Riikka")],
                fishToSend: true,
                likesLeft: 10,
                yourTurn: 0,
              },
        );
      }
      if (call.path.startsWith(`/rounds/${DAY}/`) && call.path.endsWith("/decision")) {
        return refusal("round_expired", 409);
      }
      return undefined;
    });
    await show();
    await press("Like");
    expect(screen.getByText("That day ended at midnight, so this was not saved.")).toBeTruthy();
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    expect(sent.seen()).toEqual([1, 1]);
  });

  it("reads the queue again when a card's seen report finds that the day ended, with no word, the reader taken to the new card (#581)", async () => {
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(
          reads === 1
            ? ROUND
            : {
                day: NEXT_DAY,
                entries: [entry(1, "Riikka")],
                fishToSend: true,
                likesLeft: 10,
                yourTurn: 0,
              },
        );
      }
      if (call.path === `/rounds/${DAY}/entries/1/seen`) return refusal("round_expired", 409);
      return undefined;
    });
    await show();
    await settle();
    // Nothing was lost: the next card is simply there.
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(liveLines()).toEqual([]);
    expect(announced()).toEqual([]);
    expect(takenTo()).toEqual({ event: "focus", words: ["Matches your filters"] });
    expect(sent.reads()).toBe(2);
  });

  it("says that liking back a liked-you card is a match, and leads to the conversation", async () => {
    // Back from the conversation on the round's own day, which reads nothing anew.
    jest.spyOn(Date, "now").mockReturnValue(NOON);
    const sent = api((call) =>
      call.path === `/rounds/${DAY}/entries/1/decision`
        ? json({
            match: { conversationId: CONVERSATION },
            fishToSend: true,
            likesLeft: 10,
            yourTurn: 0,
          })
        : undefined,
    );
    await show();
    await press("Like");
    expect(heading("It's a match")).toBeTruthy();
    // Its title and two buttons say what happened and what is open (#581).
    expect(said()).toEqual(["People", "It's a match", "Go to the conversation", "Back to people"]);
    expect(takenTo()).toEqual({ event: "focus", words: ["It's a match"] });
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

  it("goes on with the queue from a match without opening the conversation", async () => {
    api((call) =>
      call.path.endsWith("/decision")
        ? json({
            match: { conversationId: CONVERSATION },
            fishToSend: true,
            likesLeft: 10,
            yourTurn: 0,
          })
        : undefined,
    );
    await show();
    await press("Like");
    await press("Back to people");
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
    const sent = api(undefined, {
      day: DAY,
      entries: [entry(2, "Katja"), entry(4, "Minna")],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
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
    ["liked the reader", 10, "liked_you", "Liked you"],
    ["liked the reader", 1, "liked_you", "Liked you"],
    ["liked the reader", 0, "liked_you", "Liked you"],
    ["sent the reader a fish", 10, "fish", "Sent you a fish"],
    ["sent the reader a fish", 1, "fish", "Sent you a fish"],
    ["sent the reader a fish", 0, "fish", "Sent you a fish"],
  ] as const)(
    "offers no fish on a card that %s, which a like answers, at %i likes left (ADR-039 §2)",
    async (_what, likesLeft, reason, label) => {
      api(undefined, {
        day: DAY,
        entries: [entry(1, "Henna", reason)],
        fishToSend: true,
        likesLeft,
        yourTurn: 0,
      });
      await show();
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Like" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Send a fish" })).toBeNull();
    },
  );

  it("offers no fish once the week's is sent, and says nothing of the next (#475)", async () => {
    api(undefined, {
      day: DAY,
      entries: [entry(2, "Katja"), entry(4, "Minna")],
      fishToSend: false,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    const buttons = screen
      .getAllByRole("button")
      .map((button) => button.props.accessibilityLabel)
      .filter((label) => ["Send a fish", "Pass", "Like"].includes(label));
    expect(buttons).toEqual(["Pass", "Like"]);
    expect(screen.queryByText(/fish/i)).toBeNull();
    noProblems();
  });

  it("takes the fish away once it is sent, and gives it back when that card's fish becomes a like (#475)", async () => {
    let fishSent = false;
    const sent = api(
      (call) => {
        if (!call.path.endsWith("/decision")) return undefined;
        fishSent = (call.body as { decision: string }).decision === "fish";
        return json({ match: null, fishToSend: !fishSent, likesLeft: 10, yourTurn: 0 });
      },
      {
        day: DAY,
        entries: [entry(2, "Katja"), entry(4, "Minna")],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      },
    );
    await show();
    await press("Send a fish");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a fish" })).toBeNull();
    noProblems();
    // The card that holds the fish reads it back, selected, and it can be changed.
    await press("Undo your last decision");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send a fish" }).props.accessibilityState,
    ).toMatchObject({ selected: true });
    await press("Like");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send a fish" })).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/2 fish`, `${DAY}/2 like`]);
  });

  it("takes the fish away when another phone sent the week's meanwhile, and keeps the card for a like", async () => {
    api(
      (call) =>
        call.path.endsWith("/decision") && (call.body as { decision: string }).decision === "fish"
          ? refusal("fish_budget_exceeded", 429, { "retry-after": "43200" })
          : undefined,
      { day: DAY, entries: [entry(2, "Katja")], fishToSend: true, likesLeft: 10, yourTurn: 0 },
    );
    await show();
    await press("Send a fish");
    expect(screen.getByText("You cannot send a fish just now.")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a fish" })).toBeNull();
    await press("Like");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
  });

  it.each([
    ["fi-FI", "Lähetä kala", "Et voi lähettää kalaa juuri nyt."],
    ["sv-FI", "Skicka en fisk", "Du kan inte skicka en fisk just nu."],
  ])(
    "says a fish that cannot go in %s, in the fewest words (#581)",
    async (languageTag, fish, words) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
      api(
        (call) =>
          call.path.endsWith("/decision") ? refusal("fish_budget_exceeded", 429) : undefined,
        { day: DAY, entries: [entry(2, "Katja")], fishToSend: true, likesLeft: 10, yourTurn: 0 },
      );
      await show();
      await press(fish);
      expect(screen.getByText(words)).toBeTruthy();
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

  it("blocks from a card, and the card leaves the screen (ADR-030 §11)", async () => {
    const sent = api();
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Block or report" }));
    });
    await press("Block");
    await press("Block");
    await screen.findByText("Blocked.");
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
        return json(
          reads === 1
            ? ROUND
            : {
                day: NEXT_DAY,
                entries: [entry(1, "Riikka")],
                fishToSend: true,
                likesLeft: 10,
                yourTurn: 0,
              },
        );
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
    expect(screen.getByText("That day ended at midnight, so this was not saved.")).toBeTruthy();
    // Each read serves the cards again (ADR-008).
    expect(sent.reads()).toBe(2);
  });

  it.each([
    ["a like recorded", () => json({ match: null, fishToSend: true, likesLeft: 10, yourTurn: 0 })],
    [
      "a like that made a match",
      () =>
        json({
          match: { conversationId: CONVERSATION },
          fishToSend: true,
          likesLeft: 10,
          yourTurn: 0,
        }),
    ],
    ["the day ended", () => refusal("round_expired", 409)],
    ["the card gone", () => refusal("not_found", 404)],
    ["a failure", () => refusal("internal", 500)],
  ])(
    "changes nothing of the new day when a decision answers after it was read: %s",
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
              : {
                  day: NEXT_DAY,
                  entries: [entry(1, "Riikka"), entry(2, "Saara")],
                  fishToSend: true,
                  likesLeft: 10,
                  yourTurn: 0,
                },
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
      // Not a word of the old day's answer, whatever it says.
      expect(liveLines()).toEqual([]);
      expect(screen.queryByRole("heading", { name: "It's a match" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
      expect(sent.reads()).toBe(2);
      // The new day goes on as it would have.
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

  it("says that the day's cards are used up instead of the queue, with nothing to try again", async () => {
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
      expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
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
    "says why the queue did not load (%s), and reads it again on Try again",
    async (_why, failure, why) => {
      let reads = 0;
      api((call) => {
        if (call.path !== "/rounds/today") return undefined;
        reads += 1;
        return reads === 1 ? failure() : json(ROUND);
      });
      await show();
      expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
      expect(screen.getByText(new RegExp(`^${why}`))).toBeTruthy();
      await press("Try again");
      expect(heading("Henna, 31")).toBeTruthy();
    },
  );

  it("takes one decision at a time: every button is dimmed while one is on its way", async () => {
    let release = () => {};
    const sent = api((call) =>
      call.path.endsWith("/decision")
        ? new Promise<Response>((resolve) => {
            release = () =>
              resolve(json({ match: null, fishToSend: true, likesLeft: 10, yourTurn: 0 }));
          })
        : undefined,
    );
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Like" }));
    });
    for (const name of ["Like", "Pass", "Later"]) {
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
            release = () =>
              resolve(json({ match: null, fishToSend: true, likesLeft: 10, yourTurn: 0 }));
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
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
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
            ? { day: DAY, entries: [withPhoto], fishToSend: true, likesLeft: 10, yourTurn: 0 }
            : {
                day: NEXT_DAY,
                entries: [entry(1, "Riikka")],
                fishToSend: true,
                likesLeft: 10,
                yourTurn: 0,
              },
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

describe("a queue left open past midnight", () => {
  // After NOON: 0:30 in Finland on 21.10., and 23:00 on 20.10.
  const AFTER_MIDNIGHT = Date.parse("2026-10-20T21:30:00Z");
  const LATE_EVENING = Date.parse("2026-10-20T20:00:00Z");
  /** The first read is `first`; any later one is the next day's queue. */
  const days = (first: RoundResponse) => {
    let reads = 0;
    return api((call) => {
      if (call.path !== "/rounds/today") return undefined;
      reads += 1;
      return json(
        reads === 1
          ? first
          : {
              day: NEXT_DAY,
              entries: [entry(1, "Riikka")],
              fishToSend: true,
              likesLeft: 10,
              yourTurn: 0,
            },
      );
    });
  };

  it.each([
    ["with a card on the screen", [entry(1, "Henna", "liked_you")], "Henna, 31"],
    ["at its end", [], "That's everybody for now."],
    ["not open", null, "There is nobody to show you yet."],
  ] as const)(
    "is read anew when the app comes back on the next day, with no word, the reader taken to the new card: %s (#581)",
    async (_what, entries, words) => {
      const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
      const sent = days({
        day: DAY,
        entries: entries === null ? null : [...entries],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      });
      await show();
      expect(screen.getByText(words)).toBeTruthy();
      now.mockReturnValue(AFTER_MIDNIGHT);
      await appBecomes("background");
      expect(sent.reads()).toBe(1);
      await appBecomes("active");
      expect(heading("Riikka, 31")).toBeTruthy();
      expect(liveLines()).toEqual([]);
      expect(announced()).toEqual([]);
      expect(takenTo()).toEqual({ event: "focus", words: ["Matches your filters"] });
      expect(sent.reads()).toBe(2);
    },
  );

  it("takes what the old day's card had to say away with it (#581)", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    const reads = reading(page(entry(1, "Henna")), { ...page(entry(1, "Riikka")), day: NEXT_DAY });
    api((call) =>
      call.path.endsWith("/decision")
        ? refusal("like_budget_exceeded", 429, { "retry-after": "3600" })
        : reads(call),
    );
    await show();
    await press("Like");
    expect(liveLines()).toEqual([
      "You have used today's likes. New ones come after midnight; you can still pass.",
    ]);
    now.mockReturnValue(AFTER_MIDNIGHT);
    await appBecomes("active");
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(liveLines()).toEqual([]);
  });

  it("is not read again when the app comes back on the same day with a card on the screen", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    const sent = days({
      day: DAY,
      entries: [entry(1, "Henna", "liked_you")],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    now.mockReturnValue(LATE_EVENING);
    await appBecomes("active");
    expect(heading("Henna, 31")).toBeTruthy();
    // Each read serves the cards again (ADR-008).
    expect(sent.reads()).toBe(1);
  });

  it("is not read again when the phone's clock is still on the day before the API's", async () => {
    // The API's midnight has passed; the phone says 23:59 on 20.10.
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T20:59:00Z"));
    const sent = days({
      day: NEXT_DAY,
      entries: [entry(1, "Henna", "liked_you")],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    await appBecomes("active");
    // Its clock reaches the round's day.
    now.mockReturnValue(Date.parse("2026-10-20T21:00:30Z"));
    await appBecomes("active");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("is read anew as it comes back from a conversation on the next day, never under it", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    let reads = 0;
    const sent = api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return json(
          reads === 1
            ? ROUND
            : {
                day: NEXT_DAY,
                entries: [entry(1, "Riikka")],
                fishToSend: true,
                likesLeft: 10,
                yourTurn: 0,
              },
        );
      }
      if (call.path === `/rounds/${DAY}/entries/1/decision`) {
        return json({
          match: { conversationId: CONVERSATION },
          fishToSend: true,
          likesLeft: 10,
          yourTurn: 0,
        });
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
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(liveLines()).toEqual([]);
    expect(sent.reads()).toBe(2);
    // Henna's, then Riikka's; yesterday's next card never.
    expect(sent.seen()).toEqual([1, 1]);
  });
});

/** 9:00 in Finland on NEXT_DAY. */
const NEXT_MORNING = Date.parse("2026-10-21T06:00:00Z");
const BUDGETS = { fishToSend: true, likesLeft: 10, yourTurn: 0 };
/** A read of the day, these cards in it. */
const page = (...entries: RoundEntry[]): RoundResponse => ({ day: DAY, entries, ...BUDGETS });
type Read = RoundResponse | (() => Response | Promise<Response>);
/** The API's reads, these in turn and then the queue's end. */
const reading = (...reads: Read[]): Answer => {
  const left = [...reads];
  return (call) => {
    if (call.path !== "/rounds/today") return undefined;
    const read = left.shift() ?? page();
    return typeof read === "function" ? read() : json(read);
  };
};
/** A read that waits until the test answers it. */
const waiting = () => {
  let answer: (response: Response) => void = () => {};
  const read = () =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    });
  return { read, answer: (response: Response) => act(async () => answer(response)) };
};

describe("reading on past the last card (ADR-062 §1)", () => {
  it("reads the next cards once no card is left, and goes on with them by place", async () => {
    const sent = api(reading(page(entry(5, "Henna")), page(entry(7, "Katja"), entry(2, "Minna"))));
    await show();
    expect(sent.reads()).toBe(1);
    await press("Pass");
    // A card that fits again has its old place, before the last one read.
    expect(heading("Minna, 32")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    await press("Pass");
    expect(heading("Katja, 37")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    await press("Pass");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(sent.reads()).toBe(3);
    expect(sent.seen()).toEqual([5, 2, 7]);
  });

  it("takes each read's budgets and turn, as it takes each decision's", async () => {
    const next = { ...page(entry(2, "Katja")), fishToSend: false, likesLeft: 3 };
    api(reading(page(entry(1, "Henna")), next));
    await show();
    expect(screen.getByRole("button", { name: "Send a fish" })).toBeTruthy();
    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.getByText("3 likes left today")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a fish" })).toBeNull();
  });

  it("keeps Undo's last card through the read, and a change of it goes on to the next card", async () => {
    const sent = api(reading(page(entry(1, "Henna")), page(entry(2, "Katja"))));
    await show();
    await press("Like");
    expect(heading("Katja, 32")).toBeTruthy();
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(
      screen.getByText("You liked this person. You can change that until midnight."),
    ).toBeTruthy();
    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/1 pass`]);
  });

  it("says it is loading while the read runs, and the end only once the read is empty", async () => {
    const next = waiting();
    const sent = api(reading(page(entry(1, "Henna")), next.read));
    await show();
    await press("Pass");
    expect(screen.getByText("Loading…").props.accessibilityLiveRegion).toBe("polite");
    noProblems();
    expect(screen.queryByText("That's everybody for now.")).toBeNull();
    expect(screen.queryByRole("button", { name: "What you seek" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
    // The offers are the end's, so nothing asks for them yet.
    expect(sent.calls.filter((c) => c.path.endsWith("/relaxations"))).toEqual([]);
    await next.answer(json(page()));
    await settle();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(sent.calls.filter((c) => c.path.endsWith("/relaxations"))).toHaveLength(1);
  });

  it("brings Undo's card back while the read is on its way, and its cards wait behind it", async () => {
    const next = waiting();
    api(reading(page(entry(1, "Henna")), next.read));
    await show();
    await press("Pass");
    expect(screen.getByText("Loading…")).toBeTruthy();
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    await next.answer(json(page(entry(2, "Katja"))));
    await settle();
    expect(heading("Henna, 31")).toBeTruthy();
    await press("Like");
    expect(heading("Katja, 32")).toBeTruthy();
  });

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
    "says a read that failed (%s), asks again on Try again, and keeps Undo's card",
    async (_why, failure, why) => {
      const sent = api(reading(page(entry(1, "Henna")), failure, page(entry(2, "Katja"))));
      await show();
      await press("Like");
      expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
      expect(screen.getByText(new RegExp(`^${why}`))).toBeTruthy();
      expect(screen.queryByText("That's everybody for now.")).toBeNull();
      noProblems();
      await press("Try again");
      expect(heading("Katja, 32")).toBeTruthy();
      expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
      expect(sent.reads()).toBe(3);
      await press("Undo your last decision");
      expect(heading("Henna, 31")).toBeTruthy();
    },
  );

  it.each([
    ["ios", ["Loading…"]],
    ["android", []],
  ] as const)(
    "says a read past the last card aloud on %s, and not the first read of the screen",
    async (os, said) => {
      jest.replaceProperty(Platform, "OS", os);
      const next = waiting();
      api(reading(page(entry(1, "Henna")), next.read));
      await show();
      expect(announced()).toEqual([]);
      await press("Pass");
      expect(screen.getByText("Loading…")).toBeTruthy();
      expect(announced()).toEqual(said);
      await next.answer(json(page()));
      await settle();
    },
  );

  it.each([
    ["ios", ["Loading…"], ["Kuutti's server had a problem. Try again in a moment."]],
    ["android", [], []],
  ] as const)(
    "says a read that failed aloud on %s, where the button the focus was on has gone",
    async (os, said, queued) => {
      jest.replaceProperty(Platform, "OS", os);
      (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mockClear();
      api(reading(page(entry(1, "Henna")), () => refusal("internal", 500)));
      await show();
      await press("Pass");
      expect(screen.getByText(FAILED_TO_LOAD).props.accessibilityLiveRegion).toBe(
        "assertive",
      );
      expect(announced()).toEqual(said);
      // The reason itself says it, queued behind what is being said (`LoadFailed`).
      expect(
        (AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock).mock.calls.map(
          ([words]) => words,
        ),
      ).toEqual(queued);
    },
  );

  it("brings Undo's card back from a read that failed, and comes back to the failure after it", async () => {
    const sent = api(reading(page(entry(1, "Henna")), () => refusal("internal", 500)));
    await show();
    await press("Pass");
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
    await press("Like");
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });

  it("says that the day's cards are used up when the read past the last card finds that, with Undo still there", async () => {
    api(
      reading(page(entry(1, "Henna")), () =>
        refusal("card_budget_exceeded", 429, { "retry-after": "3600" }),
      ),
    );
    await show();
    await press("Pass");
    expect(
      screen.getByText("You have seen many profiles today. New ones come after midnight."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("That's everybody for now.")).toBeNull();
    noProblems();
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
  });

  it("takes an answer of another day in the place of what it holds, with no word, and has nothing left to undo (#581)", async () => {
    const sent = api(
      reading(page(entry(1, "Henna")), { ...page(entry(1, "Riikka")), day: NEXT_DAY }),
    );
    await show();
    await press("Pass");
    expect(heading("Riikka, 31")).toBeTruthy();
    expect(liveLines()).toEqual([]);
    // The read past the last card is told, as any is; nothing after it.
    expect(announced()).toEqual(["Loading…"]);
    expect(takenTo()).toEqual({ event: "focus", words: ["Matches your filters"] });
    expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
    // The new day's card at the same place is a card of its own.
    expect(sent.seen()).toEqual([1, 1]);
    await press("Like");
    expect(sent.decisions()).toEqual([`${DAY}/1 pass`, `${NEXT_DAY}/1 like`]);
  });

  it.each([
    ["an answer", () => json(page(entry(2, "Minna")))],
    ["a failure", () => refusal("internal", 500)],
  ])(
    "lets the later of two reads speak when the earlier one ends last: %s",
    async (_what, late) => {
      const earlier = waiting();
      const reads = reading(page(entry(1, "Henna")), earlier.read, {
        ...page(entry(1, "Riikka")),
        day: NEXT_DAY,
      });
      api((call) =>
        call.path.endsWith("/decision") && (call.body as { decision: string }).decision === "like"
          ? refusal("round_expired", 409)
          : reads(call),
      );
      await show();
      await press("Pass");
      await press("Undo your last decision");
      await press("Like");
      expect(heading("Riikka, 31")).toBeTruthy();
      await earlier.answer(late());
      await settle();
      expect(heading("Riikka, 31")).toBeTruthy();
      expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
      await press("Pass");
      expect(screen.queryByRole("heading", { name: "Minna, 32" })).toBeNull();
      expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    },
  );

  it.each([
    ["Back to people", false],
    ["Go to the conversation", true],
  ] as const)(
    "reads the next cards only once the match in front of them is closed: %s",
    async (button, away) => {
      const reads = reading(page(entry(1, "Henna", "liked_you")), page(entry(2, "Katja")));
      const sent = api((call) =>
        call.path.endsWith("/decision")
          ? json({ match: { conversationId: CONVERSATION }, ...BUDGETS })
          : reads(call),
      );
      await show();
      await press("Like");
      expect(heading("It's a match")).toBeTruthy();
      expect(screen.queryByText("Loading…")).toBeNull();
      expect(sent.reads()).toBe(1);
      await press(button);
      if (away) {
        await act(async () => blurRound());
        await settle();
        expect(sent.reads()).toBe(1);
        await act(async () => focusRound());
        await settle();
      }
      expect(heading("Katja, 32")).toBeTruthy();
      expect(sent.reads()).toBe(2);
    },
  );

  it("reads on when the last card leaves the screen with no decision, its notice in sight", async () => {
    const reads = reading(page(entry(1, "Henna")), page(entry(2, "Katja")));
    const sent = api((call) =>
      call.path.endsWith("/decision") ? refusal("not_found", 404) : reads(call),
    );
    await show();
    await press("Like");
    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });
});

describe("the queue's end (ADR-062 §11)", () => {
  const SEEK = "What you seek";

  it("says that is everybody for now, not a word of tomorrow, and leads into What you seek", async () => {
    api(undefined, page());
    await show();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.queryByText(/tomorrow|come back/i)).toBeNull();
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", { name: SEEK });
    expect(button.props.accessibilityRole).toBe("button");
    noProblems();
    await press(SEEK);
    expect(router.push).toHaveBeenCalledWith("/profile/seek");
  });

  it("puts the offers between its line and the button, which is the same with or without them", async () => {
    const offered = {
      short: true,
      offers: [{ field: "smoking", kind: "aside", more: 10 }],
      relaxed: [],
    };
    api((call) => (call.path === `/rounds/${DAY}/relaxations` ? json(offered) : undefined), page());
    await show();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf("That's everybody for now.")).toBeLessThan(
      tree.indexOf("Few people today"),
    );
    expect(tree.indexOf("Few people today")).toBeLessThan(tree.indexOf(SEEK));
    expect(screen.getByRole("button", { name: SEEK })).toBeTruthy();
  });

  it.each([
    ["fi", "Siinä kaikki tällä erää.", "Mitä etsit"],
    ["sv", "Det var alla för tillfället.", "Vad du söker"],
  ] as const)("says it in %s", async (languageTag, words, button) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api(undefined, page());
    await show();
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByRole("button", { name: button })).toBeTruthy();
  });

  it("reads again as it comes back in sight, and goes on with whoever a change let in (ADR-062 §8)", async () => {
    const sent = api(reading(page(), page(entry(1, "Henna"))));
    await show();
    await press(SEEK);
    await act(async () => blurRound());
    await settle();
    expect(sent.reads()).toBe(1);
    await act(async () => focusRound());
    await settle();
    expect(heading("Henna, 31")).toBeTruthy();
    expect(sent.reads()).toBe(2);
    expect(sent.seen()).toEqual([1]);
  });

  it("says it is loading on that read, and the end again when nobody came in", async () => {
    const next = waiting();
    const sent = api(reading(page(), next.read));
    await show();
    await act(async () => focusRound());
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("That's everybody for now.")).toBeNull();
    await next.answer(json(page()));
    await settle();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });

  it("reads nothing as the app comes back on its own day, and the end and its button stay", async () => {
    jest.spyOn(Date, "now").mockReturnValue(NOON);
    const sent = api(reading(page(), page(entry(1, "Henna"))));
    await show();
    await appBecomes("active");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: SEEK })).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("keeps Undo's card through that read", async () => {
    const sent = api(reading(page(entry(1, "Henna")), page(), page()));
    await show();
    await press("Pass");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    await act(async () => focusRound());
    await settle();
    expect(sent.reads()).toBe(3);
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    // Changed at the end, it stays the end: nothing new to read.
    await press("Like");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(sent.reads()).toBe(3);
  });

  it("reads nothing as a queue not open comes back in sight on its own day", async () => {
    const sent = api(undefined, { ...page(), entries: null });
    await show();
    await act(async () => focusRound());
    await settle();
    expect(screen.getByText("There is nobody to show you yet.")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });
});

describe("Later (ADR-062 §3)", () => {
  it("moves on, spends no like, and is a decision like the others", async () => {
    const sent = api(undefined, { ...ROUND, likesLeft: 7 });
    await show();
    await press("Later");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/1 skip`]);
    expect(sent.calls.at(-2)).toMatchObject({ method: "PUT", body: { decision: "skip" } });
  });

  it("brings a skip back with Undo, says it, holds it selected, and it can change until midnight", async () => {
    const sent = api();
    await show();
    await press("Later");
    await press("Undo your last decision");
    expect(heading("Henna, 31")).toBeTruthy();
    expect(
      screen.getByText("You left this person for later. You can change that until midnight."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByRole("button", { name: "Like" }).props.accessibilityState).toMatchObject({
      selected: false,
    });
    noProblems();
    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/1 skip`, `${DAY}/1 pass`]);
  });

  it.each([
    ["liked the reader", "liked_you"],
    ["sent the reader a fish", "fish"],
  ] as const)("is there on a card that %s, which it does not answer", async (_what, reason) => {
    const sent = api(undefined, page(entry(1, "Henna", reason), entry(2, "Katja")));
    await show();
    await press("Later");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/1 skip`]);
  });

  it("reads on from the last card as a like or a pass does", async () => {
    const sent = api(reading(page(entry(1, "Henna")), page(entry(2, "Katja"))));
    await show();
    await press("Later");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.reads()).toBe(2);
  });

  it.each([
    ["fi", "Myöhemmin"],
    ["sv", "Senare"],
  ] as const)("says it in %s, never by Pass's word", async (languageTag, word) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api();
    await show();
    expect(screen.getByRole("button", { name: word })).toBeTruthy();
  });
});

describe("the your-turn limit (ADR-062 §5)", () => {
  const WAITING = (n: number) =>
    `${n} conversations are waiting for you. Answer or end one before you like anyone new.`;
  const round = (yourTurn: number): RoundResponse => ({
    ...page(entry(2, "Katja"), entry(4, "Minna"), entry(5, "Riikka")),
    yourTurn,
  });
  const limited = (call: Call) =>
    call.path.endsWith("/decision") &&
    ["like", "fish"].includes((call.body as { decision: string }).decision)
      ? refusal("your_turn_limit", 409)
      : undefined;
  /** The list a refusal asks how many wait now: this many, or this answer. */
  const list = (waiting: number | (() => Response | Promise<Response>)) => (call: Call) => {
    if (call.path !== "/conversations") return undefined;
    return typeof waiting === "function"
      ? waiting()
      : json({ open: [], archived: [], yourTurn: { waiting, limit: 8, warning: 6 } });
  };

  it.each([
    ["like", "Like"],
    ["fish", "Send a fish"],
  ] as const)(
    "refuses a %s in words with the number, and the card stays for Pass and Later",
    async (kind, button) => {
      const asked = list(8);
      const sent = api((call) => limited(call) ?? asked(call), round(8));
      await show();
      await press(button);
      expect(screen.getByText(WAITING(8))).toBeTruthy();
      expect(heading("Katja, 32")).toBeTruthy();
      // Nothing was spent, and nothing about the card has changed.
      expect(screen.getByText("10 likes left today")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Send a fish" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
      noProblems();
      await press("Later");
      expect(heading("Minna, 34")).toBeTruthy();
      // The notice was for the like; the skip that went through clears it.
      expect(screen.queryByText(WAITING(8))).toBeNull();
      await press("Pass");
      expect(heading("Riikka, 35")).toBeTruthy();
      expect(sent.decisions()).toEqual([`${DAY}/2 ${kind}`, `${DAY}/2 skip`, `${DAY}/4 pass`]);
      // A refusal serves no card again and counts towards no alarm (ADR-008, ADR-041).
      expect(sent.reads()).toBe(1);
    },
  );

  it("refuses a like back on a liked-you card too, which waits on for another day", async () => {
    const asked = list(8);
    const sent = api((call) => limited(call) ?? asked(call), {
      ...page(entry(1, "Henna", "liked_you")),
      yourTurn: 8,
    });
    await show();
    await press("Like");
    expect(screen.getByText(WAITING(8))).toBeTruthy();
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "It's a match" })).toBeNull();
    await press("Later");
    expect(sent.decisions()).toEqual([`${DAY}/1 like`, `${DAY}/1 skip`]);
  });

  it("says how many wait now, from the list without thumbs, not the number the phone held", async () => {
    const paths: string[] = [];
    const asked = list(8);
    const sent = api((call) => {
      paths.push(call.path);
      return limited(call) ?? asked(call);
    }, round(2));
    const fetched = globalThis.fetch as jest.Mock;
    await show();
    await press("Like");
    expect(screen.getByText(WAITING(8))).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.reads()).toBe(1);
    expect(paths.filter((path) => path === "/conversations")).toHaveLength(1);
    const listed = fetched.mock.calls
      .map(([input]) => new URL((input as Request).url))
      .find((url) => url.pathname === "/conversations");
    expect(listed?.searchParams.get("thumbs")).toBe("false");
  });

  it.each([
    ["refused", () => refusal("internal", 500)],
    ["no list", () => json({ nothing: true })],
  ])(
    "says the number it holds when the list fails: %s, and the card stays",
    async (_what, gone) => {
      const asked = list(gone);
      api((call) => limited(call) ?? asked(call), round(3));
      await show();
      await press("Like");
      expect(screen.getByText(WAITING(3))).toBeTruthy();
      expect(heading("Katja, 32")).toBeTruthy();
      expect(screen.queryByText(FAILED_TO_LOAD)).toBeNull();
    },
  );

  it("takes the number of a decision's answer into a list that fails", async () => {
    const asked = list(() => refusal("internal", 500));
    api((call) => {
      if (
        call.path.endsWith("/decision") &&
        (call.body as { decision: string }).decision === "pass"
      )
        return json({ ...BUDGETS, match: null, yourTurn: 9 });
      return limited(call) ?? asked(call);
    }, round(8));
    await show();
    await press("Pass");
    await press("Like");
    expect(screen.getByText(WAITING(9))).toBeTruthy();
  });

  it("holds the number it was told, for the next list that fails", async () => {
    let lists = 0;
    const asked = list(() => {
      lists += 1;
      return lists === 1
        ? json({ open: [], archived: [], yourTurn: { waiting: 8, limit: 8, warning: 6 } })
        : refusal("internal", 500);
    });
    api((call) => limited(call) ?? asked(call), round(2));
    await show();
    await press("Like");
    expect(screen.getByText(WAITING(8))).toBeTruthy();
    await press("Like");
    expect(lists).toBe(2);
    expect(screen.getByText(WAITING(8))).toBeTruthy();
  });

  it("says nothing of an old day's refusal once another day was read meanwhile", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    const late = waiting();
    const reads = reading(round(8), { ...page(entry(1, "Riikka")), day: NEXT_DAY });
    const asked = list(late.read);
    api((call) => limited(call) ?? asked(call) ?? reads(call));
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Like" }));
    });
    await settle();
    // The phone comes back on another day while the list is still on its way.
    now.mockReturnValue(NEXT_MORNING);
    await appBecomes("active");
    expect(heading("Riikka, 31")).toBeTruthy();
    await late.answer(
      json({ open: [], archived: [], yourTurn: { waiting: 8, limit: 8, warning: 6 } }),
    );
    await settle();
    expect(screen.queryByText(WAITING(8))).toBeNull();
    expect(heading("Riikka, 31")).toBeTruthy();
    now.mockRestore();
  });

  it.each([
    ["en", 1, "1 conversation is waiting for you. Answer or end one before you like anyone new."],
    [
      "fi",
      1,
      "1 keskustelu odottaa sinua. Vastaa tai lopeta yksi, ennen kuin tykkäät kenestäkään uudesta.",
    ],
    [
      "fi",
      8,
      "8 keskustelua odottaa sinua. Vastaa tai lopeta yksi, ennen kuin tykkäät kenestäkään uudesta.",
    ],
    ["sv", 1, "1 samtal väntar på dig. Svara på eller avsluta ett innan du gillar någon ny."],
    ["sv", 8, "8 samtal väntar på dig. Svara på eller avsluta ett innan du gillar någon ny."],
  ] as const)("says it in %s for %i", async (languageTag, yourTurn, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    const asked = list(yourTurn);
    api((call) => limited(call) ?? asked(call), round(yourTurn));
    await show();
    await press(languageTag === "en" ? "Like" : languageTag === "fi" ? "Tykkää" : "Gilla");
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("says it where a notice is said, each time: in sight under the header, aloud on iOS", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const asked = list(8);
    api((call) => limited(call) ?? asked(call), round(8));
    await show();
    await press("Like");
    await press("Like");
    expect(announced()).toEqual([WAITING(8), WAITING(8)]);
    expect(screen.getByText(WAITING(8)).props.accessibilityLiveRegion).toBe("polite");
    expect(ancestorsOf(WAITING(8))).not.toContain("RCTScrollView");
  });
});

describe("where the decision buttons sit (#82)", () => {
  const KEY = "kuutti.preference.decisionButtons";
  const STRANGERS: RoundResponse = {
    day: DAY,
    entries: [entry(2, "Katja"), entry(4, "Minna")],
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  };
  const CONTROLS = ["Undo your last decision", "Send a fish", "Later", "Pass", "Like"];
  /** The queue's own controls, in the order a screen reader meets them. */
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
  /** Whether a control is in the row with the likes left and the fish, which wraps. */
  const inRow = (name: string) => {
    for (let node = screen.getByRole("button", { name }).parent; node; node = node.parent) {
      if (node.props.testID === "round-likes-row") return true;
    }
    return false;
  };
  /** The classes of the row that holds the likes left and the fish: justified to the hand's side. */
  const onTheHandsSide = () => screen.getByTestId("round-likes-row").props.className;
  const placed = async (choice: object | null) => {
    if (choice) store.set(KEY, JSON.stringify(choice));
    api(undefined, STRANGERS);
    await show();
    await settle();
  };

  it("places Pass at the left and Like at the right for the right hand, the default, with the fish and Later above at the right", async () => {
    await placed(null);
    expect(controls()).toEqual(["Send a fish", "Later", "Pass", "Like"]);
    expect(column()).toBeNull();
    expect(onTheHandsSide()).toMatch(/\bjustify-end\b/);
    expect(onTheHandsSide()).not.toMatch(/\bflex-row-reverse\b/);
    expect(inRow("Later")).toBe(true);
    await press("Pass");
    // Undo stays in the header, above the card, as before.
    expect(controls()).toEqual(["Undo your last decision", "Send a fish", "Later", "Pass", "Like"]);
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

  it("mirrors them for the left hand: Like at the left, Pass at the right, the fish and Later on the left", async () => {
    await placed({ hand: "left" });
    expect(controls()).toEqual(["Send a fish", "Later", "Like", "Pass"]);
    expect(onTheHandsSide()).toMatch(/\bjustify-end\b/);
    expect(onTheHandsSide()).toMatch(/\bflex-row-reverse\b/);
    expect(inRow("Later")).toBe(true);
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
    "puts Undo, the fish, Later, Pass and Like in one column on the %s, one-handed, Undo down from the header",
    async (hand, side) => {
      await placed({ hand, oneHanded: true });
      expect(column()?.props.className).toMatch(side);
      expect(controls()).toEqual(["Send a fish", "Later", "Pass", "Like"]);
      await press("Pass");
      expect(controls()).toEqual([
        "Undo your last decision",
        "Send a fish",
        "Later",
        "Pass",
        "Like",
      ]);
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
    "keeps Undo at the thumb on the %s, one-handed, after the queue's last decision, and it still takes it back",
    async (hand, side) => {
      store.set(KEY, JSON.stringify({ hand, oneHanded: true }));
      api(undefined, {
        day: DAY,
        entries: [entry(2, "Katja")],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      });
      await show();
      await settle();
      await press("Pass");
      expect(screen.getByText("That's everybody for now.")).toBeTruthy();
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

  it("shows no Undo, one-handed, at the queue's end with nothing to take back", async () => {
    store.set(KEY, JSON.stringify({ oneHanded: true }));
    api(undefined, { day: DAY, entries: [], fishToSend: true, likesLeft: 10, yourTurn: 0 });
    await show();
    await settle();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(controls()).toEqual([]);
    expect(column()).toBeNull();
  });

  /** Whether the likes-left line is inside the one-handed column. */
  const lineInColumn = () => {
    for (let node = screen.getByText("10 likes left today").parent; node; node = node.parent) {
      if (node.props.testID === "round-one-handed") return true;
    }
    return false;
  };

  it.each([
    ["the right hand", { hand: "right" }, /\btext-right\b/],
    ["the left hand", { hand: "left" }, /^(?!.*\btext-right\b)/],
  ] as const)(
    "says the likes left on the hand's side for %s, ahead of the buttons",
    async (_, choice, side) => {
      await placed(choice);
      const line = screen.getByText("10 likes left today");
      expect(line.props.className).toMatch(side);
      expect(line.parent?.props.testID).toBe("round-likes-row");
      expect(column()).toBeNull();
      const tree = JSON.stringify(screen.toJSON());
      expect(tree.indexOf("10 likes left today")).toBeLessThan(tree.indexOf("Send a fish"));
    },
  );

  it.each([
    ["right", /\btext-right\b/],
    ["left", /^(?!.*\btext-right\b)/],
  ] as const)("says the likes left in the column on the %s, one-handed", async (hand, side) => {
    await placed({ hand, oneHanded: true });
    expect(lineInColumn()).toBe(true);
    expect(screen.getByText("10 likes left today").props.className).toMatch(side);
  });

  it("leaves the fish out of the column on a card that answers a like", async () => {
    store.set(KEY, JSON.stringify({ oneHanded: true }));
    api(undefined, {
      day: DAY,
      entries: [entry(1, "Henna", "liked_you")],
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    await settle();
    expect(controls()).toEqual(["Later", "Pass", "Like"]);
    expect(inColumn("Like")).toBe(true);
  });

  // The marks Like and Pass carry (#520): a style changes those two icons and
  // nothing else, wherever the buttons sit.
  /** The host nodes of a type inside a control. */
  const inside = (name: string, type: string) => {
    const search = (node: HostNode | string, found: boolean): HostNode[] => {
      if (typeof node === "string") return [];
      const within = found || node.props.accessibilityLabel === name;
      return [
        ...(within && node.type === type ? [node] : []),
        ...(node.children ?? []).flatMap((child) => search(child, within)),
      ];
    };
    return search(screen.toJSON() as HostNode, false);
  };
  const outlines = (name: string) => inside(name, "RNSVGPath").map((path) => String(path.props.d));
  const OWN_ICON = /^(?!M23 12a11 )/;

  describe.each([
    ["Kuutti's own marks", "kuutti", OWN_ICON, OWN_ICON],
    // Like on the mark that confirms, ✕ or A; Pass on the one that goes back, ○ or B.
    ["the shapes", "shapes", /^M23 12a11 .+ZM12 10\.59L/, /^M23 12a11 .+ZM18\.5 12a6\.5/],
    ["the letters", "letters", /^M23 12a11 .+ZM11\.06 5\.65A/, /^M23 12a11 .+ZM7 6A1/],
  ] as const)("with %s", (_style, style, likeMark, passMark) => {
    it.each([
      [
        "the right hand",
        { hand: "right", oneHanded: false },
        ["Send a fish", "Later", "Pass", "Like"],
      ],
      [
        "the left hand",
        { hand: "left", oneHanded: false },
        ["Send a fish", "Later", "Like", "Pass"],
      ],
      [
        "the right hand, one-handed",
        { hand: "right", oneHanded: true },
        ["Send a fish", "Later", "Pass", "Like"],
      ],
      [
        "the left hand, one-handed",
        { hand: "left", oneHanded: true },
        ["Send a fish", "Later", "Pass", "Like"],
      ],
    ] as const)(
      "keeps each button's shape, word, place and spoken name for %s",
      async (_place, placement, order) => {
        await placed({ ...placement, style });
        expect(controls()).toEqual(order);
        const like = screen.getByRole("button", { name: "Like" });
        const pass = screen.getByRole("button", { name: "Pass" });
        expect(like.props.className).toMatch(/\brounded-full\b/);
        expect(pass.props.className).toMatch(/\brounded-md\b/);
        expect(within(like).getByText("Like")).toBeTruthy();
        expect(within(pass).getByText("Pass")).toBeTruthy();
        expect(outlines("Like")[0]).toMatch(likeMark);
        expect(outlines("Pass")[0]).toMatch(passMark);
        // The mark is silent: the word is what a screen reader meets.
        expect(screen.queryByRole("image")).toBeNull();
        expect(inside("Like", "RNSVGSvgView")[0]?.props.accessibilityElementsHidden).toBe(true);
        expect(inside("Pass", "RNSVGSvgView")[0]?.props.accessibilityElementsHidden).toBe(true);
        noProblems();
      },
    );
  });

  it.each([
    ["the right hand", { hand: "right", oneHanded: false }],
    ["the left hand", { hand: "left", oneHanded: false }],
    ["the right hand, one-handed", { hand: "right", oneHanded: true }],
    ["the left hand, one-handed", { hand: "left", oneHanded: true }],
  ] as const)(
    "draws Later as a word for %s: no fill, no outline, no icon, and the full target",
    async (_place, placement) => {
      await placed(placement);
      const later = screen.getByRole("button", { name: "Later" });
      expect(later.props.className).not.toMatch(/\bbg-(primary|secondary)\b|\bborder-input\b/);
      expect(within(later).getByText("Later")).toBeTruthy();
      expect(inside("Later", "RNSVGSvgView")).toEqual([]);
      expect(later.props.accessibilityRole).toBe("button");
      expect(later.props.accessibilityLabel).toBe("Later");
      expect(StyleSheet.flatten(later.props.style)).toMatchObject({
        minHeight: TOUCH_TARGET,
        minWidth: TOUCH_TARGET,
      });
      noProblems();
    },
  );

  it.each(["shapes", "letters"])(
    "leaves the fish and Undo their own icons with the %s",
    async (style) => {
      await placed(null);
      await press("Pass");
      const own = [outlines("Send a fish"), outlines("Undo your last decision")];
      expect(own.flat()).not.toEqual([]);
      await placed({ style });
      await press("Pass");
      expect([outlines("Send a fish"), outlines("Undo your last decision")]).toEqual(own);
    },
  );

  it("keeps the mark's size beside the word at the largest text, the buttons' targets with it", async () => {
    atFontScale(2);
    await placed({ style: "letters" });
    expect(inside("Like", "RNSVGSvgView")[0]?.props.width).toBe(20);
    expect(inside("Pass", "RNSVGSvgView")[0]?.props.width).toBe(20);
    noProblems();
  });
});

describe("the likes left (#524, ADR-036 §6)", () => {
  const STRANGERS = { day: DAY, entries: [entry(2, "Katja"), entry(4, "Minna")] };
  /** The API's decisions, answering these numbers in turn. */
  const answering = (...left: number[]) => {
    const each = left[Symbol.iterator]();
    return (call: Call) =>
      call.path.endsWith("/decision")
        ? json({ match: null, fishToSend: true, likesLeft: each.next().value, yourTurn: 0 })
        : undefined;
  };

  it("says how many are left from the first card, and follows each decision's answer with no read", async () => {
    const sent = api(answering(2, 1), {
      ...STRANGERS,
      entries: [...STRANGERS.entries, entry(5, "Riikka")],
      fishToSend: true,
      likesLeft: 3,
      yourTurn: 0,
    });
    await show();
    expect(screen.getByText("3 likes left today")).toBeTruthy();
    await press("Like");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.getByText("2 likes left today")).toBeTruthy();
    expect(screen.queryByText("3 likes left today")).toBeNull();
    await press("Like");
    expect(screen.getByText("1 like left today")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("gives a like back when Undo's card is changed to a pass, and not before", async () => {
    const sent = api(answering(9, 10), {
      ...STRANGERS,
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    await press("Like");
    expect(screen.getByText("9 likes left today")).toBeTruthy();
    await press("Undo your last decision");
    expect(heading("Katja, 32")).toBeTruthy();
    // The decision stands until another replaces it, and the number with it.
    expect(screen.getByText("9 likes left today")).toBeTruthy();
    await press("Pass");
    expect(screen.getByText("10 likes left today")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("says plainly when none are left, with the buttons still there", async () => {
    api(undefined, { ...STRANGERS, fishToSend: false, likesLeft: 0, yourTurn: 0 });
    await show();
    expect(screen.getByText("No likes left today. New ones tomorrow.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Like" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
    noProblems();
  });

  it("says none are left when another phone spent the day's last like, and keeps the card for a pass", async () => {
    const sent = api(
      (call) =>
        call.path.endsWith("/decision") && (call.body as { decision: string }).decision === "like"
          ? refusal("like_budget_exceeded", 429, { "retry-after": "3600" })
          : undefined,
      { ...STRANGERS, fishToSend: true, likesLeft: 1, yourTurn: 0 },
    );
    await show();
    await press("Like");
    expect(screen.getByText(/You have used today's likes/)).toBeTruthy();
    expect(screen.getByText("No likes left today. New ones tomorrow.")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(sent.reads()).toBe(1);
  });

  it("keeps the number where a like is refused for another reason", async () => {
    api((call) => (call.path.endsWith("/decision") ? refusal("internal_error", 500) : undefined), {
      ...STRANGERS,
      fishToSend: true,
      likesLeft: 4,
      yourTurn: 0,
    });
    await show();
    await press("Like");
    expect(screen.getByText("4 likes left today")).toBeTruthy();
  });

  it("is plain text the screen reader reaches, never a live region, and nothing announces it", async () => {
    api(answering(9), { ...STRANGERS, fishToSend: true, likesLeft: 10, yourTurn: 0 });
    await show();
    const line = screen.getByText("10 likes left today");
    expect(line.props.accessibilityLiveRegion).toBeUndefined();
    expect(line.props.role).toBeUndefined();
    expect(line.props.className).toMatch(/\btext-muted-foreground\b/);
    await press("Like");
    expect(screen.getByText("9 likes left today")).toBeTruthy();
    expect(announced()).toEqual([]);
  });

  it("looks the same at ten as at one", async () => {
    api(answering(1), { ...STRANGERS, fishToSend: true, likesLeft: 10, yourTurn: 0 });
    await show();
    const at = screen.getByText("10 likes left today").props.className;
    await press("Like");
    expect(screen.getByText("1 like left today").props.className).toBe(at);
  });

  it("leaves with the buttons, so the queue's end has no count", async () => {
    api(answering(9, 8), { ...STRANGERS, fishToSend: true, likesLeft: 10, yourTurn: 0 });
    await show();
    await press("Like");
    await press("Like");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.queryByText(/likes? left today/)).toBeNull();
  });

  it.each([
    ["fi", 2, "2 tykkäystä jäljellä tänään"],
    ["fi", 1, "1 tykkäys jäljellä tänään"],
    ["fi", 0, "Tykkäyksiä ei ole tänään enää jäljellä. Uusia tulee huomenna."],
    ["sv", 2, "2 gillanden kvar i dag"],
    ["sv", 1, "1 gillande kvar i dag"],
    ["sv", 0, "Inga gillanden kvar i dag. Nya kommer i morgon."],
    ["en", 1, "1 like left today"],
  ] as const)("says it in %s for %i", async (languageTag, likesLeft, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api(undefined, { ...STRANGERS, fishToSend: true, likesLeft, yourTurn: 0 });
    await show();
    expect(screen.getByText(words)).toBeTruthy();
  });
});

describe("the fish and the day's likes (#503, the maintainer's of 01/11/2026)", () => {
  const STRANGERS = { day: DAY, entries: [entry(2, "Katja"), entry(4, "Minna")], yourTurn: 0 };
  const ALL = ["Send a fish", "Later", "Pass", "Like"];
  const NO_FISH = ["Later", "Pass", "Like"];
  /** What the decision bar offers, in the order a screen reader meets it. */
  const bar = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.props.accessibilityLabel as string)
      .filter((label) => ALL.includes(label));
  const selected = (name: string) =>
    screen.getByRole("button", { name }).props.accessibilityState?.selected;
  /** The API's decisions: each leaves these likes, the fish as `fishToSend` says. */
  const leaving =
    (likesLeft: number, fishToSend = true) =>
    (call: Call) =>
      call.path.endsWith("/decision")
        ? json({ match: null, fishToSend, likesLeft, yourTurn: 0 })
        : undefined;
  const isA = (call: Call, ...decisions: string[]) =>
    call.path.endsWith("/decision") &&
    decisions.includes((call.body as { decision: string }).decision);
  const usedUp = () => refusal("like_budget_exceeded", 429, { "retry-after": "3600" });
  const NONE_LEFT = "No likes left today. New ones tomorrow.";

  it.each([
    ["ten likes left", true, 10, ALL],
    ["the last like left", true, 1, ALL],
    ["no like left", true, 0, NO_FISH],
    ["the week's fish sent and likes left", false, 10, NO_FISH],
    ["neither left", false, 0, NO_FISH],
  ])(
    "offers the fish on a card not decided only with both a like and a fish left: %s",
    async (_what, fishToSend, likesLeft, offered) => {
      api(undefined, { ...STRANGERS, fishToSend, likesLeft });
      await show();
      expect(heading("Katja, 32")).toBeTruthy();
      expect(bar()).toEqual(offered);
      noProblems();
    },
  );

  it("offers the fish on a card the person liked with no like left, whose like is paid for", async () => {
    const sent = api(leaving(0), { ...STRANGERS, fishToSend: true, likesLeft: 1 });
    await show();
    await press("Like");
    // The day's last like took the fish off the next card, not yet decided.
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.getByText(NONE_LEFT)).toBeTruthy();
    expect(bar()).toEqual(NO_FISH);
    await press("Undo your last decision");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.getByText(NONE_LEFT)).toBeTruthy();
    expect(bar()).toEqual(ALL);
    expect(selected("Like")).toBe(true);
    expect(selected("Send a fish")).toBe(false);
    noProblems();
    await press("Send a fish");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(sent.decisions()).toEqual([`${DAY}/2 like`, `${DAY}/2 fish`]);
  });

  it.each([
    ["with a fish to send", true],
    ["with the week's sent", false],
  ])(
    "reads the fish back on the card that holds it with no like left, %s, open to change",
    async (_what, fishToSend) => {
      const sent = api(leaving(0, fishToSend), { ...STRANGERS, fishToSend: true, likesLeft: 1 });
      await show();
      await press("Send a fish");
      expect(heading("Minna, 34")).toBeTruthy();
      expect(bar()).toEqual(NO_FISH);
      await press("Undo your last decision");
      expect(heading("Katja, 32")).toBeTruthy();
      expect(bar()).toEqual(ALL);
      expect(selected("Send a fish")).toBe(true);
      expect(selected("Like")).toBe(false);
      expect(selected("Pass")).toBe(false);
      noProblems();
      await press("Like");
      expect(sent.decisions()).toEqual([`${DAY}/2 fish`, `${DAY}/2 like`]);
    },
  );

  it.each([
    ["liked, the week's fish sent", "matches_filters", "Like", false],
    ["passed", "matches_filters", "Pass", true],
    ["liked, answering a like", "liked_you", "Like", true],
    ["liked, answering a fish", "fish", "Like", true],
  ] as const)(
    "offers no fish on a card brought back with no like left: %s",
    async (_what, reason, decision, fishToSend) => {
      api(leaving(0, fishToSend), {
        ...STRANGERS,
        entries: [entry(2, "Katja", reason), entry(4, "Minna")],
        fishToSend: true,
        likesLeft: 1,
      });
      await show();
      await press(decision);
      await press("Undo your last decision");
      expect(heading("Katja, 32")).toBeTruthy();
      expect(selected(decision)).toBe(true);
      expect(bar()).toEqual(NO_FISH);
    },
  );

  it("brings the fish back when a pass gives the like back", async () => {
    api((call) => leaving(isA(call, "pass") ? 1 : 0)(call), {
      ...STRANGERS,
      fishToSend: true,
      likesLeft: 1,
    });
    await show();
    await press("Like");
    expect(bar()).toEqual(NO_FISH);
    await press("Undo your last decision");
    await press("Pass");
    expect(heading("Minna, 34")).toBeTruthy();
    expect(screen.getByText("1 like left today")).toBeTruthy();
    expect(bar()).toEqual(ALL);
  });

  it.each([
    ["a stranger's card", "matches_filters"],
    ["a card that answers a like", "liked_you"],
    ["a card that answers a fish", "fish"],
  ] as const)(
    "keeps Like on %s with no like left, refuses it in words, and leaves the card for a pass",
    async (_what, reason) => {
      const sent = api((call) => (isA(call, "like") ? usedUp() : leaving(0)(call)), {
        ...STRANGERS,
        entries: [entry(2, "Katja", reason), entry(4, "Minna")],
        fishToSend: true,
        likesLeft: 0,
      });
      await show();
      await press("Like");
      expect(
        screen.getByText(
          "You have used today's likes. New ones come after midnight; you can still pass.",
        ),
      ).toBeTruthy();
      expect(heading("Katja, 32")).toBeTruthy();
      expect(screen.getByText(NONE_LEFT)).toBeTruthy();
      expect(bar()).toEqual(NO_FISH);
      // Refused, nothing stands to take back.
      expect(screen.queryByRole("button", { name: "Undo your last decision" })).toBeNull();
      await press("Pass");
      expect(heading("Minna, 34")).toBeTruthy();
      expect(sent.decisions()).toEqual([`${DAY}/2 like`, `${DAY}/2 pass`]);
    },
  );

  it.each(["Like", "Send a fish"])(
    "takes the fish away when %s finds the day's likes spent on another phone",
    async (name) => {
      api((call) => (isA(call, "like", "fish") ? usedUp() : undefined), {
        ...STRANGERS,
        fishToSend: true,
        likesLeft: 1,
      });
      await show();
      expect(bar()).toEqual(ALL);
      await press(name);
      expect(screen.getByText(/You have used today's likes/)).toBeTruthy();
      expect(screen.getByText(NONE_LEFT)).toBeTruthy();
      expect(heading("Katja, 32")).toBeTruthy();
      expect(bar()).toEqual(NO_FISH);
      noProblems();
    },
  );
});

describe("how far each person lives (#514, ADR-061 §5)", () => {
  const place = { fi: "Kallio", sv: "Berghäll" };
  const placed = (at: RoundEntry, distance: RoundEntry["distance"]): RoundEntry => ({
    ...at,
    distance,
    card: { ...at.card, place },
  });
  const round = (...entries: RoundEntry[]): RoundResponse => ({ ...ROUND, entries });

  it("says the band each entry was written with, on the card, in words", async () => {
    api(undefined, round(placed(entry(1, "Henna"), "close"), placed(entry(2, "Katja"), "far")));
    await show();
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.getByText("Kallio")).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
    expect(screen.queryByText(/\d{5}|\bkm\b/)).toBeNull();
    await press("Pass");
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.getByText("Far")).toBeTruthy();
    expect(screen.queryByText("Close")).toBeNull();
    noProblems();
  });

  it("says no band for an entry from before distance, whose card still has its place", async () => {
    api(undefined, round(placed(entry(1, "Henna"), null)));
    await show();
    expect(screen.getByText("Kallio")).toBeTruthy();
    expect(screen.queryByText(/^(Nearby|Close|Around|Far)$/)).toBeNull();
  });

  it("leaves a card's band where the entry froze it, a day's read later too", async () => {
    // The band is the entry's, so nothing on the phone reads a home to work one out.
    const sent = api(undefined, round(placed(entry(1, "Henna"), "nearby")));
    await show();
    expect(screen.getByText("Nearby")).toBeTruthy();
    expect(sent.calls.filter((c) => c.path === "/profile" || c.path === "/account/home")).toEqual(
      [],
    );
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
  const EMPTY: RoundResponse = {
    day: DAY,
    entries: [],
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  };
  const relaxedCard: RoundEntry = { ...entry(5, "Liisa", "relaxed"), relaxedField: "smoking" };
  const INCLUDE = "Include those who did not answer: Smoking. About 10 more people";
  const ASIDE = "Set aside for today: Smoking. A few more people";

  it("offers to relax a deal-breaker for today at the queue's end, with the pool's growth in steps", async () => {
    const sent = api((call) => (call.path === RELAXATIONS ? json(offered) : undefined), EMPTY);
    await show();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(heading("Few people today")).toBeTruthy();
    expect(screen.getByRole("button", { name: INCLUDE })).toBeTruthy();
    expect(screen.getByRole("button", { name: ASIDE })).toBeTruthy();
    noProblems();
    // Reading the offers relaxes nothing.
    expect(sent.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  describe("its groups (#581)", () => {
    const INCLUDE_HEADING = "Include today those who did not answer";
    const ASIDE_HEADING = "Set aside for today";
    /** Offers in an order that mixes the ways: the screen says each way once. */
    const mixed = {
      short: true,
      offers: [
        { field: "smoking", kind: "aside", more: 0 },
        { field: "smoking", kind: "unanswered", more: 10 },
        { field: "hasKids", kind: "aside", more: 20 },
        { field: "hasKids", kind: "unanswered", more: 0 },
      ],
      relaxed: [],
    };
    const offering =
      (pool: unknown): Answer =>
      (call) =>
        call.path === RELAXATIONS ? json(pool) : undefined;
    /** What the panel draws, from its heading to the way into What you seek. */
    const panel = () => said().slice(said().indexOf("Few people today"), -1);

    it("says each way once as a heading over rows of the field and how much, with no sentence", async () => {
      api(offering(mixed), EMPTY);
      await show();
      expect(panel()).toEqual([
        "Few people today",
        INCLUDE_HEADING,
        "Smoking",
        "About 10 more people",
        "Kids",
        "A few more people",
        ASIDE_HEADING,
        "Smoking",
        "A few more people",
        "Kids",
        "About 20 more people",
      ]);
      expect(said().at(-1)).toBe("What you seek");
      expect(heading(INCLUDE_HEADING)).toBeTruthy();
      expect(heading(ASIDE_HEADING)).toBeTruthy();
      noProblems();
    });

    it("keeps each row's whole sentence as its spoken label, a button on a full target", async () => {
      api(offering(mixed), EMPTY);
      await show();
      for (const name of [
        "Include those who did not answer: Smoking. About 10 more people",
        "Include those who did not answer: Kids. A few more people",
        "Set aside for today: Smoking. A few more people",
        "Set aside for today: Kids. About 20 more people",
      ]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
      expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
        [],
      );
    });

    it("leaves only the group's heading bold: the field in medium, how much in regular", async () => {
      api(offering(mixed), EMPTY);
      await show();
      const row = screen.getByRole("button", {
        name: "Set aside for today: Kids. About 20 more people",
      });
      const classes = (node: { props: { className?: unknown } }) => String(node.props.className);
      expect(classes(within(row).getByText("Kids"))).toMatch(/(^| )font-medium( |$)/);
      expect(classes(within(row).getByText("Kids"))).not.toMatch(/font-semibold/);
      expect(classes(within(row).getByText("About 20 more people"))).toMatch(
        /(^| )font-normal( |$)/,
      );
      expect(classes(within(row).getByText("About 20 more people"))).not.toMatch(/font-semibold/);
      expect(classes(screen.getByText(ASIDE_HEADING))).toMatch(/(^| )font-semibold( |$)/);
      expect(classes(screen.getByText(INCLUDE_HEADING))).toMatch(/(^| )font-semibold( |$)/);
    });

    it.each([
      ["those who did not answer", "unanswered", INCLUDE_HEADING, ASIDE_HEADING],
      ["what may be set aside", "aside", ASIDE_HEADING, INCLUDE_HEADING],
    ])("draws no group for a way with no offer, with only %s", async (_what, kind, there, gone) => {
      api(
        offering({ short: true, offers: [{ field: "smoking", kind, more: 10 }], relaxed: [] }),
        EMPTY,
      );
      await show();
      expect(heading(there)).toBeTruthy();
      expect(screen.queryByRole("heading", { name: gone })).toBeNull();
      expect(panel()).toEqual(["Few people today", there, "Smoking", "About 10 more people"]);
    });

    it.each([
      ["Include those who did not answer: Kids. A few more people", "hasKids", "unanswered"],
      ["Set aside for today: Kids. About 20 more people", "hasKids", "aside"],
      ["Set aside for today: Smoking. A few more people", "smoking", "aside"],
    ])("sends what a row says, its own field by its own way: %s", async (name, field, kind) => {
      const sent = api((call) => {
        if (call.path === RELAXATIONS && call.method === "GET") return json(mixed);
        if (call.path === RELAXATIONS) return json({ entries: [] });
        return undefined;
      }, EMPTY);
      await show();
      await press(name);
      expect(sent.calls.find((c) => c.method === "POST" && c.path === RELAXATIONS)?.body).toEqual({
        field,
        kind,
      });
    });

    it.each([
      [
        "fi-FI",
        "Tänään vähän ihmisiä",
        "Ota tänään mukaan ne, jotka eivät vastanneet",
        "Jousta tänään",
        "Ota mukaan ne, jotka eivät vastanneet: Tupakointi. Noin 10 ihmistä lisää",
        "Jousta tänään: Tupakointi. Muutama ihminen lisää",
      ],
      [
        "sv-FI",
        "Få personer i dag",
        "Ta i dag med dem som inte svarade",
        "Släpp på för i dag",
        "Ta med dem som inte svarade: Rökning. Ungefär 10 fler personer",
        "Släpp på för i dag: Rökning. Några fler personer",
      ],
    ])(
      "says it all in %s, the headings and each row's whole sentence",
      async (languageTag, title, include, aside, includeRow, asideRow) => {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
        api(offering(offered), EMPTY);
        await show();
        for (const name of [title, include, aside]) expect(heading(name)).toBeTruthy();
        for (const name of [includeRow, asideRow]) {
          expect(screen.getByRole("button", { name })).toBeTruthy();
        }
      },
    );
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

  it("goes on to the rest a relaxation lets in once its first cards are read (ADR-062 §10)", async () => {
    const reads = reading(
      EMPTY,
      page({ ...entry(6, "Saara", "relaxed"), relaxedField: "smoking" }),
    );
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return json({ entries: [relaxedCard] });
      return reads(call);
    });
    await show();
    await press(INCLUDE);
    expect(heading("Liisa, 35")).toBeTruthy();
    expect(sent.reads()).toBe(1);
    await press("Pass");
    expect(heading("Saara, 36")).toBeTruthy();
    await press("Pass");
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(sent.reads()).toBe(3);
  });

  it("offers the distance like any deal-breaker, set aside and never by those who did not answer (ADR-061 §7)", async () => {
    const aside = {
      short: true,
      offers: [{ field: "distance", kind: "aside", more: 10 }],
      relaxed: [],
    };
    const card: RoundEntry = { ...relaxedCard, relaxedField: "distance" };
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(aside);
      if (call.path === RELAXATIONS) return json({ entries: [card] });
      return undefined;
    }, EMPTY);
    await show();
    await press("Set aside for today: Distance. About 10 more people");
    expect(sent.calls.find((c) => c.method === "POST" && c.path === RELAXATIONS)?.body).toEqual({
      field: "distance",
      kind: "aside",
    });
    expect(screen.getByText("Relaxed for today: Distance")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo for today: Distance" })).toBeTruthy();
    noProblems();
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
      {
        day: DAY,
        entries: [relaxedCard],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      },
    );
    await show();
    expect(heading("Liisa, 35")).toBeTruthy();

    await press("Undo for today: Smoking");

    expect(screen.queryByRole("heading", { name: "Liisa, 35" })).toBeNull();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    // No card left, so the queue read on and found its end; the panel read
    // as it came, and has nothing more to offer.
    expect(sent.reads()).toBe(2);
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
      fishToSend: true,
      likesLeft: 10,
      yourTurn: 0,
    });
    await show();
    expect(screen.getByText("Doesn't say: Smoking")).toBeTruthy();
    expect(screen.getByText("Doesn't say: Languages")).toBeTruthy();
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
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return answer();
      return undefined;
    }, EMPTY);
    await show();

    await press(INCLUDE);

    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByRole("button", { name: INCLUDE })).toBeTruthy();
    // No card came, so the queue's end stands, with no read of it again.
    expect(sent.reads()).toBe(1);
  });

  it("reads the queue anew when a relaxation finds that the day ended", async () => {
    const sent = api((call) => {
      if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
      if (call.path === RELAXATIONS) return refusal("round_expired", 409);
      return undefined;
    }, EMPTY);
    await show();

    await press(INCLUDE);

    expect(sent.reads()).toBe(2);
    expect(screen.getByText("That day ended at midnight, so this was not saved.")).toBeTruthy();
  });

  it.each([
    ["with its cards", () => json({ entries: [relaxedCard] })],
    ["refused", () => refusal("internal_error", 500)],
  ])(
    "changes nothing of the new day when a relaxation answers after it: %s",
    async (_what, late) => {
      const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
      const relaxing = waiting();
      const reads = reading(EMPTY, { ...page(entry(1, "Riikka")), day: NEXT_DAY });
      api((call) => {
        if (call.path === RELAXATIONS && call.method === "GET") return json(offered);
        if (call.path === RELAXATIONS) return relaxing.read();
        return reads(call);
      });
      await show();
      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: INCLUDE }));
      });
      now.mockReturnValue(NEXT_MORNING);
      await appBecomes("active");
      expect(heading("Riikka, 31")).toBeTruthy();
      await relaxing.answer(late());
      await settle();
      expect(heading("Riikka, 31")).toBeTruthy();
      expect(liveLines()).toEqual([]);
    },
  );

  it.each([
    ["is not short", () => json({ short: false, offers: [], relaxed: [] })],
    ["cannot be read", () => refusal("internal_error", 500)],
  ])("shows no panel when the queue %s", async (_case, answer) => {
    api((call) => (call.path === RELAXATIONS ? answer() : undefined), EMPTY);
    await show();
    expect(screen.getByText("That's everybody for now.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Few people today" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Smoking/ })).toEqual([]);
  });
});

describe("undoing a relaxation from a card (#99, ADR-042 §6)", () => {
  const RELAXATIONS = `/rounds/${DAY}/relaxations`;
  const relaxedCard: RoundEntry = { ...entry(5, "Liisa", "relaxed"), relaxedField: "smoking" };
  const round = (decision: RoundEntry["decision"] = null): RoundResponse => ({
    day: DAY,
    entries: [{ ...relaxedCard, decision }],
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  });

  it.each([
    [
      "the day ended",
      () => refusal("round_expired", 409),
      "That day ended at midnight, so this was not saved.",
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

  it.each([
    ["with the place it took back", () => json({ removed: [5] })],
    ["refused", () => refusal("internal_error", 500)],
  ])("changes nothing of the new day when an undo answers after it: %s", async (_what, late) => {
    const now = jest.spyOn(Date, "now").mockReturnValue(NOON);
    const undoing = waiting();
    const reads = reading(round(), { ...page(entry(5, "Riikka")), day: NEXT_DAY });
    api((call) => (call.method === "DELETE" ? undoing.read() : reads(call)));
    await show();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Undo for today: Smoking" }));
    });
    now.mockReturnValue(NEXT_MORNING);
    await appBecomes("active");
    expect(heading("Riikka, 35")).toBeTruthy();
    await undoing.answer(late());
    await settle();
    // The new day's card at the same place stays.
    expect(heading("Riikka, 35")).toBeTruthy();
    expect(screen.queryByText("That did not go through. Try again.")).toBeNull();
  });

  it("offers no undo on a relaxed card already decided, which Undo brought back", async () => {
    api(
      (call) =>
        call.path === RELAXATIONS ? json({ short: false, offers: [], relaxed: [] }) : undefined,
      {
        day: DAY,
        entries: [{ ...relaxedCard }, entry(6, "Saara")],
        fishToSend: true,
        likesLeft: 10,
        yourTurn: 0,
      },
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
      { day: DAY, entries: [], fishToSend: true, likesLeft: 10, yourTurn: 0 },
    );
    await show();

    await press("Set aside for today: Smoking. About 10 more people");

    expect(
      screen.getByText("Your relaxations for today changed meanwhile. Look again and choose."),
    ).toBeTruthy();
  });
});

describe("a star on a card (#575, ADR-064)", () => {
  const KEY = "kuutti.preference.decisionButtons";
  const STAR_ID = "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
  const CARD_STAR = `/rounds/${DAY}/entries/2/star`;
  const CLEAR = `/stars/${STAR_ID}`;
  const FIRST = "Only you can see your stars.";
  const STRANGERS: RoundResponse = {
    day: DAY,
    entries: [entry(2, "Katja"), entry(4, "Minna")],
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  };
  const toggle = () => screen.getByRole("button", { name: "Star: Katja" });
  const isOn = () => toggle().props.accessibilityState?.selected === true;
  /** What the star's icon is filled with: react-native-svg's { type: 2 } is the text's colour, and null nothing. */
  const fill = () => {
    const nodes = (node: HostNode | string): HostNode[] =>
      typeof node === "string" ? [] : [node, ...(node.children ?? []).flatMap(nodes)];
    const button = nodes(screen.toJSON() as HostNode).find(
      (node) => node.props.accessibilityLabel === "Star: Katja",
    );
    return (button ? nodes(button) : []).find((node) => node.type === "RNSVGGroup")?.props.fill;
  };
  const put =
    (first = false): Answer =>
    (call) =>
      call.path === CARD_STAR && call.method === "PUT" ? json({ id: STAR_ID, first }) : undefined;
  const thenClear =
    (first?: boolean): Answer =>
    (call) =>
      call.path === CLEAR && call.method === "DELETE" ? noContent() : put(first)(call);

  it("fills on a tap and clears on a second, in words and in its icon, and the card stays", async () => {
    const { calls } = api(thenClear(), STRANGERS);
    await show();
    expect(within(toggle()).getByText("Star")).toBeTruthy();
    expect(isOn()).toBe(false);
    expect(fill()).toBeNull();

    await press("Star: Katja");

    expect(isOn()).toBe(true);
    expect(within(toggle()).getByText("Starred")).toBeTruthy();
    expect(fill()).toEqual({ type: 2 });
    expect(heading("Katja, 32")).toBeTruthy();

    await press("Star: Katja");

    expect(isOn()).toBe(false);
    expect(within(toggle()).getByText("Star")).toBeTruthy();
    expect(heading("Katja, 32")).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith("/decision"))).toEqual([]);
    expect(calls.filter((c) => c.path === "/rounds/today")).toHaveLength(1);
  });

  it("says that only the person sees it when it is the first", async () => {
    api(put(true), STRANGERS);
    await show();

    await press("Star: Katja");

    expect(screen.getByText(FIRST).props.accessibilityLiveRegion).toBe("polite");
    expect(announced()).toContain(FIRST);
  });

  it.each([
    ["fi-FI", "Tähti: Katja", "Vain sinä näet tähtesi."],
    ["sv-FI", "Stjärna: Katja", "Bara du ser dina stjärnor."],
  ])("says who sees a first star in %s, and only that (#581)", async (languageTag, star, words) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    api(put(true), STRANGERS);
    await show();
    await press(star);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("says nothing of that on a later star", async () => {
    api(put(false), STRANGERS);
    await show();

    await press("Star: Katja");

    expect(screen.queryByText(FIRST)).toBeNull();
  });

  it("says in words when the list is full, and the card keeps no star", async () => {
    api((call) => (call.path === CARD_STAR ? refusal("stars_full", 409) : undefined), STRANGERS);
    await show();

    await press("Star: Katja");

    expect(
      screen.getByText("You have as many stars as you can have. Take one off to add another."),
    ).toBeTruthy();
    expect(isOn()).toBe(false);
    expect(heading("Katja, 32")).toBeTruthy();
  });

  it("says it was not saved when it fails, and the card stays as it was", async () => {
    api((call) => (call.path === CARD_STAR ? refusal("internal", 500) : undefined), STRANGERS);
    await show();

    await press("Star: Katja");

    expect(screen.getByText("That did not go through. Try again.")).toBeTruthy();
    expect(isOn()).toBe(false);
  });

  it("reads the new day when the day has ended", async () => {
    const { reads } = api(
      (call) => (call.path === CARD_STAR ? refusal("round_expired", 409) : undefined),
      STRANGERS,
    );
    await show();

    await press("Star: Katja");

    expect(reads()).toBe(2);
    expect(screen.getByText("That day ended at midnight, so this was not saved.")).toBeTruthy();
  });

  it("takes a card gone off the screen, in words", async () => {
    api((call) => (call.path === CARD_STAR ? refusal("not_found", 404) : undefined), STRANGERS);
    await show();

    await press("Star: Katja");

    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(heading("Minna, 34")).toBeTruthy();
  });

  it("reads a star gone meanwhile as off, and the card stays", async () => {
    const held: RoundResponse = {
      ...STRANGERS,
      entries: [{ ...entry(2, "Katja"), star: STAR_ID }, entry(4, "Minna")],
    };
    api((call) => (call.path === CLEAR ? refusal("not_found", 404) : undefined), held);
    await show();
    expect(isOn()).toBe(true);

    await press("Star: Katja");

    expect(isOn()).toBe(false);
    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.queryByText("That card is no longer available.")).toBeNull();
  });

  it("reads back a star the API says stands on the card", async () => {
    api(undefined, {
      ...STRANGERS,
      entries: [{ ...entry(2, "Katja"), star: STAR_ID }],
    });
    await show();
    expect(isOn()).toBe(true);
    expect(within(toggle()).getByText("Starred")).toBeTruthy();
  });

  it.each([
    ["Like", "Like"],
    ["Pass", "Pass"],
    ["Send a fish", "Send a fish"],
  ])("is gone from a card %s was chosen on, once Undo brings it back", async (_name, button) => {
    api(put(), STRANGERS);
    await show();
    await press("Star: Katja");

    await press(button);
    await press("Undo your last decision");

    expect(heading("Katja, 32")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Star: Katja" })).toBeNull();
  });

  it("does not come back when a like is taken back: the like took it off", async () => {
    api(put(), STRANGERS);
    await show();
    await press("Star: Katja");

    await press("Like");
    await press("Undo your last decision");
    await press("Later");
    await press("Undo your last decision");

    expect(isOn()).toBe(false);
  });

  it("stays on a card Later was chosen on, and can be cleared there", async () => {
    api(thenClear(), STRANGERS);
    await show();
    await press("Star: Katja");

    await press("Later");
    expect(heading("Minna, 34")).toBeTruthy();
    await press("Undo your last decision");

    expect(isOn()).toBe(true);
    await press("Star: Katja");
    expect(isOn()).toBe(false);
  });

  it("is a named control of the card's own, with its target, and no problem to a screen reader", async () => {
    api(undefined, STRANGERS);
    await show();
    const row = screen.getByText("Matches your filters").parent?.parent;
    expect(row && within(row).getByRole("button", { name: "Star: Katja" })).toBeTruthy();
    expect(screen.queryByTestId("round-one-handed")).toBeNull();
    noProblems();
  });

  it("comes down to the thumb's column with Undo, one-handed, and leaves the card", async () => {
    store.set(KEY, JSON.stringify({ hand: "right", oneHanded: true }));
    api(undefined, STRANGERS);
    await show();
    await settle();
    const column = screen.getByTestId("round-one-handed");
    expect(within(column).getByRole("button", { name: "Star: Katja" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Star: Katja" })).toHaveLength(1);
    noProblems();
  });
});

describe("a card opened from the Starred list (#575, ADR-064 §2)", () => {
  const STAR_ID = "7a1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01";
  const OPEN = `/stars/${STAR_ID}/open`;
  const OPENED: RoundResponse = {
    day: DAY,
    entries: [{ ...entry(9, "Katja", "seen_before"), star: STAR_ID }],
    fishToSend: true,
    likesLeft: 10,
    yourTurn: 0,
  };
  const opening =
    (round: RoundResponse = OPENED): Answer =>
    (call) =>
      call.path === OPEN && call.method === "POST" ? json(round) : undefined;
  const showStar = async () => {
    await renderWithTheme(<RoundScreen star={STAR_ID} />);
    await settle();
  };
  const BACK = "Back to Starred";

  it("shows that one card with the star on it, reports it seen, and reads no queue", async () => {
    const { seen, reads } = api(opening());
    await showStar();

    expect(heading("Katja, 39")).toBeTruthy();
    expect(screen.getByText("Seen before")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Star: Katja" }).props.accessibilityState?.selected,
    ).toBe(true);
    expect(screen.getByRole("heading", { name: "Starred" })).toBeTruthy();
    expect(screen.getByRole("button", { name: BACK })).toBeTruthy();
    expect(seen()).toEqual([9]);
    expect(reads()).toBe(0);
    noProblems();
  });

  it("brings a card Later stands on as it stands, not past it", async () => {
    api(
      opening({
        ...OPENED,
        entries: [{ ...entry(9, "Katja", "seen_before", "skip"), star: STAR_ID }],
      }),
    );
    await showStar();
    expect(heading("Katja, 39")).toBeTruthy();
    // The header's arrow alone: the way back that follows a card waits for it to go.
    expect(screen.getAllByRole("button", { name: BACK })).toHaveLength(1);
  });

  it("after a decision leaves the way back alone, the reader taken to that button, keeps Undo, and reads nothing more (#581)", async () => {
    const { calls, decisions, reads } = api(opening());
    await showStar();

    await press("Pass");

    expect(decisions()).toEqual([`${DAY}/9 pass`]);
    // The title and the way back, with Undo's icon in the header: no line, and no word of the queue's end.
    expect(said()).toEqual(["Starred", BACK]);
    expect(screen.getByRole("button", { name: "Undo your last decision" })).toBeTruthy();
    expect(takenTo()).toEqual({ event: "focus", role: "button", words: [BACK] });
    noProblems();
    expect(reads()).toBe(0);
    expect(calls.filter((c) => c.path === OPEN)).toHaveLength(1);

    await press("Undo your last decision");
    expect(heading("Katja, 39")).toBeTruthy();
    await press("Pass");

    const buttons = screen.getAllByRole("button", { name: BACK });
    await act(async () => {
      fireEvent.press(buttons[buttons.length - 1] as never);
    });
    expect(router.back).toHaveBeenCalled();
  });

  it("does not open it again when the screen comes back in sight after a decision", async () => {
    const { calls } = api(opening());
    await showStar();
    await press("Like");

    await act(async () => {
      blurRound();
      focusRound();
    });
    await settle();

    expect(calls.filter((c) => c.path === OPEN)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: BACK })).toHaveLength(2);
    // Coming back in sight takes the reader nowhere new: the card's reason, then the button.
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledTimes(2);
  });

  it("after a block leaves the way back alone too, the reader taken to that button, with nothing to undo (#581)", async () => {
    const { decisions, reads } = api(opening());
    await showStar();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Block or report" }));
    });
    await press("Block");
    await press("Block");
    await screen.findByText("Blocked.");
    await press("Done");

    await waitFor(() => expect(screen.getAllByRole("button", { name: BACK })).toHaveLength(2));
    expect(said()).toEqual(["Starred", BACK]);
    expect(takenTo()).toEqual({ event: "focus", role: "button", words: [BACK] });
    expect(decisions()).toEqual([]);
    expect(reads()).toBe(0);
    noProblems();
  });

  it("offers the conversation or the way back when the like makes a match", async () => {
    api((call) =>
      call.path.endsWith("/decision")
        ? json({
            match: { conversationId: CONVERSATION },
            fishToSend: true,
            likesLeft: 10,
            yourTurn: 0,
          })
        : opening()(call),
    );
    await showStar();

    await press("Like");

    expect(screen.getByRole("heading", { name: "It's a match" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to people" })).toBeNull();
    // The match's title takes the reader: the way back is a choice beside the conversation.
    expect(takenTo()).toEqual({ event: "focus", words: ["It's a match"] });
    const buttons = screen.getAllByRole("button", { name: BACK });
    await act(async () => {
      fireEvent.press(buttons[buttons.length - 1] as never);
    });
    expect(router.back).toHaveBeenCalled();
  });

  it("says a card gone and leads back when the list no longer shows them, with no word why", async () => {
    api((call) => (call.path === OPEN ? refusal("not_found", 404) : undefined));
    await showStar();

    expect(screen.getByText("That card is no longer available.")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: BACK });
    expect(buttons.length).toBe(2);
    // Here a line says what became of the card, and the reader is taken to the line.
    expect(takenTo()).toEqual({ event: "focus", words: ["That card is no longer available."] });
    noProblems();
  });

  it("says a failed opening and tries again", async () => {
    let failing = true;
    api((call) => {
      if (call.path !== OPEN) return undefined;
      return failing ? refusal("internal", 500) : json(OPENED);
    });
    await showStar();
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();

    failing = false;
    await press("Try again");

    expect(heading("Katja, 39")).toBeTruthy();
  });

  it("says the day's cards are used up where the panel has set a budget", async () => {
    api((call) => (call.path === OPEN ? refusal("card_budget_exceeded", 429) : undefined));
    await showStar();
    expect(
      screen.getByText("You have seen many profiles today. New ones come after midnight."),
    ).toBeTruthy();
  });
});
