import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SeekScreen } from "./SeekScreen";

// What a person seeks, as a list of its own (#542): each row its answer under
// onboarding's own question, heard once, and nothing edited here.

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = (ui: React.ReactElement) =>
  act(async () => {
    await renderWithTheme(ui);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const broken = () => json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);

const CONSENT = { version: "2026-10-01", at: "2026-10-01T10:00:00.000Z" };
const dealBreaker = (field: string, paused = false) => ({
  field,
  accept: ["x"],
  includeUnknown: true,
  paused,
});

/** What the API keeps; a test changes it between reads, as a screen handing back has. */
type Server = {
  seeks: string[] | null;
  ageWindow: { min: number; max: number } | null;
  fields: Record<string, unknown>;
  consent: typeof CONSENT | null;
  dealBreakers: ReturnType<typeof dealBreaker>[];
  /** Every read fails. */
  failing: boolean;
  /** The deal-breakers alone cannot be read. */
  noDealBreakers: boolean;
  /** Every read waits for this. */
  wait: Promise<void>;
};

function fakeApi(start: Partial<Server> = {}) {
  const server: Server = {
    seeks: ["woman"],
    ageWindow: { min: 25, max: 40 },
    fields: { intent: "long_term" },
    consent: CONSENT,
    dealBreakers: [],
    failing: false,
    noDealBreakers: false,
    wait: Promise.resolve(),
    ...start,
  };
  const reads = { preferences: 0, profile: 0, dealBreakers: 0 };
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    await server.wait;
    if (path === "/preferences" && request.method === "GET") {
      reads.preferences += 1;
      if (server.failing) return broken();
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    if (path === "/profile" && request.method === "GET") {
      reads.profile += 1;
      if (server.failing) return broken();
      return json({
        profile: {
          displayName: "Aino",
          bio: null,
          bioPreset: null,
          fields: server.fields,
          prompts: [],
          specialCategoryConsent: server.consent,
          updatedAt: "2026-10-08T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos"] },
        home: null,
      });
    }
    if (path === "/preferences/deal-breakers" && request.method === "GET") {
      reads.dealBreakers += 1;
      if (server.failing || server.noDealBreakers) return broken();
      return json({ dealBreakers: server.dealBreakers, max: 2 });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, reads };
}

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
  __focus: () => void;
};

const WHOM = "Whom are you looking for?";
const AGES = "What ages?";
const INTENT = "What are you here for?";
const DEAL_BREAKERS = "Your deal-breakers";

const row = (title: string) => screen.getByRole("button", { name: title });
const heard = (title: string) => row(title).props.accessibilityValue?.text as string | undefined;

/** The answer drawn under the row's title and heard once, as the value: no hint repeats it. */
function expectAnswer(title: string, answer: string) {
  expect(within(row(title)).getByText(answer)).toBeTruthy();
  expect(row(title).props.accessibilityValue).toEqual({ text: answer });
  expect(row(title).props.accessibilityHint).toBeUndefined();
}

const opened = async (start?: Partial<Server>) => {
  const api = fakeApi(start);
  await show(<SeekScreen />);
  await waitFor(() => expect(row(WHOM)).toBeTruthy());
  return api;
};

/** Comes back to the list, as a screen handing back does. */
const handBack = () =>
  act(async () => {
    focus();
    await settle();
  });

const inLocale = async (tag: string, run: () => Promise<void>) => {
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
  try {
    await run();
  } finally {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  }
};

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

describe("SeekScreen", () => {
  it("keeps the title and the way back pinned above the list", async () => {
    await opened();
    expectPinnedHeader("What you seek", "Back to your profile");
  });

  it("says at the top that the answers work both ways, naming no moment", async () => {
    await opened();
    expect(
      screen.getByText(
        "These work both ways: they decide whom you see and who sees you. Conversations you already have stay as they are.",
      ),
    ).toBeTruthy();
  });

  it("has four rows, by onboarding's questions, in their order, and nothing else to press", async () => {
    await opened();
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      "Back to your profile",
      WHOM,
      AGES,
      INTENT,
      DEAL_BREAKERS,
    ]);
  });

  it("draws each answer under its title and has it heard once, as the value", async () => {
    await opened({ dealBreakers: [dealBreaker("smoking")] });
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe("Smoking"));
    expectAnswer(WHOM, "Women");
    expectAnswer(AGES, "Youngest 25, oldest 40");
    expectAnswer(INTENT, "Something long-term");
    expectAnswer(DEAL_BREAKERS, "Smoking");
  });

  it("has every control labelled, a button and a full target", async () => {
    await opened();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found).toHaveLength(5);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it.each([
    ["one", ["man"], "Men"],
    ["two", ["woman", "non_binary"], "Women, Non-binary people"],
    ["two stored the other way round", ["non_binary", "woman"], "Women, Non-binary people"],
    ["all three", ["woman", "man", "non_binary"], "Anyone"],
    ["all three stored in another order", ["non_binary", "woman", "man"], "Anyone"],
  ])("says whom in the chips' order, Anyone for all three: %s", async (_what, seeks, words) => {
    await opened({ seeks });
    expectAnswer(WHOM, words);
  });

  it.each([
    ["a window", { min: 25, max: 40 }, "Youngest 25, oldest 40"],
    ["the widest window", { min: 18, max: 99 }, "Youngest 18, oldest 99"],
    ["one year", { min: 30, max: 30 }, "Youngest 30, oldest 30"],
  ])("says the ages in words: %s", async (_what, ageWindow, words) => {
    await opened({ ageWindow });
    expectAnswer(AGES, words);
  });

  it("has nothing under the question and no value while what one is here for is unanswered", async () => {
    await opened({ fields: {} });
    expect(heard(INTENT)).toBeUndefined();
    expect(row(INTENT).props.accessibilityHint).toBeUndefined();
    // The title is the row's one text.
    expect(within(row(INTENT)).getAllByText(/./)).toHaveLength(1);
    await press(row(INTENT));
    expect(router.push).toHaveBeenCalledWith("/profile/section/intent");
  });

  it.each([
    ["one", [dealBreaker("smoking")], "Smoking"],
    ["two in the stored order", [dealBreaker("smoking"), dealBreaker("hasKids")], "Smoking, Kids"],
    [
      "a paused one",
      [dealBreaker("smoking", true), dealBreaker("hasKids")],
      "Smoking (paused), Kids",
    ],
    ["the distance, which no field of the registry is", [dealBreaker("distance")], "Distance"],
    ["none", [], "None"],
  ])("names the deal-breakers set: %s", async (_what, dealBreakers, words) => {
    await opened({ dealBreakers });
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe(words));
    expectAnswer(DEAL_BREAKERS, words);
  });

  it("says nothing of the deal-breakers when they could not be read: their own screen says why", async () => {
    const { reads } = await opened({ noDealBreakers: true });
    expect(reads.dealBreakers).toBe(1);
    expect(heard(DEAL_BREAKERS)).toBeUndefined();
    expect(row(DEAL_BREAKERS).props.accessibilityHint).toBeUndefined();
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
    await press(row(DEAL_BREAKERS));
    expect(router.push).toHaveBeenCalledWith("/profile/deal-breakers");
  });

  it("opens each row's own screen, and goes back with its back button", async () => {
    await opened();
    for (const title of [WHOM, AGES, INTENT, DEAL_BREAKERS]) await press(row(title));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/profile/seek/whom",
      "/profile/seek/ages",
      "/profile/section/intent",
      "/profile/deal-breakers",
    ]);
    expect(router.back).not.toHaveBeenCalled();
    await press(row("Back to your profile"));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("reads everything once as it opens, and again each time a screen hands back", async () => {
    const { server, reads } = await opened();
    // The first focus is the mount, which the hook reads already.
    expect(reads).toEqual({ preferences: 1, profile: 1, dealBreakers: 1 });

    server.seeks = ["man"];
    server.ageWindow = { min: 30, max: 50 };
    server.fields = { intent: "casual" };
    server.dealBreakers = [dealBreaker("hasKids")];
    await handBack();
    expect(reads).toEqual({ preferences: 2, profile: 2, dealBreakers: 2 });
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe("Kids"));
    expectAnswer(WHOM, "Men");
    expectAnswer(AGES, "Youngest 30, oldest 50");
    expectAnswer(INTENT, "Something casual");

    await handBack();
    expect(reads).toEqual({ preferences: 3, profile: 3, dealBreakers: 3 });
  });

  it("stays on the list while it reads again: no loading screen in between", async () => {
    const { server } = await opened();
    let answer: (() => void) | undefined;
    server.wait = new Promise((resolve) => {
      answer = resolve;
    });
    server.seeks = ["man"];
    await handBack();
    expect(screen.queryByText("Loading your profile…")).toBeNull();
    expectAnswer(WHOM, "Women");
    await act(async () => {
      answer?.();
      await settle();
    });
    await waitFor(() => expectAnswer(WHOM, "Men"));
  });

  it("takes nothing away when a read again fails, but the deal-breakers it can no longer vouch for", async () => {
    const { server } = await opened({ dealBreakers: [dealBreaker("smoking")] });
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe("Smoking"));
    server.failing = true;
    await handBack();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
    expectAnswer(WHOM, "Women");
    expect(heard(DEAL_BREAKERS)).toBeUndefined();
    expect(screen.queryByText("Smoking")).toBeNull();
  });

  it("goes to onboarding when a screen hands back and the consent is gone", async () => {
    const { server } = await opened();
    expect(router.replace).not.toHaveBeenCalled();
    server.consent = null;
    await handBack();
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
  });

  it("says it is loading until the answers are read, in a live region, with no row", async () => {
    const { server } = fakeApi();
    server.wait = new Promise(() => {});
    await show(<SeekScreen />);
    expect(screen.getByText("Loading your profile…").props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What you seek" })).toBeNull();
  });

  it("shows the rows before the deal-breakers are known, saying nothing of them", async () => {
    const { server } = fakeApi({ dealBreakers: [dealBreaker("smoking")] });
    let answer: ((response: Response) => void) | undefined;
    const others = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/preferences/deal-breakers")
        return others(input, init);
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }) as unknown as typeof fetch;
    await show(<SeekScreen />);
    await waitFor(() => expect(row(WHOM)).toBeTruthy());
    await waitFor(() => expect(answer).toBeDefined());
    expect(heard(DEAL_BREAKERS)).toBeUndefined();
    expect(screen.queryByText("None")).toBeNull();
    await act(async () => {
      answer?.(json({ dealBreakers: server.dealBreakers, max: 2 }));
      await settle();
    });
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe("Smoking"));
  });

  it("says when the answers could not be read, and tries again, the deal-breakers with them", async () => {
    const { server } = fakeApi({ failing: true, dealBreakers: [dealBreaker("smoking")] });
    await show(<SeekScreen />);
    await waitFor(() => expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy());
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    const found = pressables(screen.toJSON() as HostNode);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);

    server.failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(heard(DEAL_BREAKERS)).toBe("Smoking"));
    expectAnswer(WHOM, "Women");
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it("sends whoever lacks the consent to onboarding, and shows no row of it", async () => {
    fakeApi({ consent: null });
    await show(<SeekScreen />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
    expect(screen.queryByRole("button", { name: WHOM })).toBeNull();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      {
        title: "Mitä etsit",
        back: "Takaisin profiiliisi",
        explain:
          "Nämä toimivat molempiin suuntiin: ne ratkaisevat, keitä näet ja ketkä näkevät sinut. Keskustelusi pysyvät ennallaan.",
        whom: ["Ketä etsit?", "Naisia, Muunsukupuolisia"],
        ages: ["Minkä ikäisiä?", "Nuorin 25, vanhin 40"],
        intent: ["Mitä etsit täältä?", "Jotain pitkäaikaista"],
        dealBreakers: ["Ehdottomat rajasi", "Tupakointi (tauolla)"],
      },
    ],
    [
      "sv-FI",
      {
        title: "Vad du söker",
        back: "Tillbaka till din profil",
        explain:
          "De här gäller åt båda håll: de avgör vilka du ser och vilka som ser dig. Samtal du redan har förblir som de är.",
        whom: ["Vem söker du?", "Kvinnor, Icke-binära personer"],
        ages: ["Vilka åldrar?", "Yngsta 25, äldsta 40"],
        intent: ["Vad är du här för?", "Något långvarigt"],
        dealBreakers: ["Dina absoluta gränser", "Rökning (pausad)"],
      },
    ],
  ] as const)("speaks %s", async (tag, words) => {
    await inLocale(tag, async () => {
      fakeApi({
        seeks: ["non_binary", "woman"],
        dealBreakers: [dealBreaker("smoking", true)],
      });
      await show(<SeekScreen />);
      await waitFor(() => expect(heard(words.dealBreakers[0])).toBe(words.dealBreakers[1]));
      expectPinnedHeader(words.title, words.back);
      expect(screen.getByText(words.explain)).toBeTruthy();
      for (const [title, answer] of [words.whom, words.ages, words.intent, words.dealBreakers]) {
        expectAnswer(title, answer);
      }
    });
  });

  it.each([
    ["fi-FI", "Ketä etsit?", "Kenet tahansa", "Ehdottomat rajasi", "Ei yhtään"],
    ["sv-FI", "Vem söker du?", "Vem som helst", "Dina absoluta gränser", "Inga"],
  ])("says Anyone and None in %s", async (tag, whom, anyone, dealBreakers, none) => {
    await inLocale(tag, async () => {
      fakeApi({ seeks: ["woman", "man", "non_binary"] });
      await show(<SeekScreen />);
      await waitFor(() => expect(heard(dealBreakers)).toBe(none));
      expectAnswer(whom, anyone);
    });
  });
});
