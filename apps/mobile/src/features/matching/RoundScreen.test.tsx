import type { ProfileCard, RoundEntry, RoundResponse } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, Platform, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { RoundScreen } from "./RoundScreen";

// Today's round on the phone (#379, ADR-034): one card at a time with its
// reason, like and pass as buttons, Undo on the last decision, a match that
// leads to the conversation, block or report from the card, the end, an
// empty round and one not built in their own words, and every refusal of the
// routes said: a day that ended, a card gone, the day's likes and cards used
// up, a like that made a match.

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
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

beforeEach(async () => {
  store.clear();
  router.push.mockReset();
  router.back.mockReset();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (AccessibilityInfo.sendAccessibilityEvent as jest.Mock).mockClear();
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
    // Back from the conversation, the round goes on.
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

  it("says nothing when a seen report fails otherwise, and the card stays", async () => {
    api((call) => (call.path.endsWith("/seen") ? refusal("internal", 500) : undefined));
    await show();
    expect(heading("Henna, 31")).toBeTruthy();
    expect(screen.queryByText("That card is no longer available.")).toBeNull();
  });

  it("changes nothing when a seen report finds its card gone after the day was read anew", async () => {
    let gone = () => {};
    let reads = 0;
    api((call) => {
      if (call.path === "/rounds/today") {
        reads += 1;
        return reads === 1 ? undefined : new Promise<Response>(() => {});
      }
      if (call.path === `/rounds/${DAY}/entries/1/seen`) {
        return new Promise<Response>((resolve) => {
          gone = () => resolve(refusal("not_found", 404));
        });
      }
      if (call.path.endsWith("/decision")) return refusal("round_expired", 409);
      return undefined;
    });
    await show();
    await press("Like");
    expect(screen.getByText("Loading today's round…")).toBeTruthy();
    await act(async () => gone());
    await settle();
    expect(screen.getByText("Loading today's round…")).toBeTruthy();
  });

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

  it("says why the round did not load, and reads it again on Try again", async () => {
    let reads = 0;
    api((call) => {
      if (call.path !== "/rounds/today") return undefined;
      reads += 1;
      return reads === 1 ? refusal("internal", 500) : undefined;
    });
    await show();
    expect(screen.getByText("Today's round did not load.")).toBeTruthy();
    await press("Try again");
    expect(heading("Henna, 31")).toBeTruthy();
  });

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
});
