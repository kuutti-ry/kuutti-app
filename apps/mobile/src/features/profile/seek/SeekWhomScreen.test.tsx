import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SeekWhomScreen } from "./SeekWhomScreen";

// Whom one seeks (#542): the seeks step's chips from the stored answer, saved on
// leaving, one to three, and whoever has no consent never gets this far.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = async (ui: React.ReactElement) => {
  let view: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  await act(async () => {
    view = await renderWithTheme(ui);
    await settle();
  });
  return view as NonNullable<typeof view>;
};
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) =>
  json({ error: { code, message: "no", requestId: "r" } }, status);

const CONSENT = { version: "2026-10-01", at: "2026-10-01T10:00:00.000Z" };

/** What the API keeps; a save replaces what it names, unless `refusal` answers it. */
type Server = {
  seeks: string[] | null;
  ageWindow: { min: number; max: number } | null;
  consent: typeof CONSENT | null;
  /** The answer to a save instead of taking it. */
  refusal: (() => Response) | null;
  /** Every read fails. */
  failing: boolean;
  /** Every read waits for this. */
  wait: Promise<void>;
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    seeks: ["woman"],
    ageWindow: { min: 25, max: 40 },
    consent: CONSENT,
    refusal: null,
    failing: false,
    wait: Promise.resolve(),
    ...start,
  };
  const writes: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body = (await request.json()) as { seeks?: string[] };
      writes.push({ method: request.method, path, body });
      if (server.refusal) return server.refusal();
      server.seeks = body.seeks ?? server.seeks;
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    await server.wait;
    if (server.failing) return envelope("internal_error", 500);
    if (path === "/preferences") return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    if (path === "/profile") {
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: {},
          prompts: [],
          specialCategoryConsent: server.consent,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
        home: null,
      });
    }
    return envelope("not_found", 404);
  }) as unknown as typeof fetch;
  return { server, writes };
}

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: { emit: (name: string, event: unknown) => void };
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};

/** The back gesture, the back button or Android's back key, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
/** Leaving as the stack does it: the screen goes at once, its save on the way after it (#238). */
const leaveAndGo = async (view: Awaited<ReturnType<typeof show>>) => {
  await leave();
  await act(async () => {
    view.unmount();
    await settle();
  });
};

const CHIPS = ["Women", "Men", "Non-binary people", "Anyone"];
const KEEP_ONE = "Keep at least one.";
const GENERIC = "Saving did not work. Check the fields and try again.";
const CONTACT_DETAILS =
  "Your text has an e-mail address, a link, a phone number or a social media handle. Those come after a match.";
const THE_QUESTION = "Leave without saving?";
const BACK = "Back to what you seek";

const chip = (name: string) => screen.getByRole("button", { name });
const chosen = () => CHIPS.filter((name) => chip(name).props.accessibilityState?.selected === true);

const opened = async (start?: Partial<Server>) => {
  const api = fakeApi(start);
  const view = await show(<SeekWhomScreen />);
  await waitFor(() => expect(chip("Women")).toBeTruthy());
  return { ...api, view };
};

const saved = (seeks: string[]) => ({ method: "PUT", path: "/preferences", body: { seeks } });

beforeEach(async () => {
  router.push.mockClear();
  router.replace.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});
afterEach(() => jest.restoreAllMocks());

describe("SeekWhomScreen", () => {
  it("keeps the question and the way back to the list pinned above the chips", async () => {
    await opened();
    expectPinnedHeader("Whom are you looking for?", BACK);
    await press(chip(BACK));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("says that the answer also decides who sees the person", async () => {
    await opened();
    expect(
      screen.getByText("Pick everyone you want to see. It also decides who sees you."),
    ).toBeTruthy();
  });

  it("has the chips and the way back, each labelled and a full target, and no Save", async () => {
    await opened();
    for (const name of [BACK, ...CHIPS]) expect(chip(name)).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(5);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it.each([
    ["one", ["man"], ["Men"]],
    ["two", ["non_binary", "woman"], ["Women", "Non-binary people"]],
    ["all three, which is Anyone", ["man", "woman", "non_binary"], CHIPS],
  ])("starts from the stored answer: %s", async (_what, seeks, shown) => {
    await opened({ seeks });
    expect(chosen()).toEqual(shown);
  });

  describe("the only chip chosen", () => {
    it("stays chosen and says why, in an assertive live region", async () => {
      await opened({ seeks: ["man"] });
      expect(screen.queryByText(KEEP_ONE)).toBeNull();
      await press(chip("Men"));
      expect(chosen()).toEqual(["Men"]);
      expect(screen.getByText(KEEP_ONE).props.accessibilityLiveRegion).toBe("assertive");
    });

    it("is said aloud on iOS, which has no live region, and again at a second press", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions");
      said.mockClear();
      await opened({ seeks: ["man"] });
      await press(chip("Men"));
      expect(said.mock.calls).toEqual([[KEEP_ONE, { queue: true }]]);
      await press(chip("Men"));
      expect(said.mock.calls).toEqual([
        [KEEP_ONE, { queue: true }],
        [KEEP_ONE, { queue: true }],
      ]);
      expect(screen.getAllByText(KEEP_ONE)).toHaveLength(1);
    });

    it("is said no more once another is chosen, and again when it is the only one anew", async () => {
      await opened({ seeks: ["man"] });
      await press(chip("Men"));
      await press(chip("Women"));
      expect(chosen()).toEqual(["Women", "Men"]);
      expect(screen.queryByText(KEEP_ONE)).toBeNull();
      await press(chip("Men"));
      expect(chosen()).toEqual(["Women"]);
      expect(screen.queryByText(KEEP_ONE)).toBeNull();
      await press(chip("Women"));
      expect(chosen()).toEqual(["Women"]);
      expect(screen.getByText(KEEP_ONE)).toBeTruthy();
    });

    it("is gone once Anyone is chosen", async () => {
      await opened({ seeks: ["man"] });
      await press(chip("Men"));
      await press(chip("Anyone"));
      expect(chosen()).toEqual(CHIPS);
      expect(screen.queryByText(KEEP_ONE)).toBeNull();
    });

    it("changes nothing: leaving after it sends nothing", async () => {
      const { writes } = await opened({ seeks: ["man"] });
      await press(chip("Men"));
      await leave();
      expect(writes).toEqual([]);
    });
  });

  it("chooses all three on Anyone, and dropping one takes Anyone off", async () => {
    await opened();
    await press(chip("Anyone"));
    expect(chosen()).toEqual(CHIPS);
    await press(chip("Men"));
    expect(chosen()).toEqual(["Women", "Non-binary people"]);
  });

  it("leaves without a request or a word when nothing changed", async () => {
    const { writes, view } = await opened();
    const event = await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
    await leaveAndGo(view);
    expect(writes).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("sends nothing for a change taken back, nor for the same set in another order", async () => {
    const { writes, view } = await opened({ seeks: ["woman", "man"] });
    await press(chip("Men"));
    await press(chip("Men"));
    // The stored answer again; then Women last, which makes it ["man", "woman"].
    await press(chip("Women"));
    await press(chip("Women"));
    await leaveAndGo(view);
    expect(writes).toEqual([]);
  });

  it.each([
    ["one more", ["woman"], ["Men"], ["woman", "man"]],
    ["one fewer", ["woman", "man"], ["Men"], ["woman"]],
    ["as many, but others", ["woman"], ["Men", "Women"], ["man"]],
    ["everyone, by Anyone", ["woman"], ["Anyone"], ["woman", "man", "non_binary"]],
  ])("sends %s", async (_what, seeks, pressed, sent) => {
    const { writes, view } = await opened({ seeks });
    for (const name of pressed) await press(chip(name));
    await leaveAndGo(view);
    expect(writes).toEqual([saved(sent)]);
  });

  it("sends exactly whom one seeks, once, on leaving, and nothing before it", async () => {
    const { writes, server, view } = await opened();
    await press(chip("Men"));
    await press(chip("Non-binary people"));
    expect(writes).toEqual([]);
    const event = await leave();
    await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writes).toEqual([saved(["woman", "man", "non_binary"])]);
    expect(server.seeks).toEqual(["woman", "man", "non_binary"]);
    await leaveAndGo(view);
    expect(writes).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ["the generic line", "internal_error", 500, GENERIC],
    ["the words the app has for the code", "text_contact_details", 400, CONTACT_DETAILS],
  ])(
    "brings a refused change back with the draft and %s, and goes on the word",
    async (_what, code, status, reason) => {
      const { writes, view } = await opened({ refusal: () => envelope(code, status) });
      await press(chip("Men"));
      await leaveAndGo(view);
      expect(writes).toEqual([saved(["woman", "man"])]);
      expect(router.push).toHaveBeenCalledWith("/profile/seek/whom");

      // The stack opens the screen again: what was chosen is there, and why it was not saved.
      await show(<SeekWhomScreen />);
      await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
      expect(chosen()).toEqual(["Women", "Men"]);
      expect(screen.getByText(reason)).toBeTruthy();

      await press(chip("Leave without saving"));
      expect(screen.queryByText(THE_QUESTION)).toBeNull();
      expect(router.back).toHaveBeenCalledTimes(1);
      await leave();
      expect(writes).toHaveLength(1);
    },
  );

  // Nothing to compare the draft with yet, so nothing goes: it is the question's to let go.
  it("sends nothing for a refused draft left before the stored answer is read", async () => {
    const { server, writes, view } = await opened({
      refusal: () => envelope("internal_error", 500),
    });
    await press(chip("Men"));
    await leaveAndGo(view);
    server.wait = new Promise(() => {});
    await show(<SeekWhomScreen />);
    expect(chosen()).toEqual(["Women", "Men"]);
    await leave();
    expect(writes).toHaveLength(1);
  });

  it("holds a change the network lost, as any refusal", async () => {
    const { server, view } = await opened({
      refusal: () => {
        throw new TypeError("Network request failed");
      },
    });
    await press(chip("Men"));
    await leaveAndGo(view);
    expect(router.push).toHaveBeenCalledWith("/profile/seek/whom");
    server.refusal = null;
    await show(<SeekWhomScreen />);
    await waitFor(() => expect(screen.getByText(GENERIC)).toBeTruthy());
    expect(chosen()).toEqual(["Women", "Men"]);
  });

  it("keeps a refused draft on Keep editing, and saves it on the next leaving", async () => {
    const { writes, server, view } = await opened({
      refusal: () => envelope("internal_error", 500),
    });
    await press(chip("Men"));
    await leaveAndGo(view);
    server.refusal = null;
    const again = await show(<SeekWhomScreen />);
    await waitFor(() => expect(screen.getByText(THE_QUESTION)).toBeTruthy());
    await press(chip("Keep editing"));
    expect(screen.queryByText(THE_QUESTION)).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
    await press(chip("Non-binary people"));
    expect(chosen()).toEqual(CHIPS);
    await leaveAndGo(again);
    expect(writes).toEqual([saved(["woman", "man"]), saved(["woman", "man", "non_binary"])]);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("holds no draft when what is gone is the consent: the list's read sends the person on", async () => {
    const { writes, view } = await opened({ refusal: () => envelope("consent_required", 403) });
    await press(chip("Men"));
    await leaveAndGo(view);
    expect(writes).toEqual([saved(["woman", "man"])]);
    expect(router.push).not.toHaveBeenCalled();
    // And nothing is held for the next time the screen opens.
    await show(<SeekWhomScreen />);
    await waitFor(() => expect(chip("Women")).toBeTruthy());
    expect(screen.queryByText(THE_QUESTION)).toBeNull();
    expect(chosen()).toEqual(["Women"]);
  });

  it("says it is loading until the answer is read, and leaving then sends nothing", async () => {
    const { writes } = fakeApi({ wait: new Promise(() => {}) });
    await show(<SeekWhomScreen />);
    expect(screen.getByText("Loading your profile…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: "Women" })).toBeNull();
    await leave();
    expect(writes).toEqual([]);
  });

  it("says when the answer could not be read, and tries again", async () => {
    const { server } = fakeApi({ failing: true });
    await show(<SeekWhomScreen />);
    await waitFor(() => expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy());
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    server.failing = false;
    await press(chip("Try again"));
    await waitFor(() => expect(chosen()).toEqual(["Women"]));
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it("sends whoever has no consent to onboarding, and shows no chip", async () => {
    fakeApi({ consent: null });
    await show(<SeekWhomScreen />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByRole("button", { name: "Women" })).toBeNull();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      "Ketä etsit?",
      "Takaisin siihen, mitä etsit",
      "Valitse kaikki, joita haluat nähdä. Se ratkaisee myös, ketkä näkevät sinut.",
      "Naisia",
      "Pidä ainakin yksi.",
    ],
    [
      "sv-FI",
      "Vem söker du?",
      "Tillbaka till vad du söker",
      "Välj alla du vill se. Det avgör också vilka som ser dig.",
      "Kvinnor",
      "Behåll minst en.",
    ],
  ])("speaks %s", async (tag, title, back, lead, only, keepOne) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi();
      await show(<SeekWhomScreen />);
      await waitFor(() => expect(screen.getByText(lead)).toBeTruthy());
      expectPinnedHeader(title, back);
      await press(chip(only));
      expect(screen.getByText(keepOne)).toBeTruthy();
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });
});
