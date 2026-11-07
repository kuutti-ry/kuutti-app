import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { StrictMode } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { FAILED_TO_LOAD } from "@/test/failed";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme, underProviders } from "@/test/render";
import { LaterFieldScreen, laterFieldsShown, laterProgress, screenOpen } from "./LaterFieldScreen";

/** The names of the radio groups on the screen, each a plain view that a role query would leave out. */
const radioGroups = () =>
  screen.container
    .queryAll(
      (node) => typeof node.type === "string" && node.props.accessibilityRole === "radiogroup",
    )
    .map((node) => String(node.props.accessibilityLabel));

const { __router: router, __navigation: navigation } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock; dismissTo: jest.Mock };
  __navigation: {
    dispatch: jest.Mock;
    setOptions: jest.Mock;
    emit: (name: string, event: unknown) => void;
  };
};
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The arrow, Android's back key or a pop of several screens, as the stack reports it. */
const leave = async () => {
  const event = { preventDefault: jest.fn(), data: { action: { type: "POP_TO" } } };
  await act(async () => {
    navigation.emit("beforeRemove", event);
    await settle();
  });
  return event;
};
const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await settle();
  });
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await settle();
  });
const type = (element: ReturnType<typeof screen.getByLabelText>, text: string) =>
  act(async () => {
    fireEvent.changeText(element, text);
    await settle();
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const SPECIAL = "2026-10-draft-2";

type Profile = {
  displayName: string;
  bio: string | null;
  bioPreset: string | null;
  fields: Record<string, unknown>;
  prompts: { key: string; answer: string }[];
};

/** A tiny server for the profile: the later screens read it, "Save and continue" writes it whole. */
function fakeApi(profile: Profile | null = null) {
  const server = { profile };
  const puts: Profile[] = [];
  const response = () => ({
    profile: server.profile
      ? {
          ...server.profile,
          // The document echoes the consent row; the seeks step gave it, so anyone here has it.
          specialCategoryConsent: { version: SPECIAL, at: "2026-10-08T10:00:00.000Z" },
          updatedAt: "2026-10-08T10:00:00.000Z",
        }
      : null,
    completeness: { complete: false, missing: ["photos"] },
    home: null,
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") return json(response());
    if (path === "/profile" && request.method === "PUT") {
      const body = (await request.json()) as Profile;
      puts.push(body);
      server.profile = body;
      return json(response());
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, puts };
}

const named = (fields: Record<string, unknown>): Profile => ({
  displayName: "Aino",
  bio: null,
  bioPreset: null,
  fields,
  prompts: [],
});

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};

/** An answer that is a whole-width row by its word, chosen or not: the chosen one's name carries its mark. */
const answer = (name: string) =>
  screen.getByRole(/^(radio|checkbox)$/, { name: new RegExp(`^(✓ )?${name}$`) });
const checked = (name: string) => answer(name).props.accessibilityState?.checked;

const INTRO = "Every answer is on your card only when you give it.";

beforeEach(async () => {
  router.push.mockReset();
  router.replace.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("screenOpen", () => {
  it("keeps a screen open while its field or a companion that counts is unanswered (#239)", () => {
    expect(screenOpen({}, "smoking")).toBe(true);
    expect(screenOpen({ smoking: "never" }, "smoking")).toBe(true);
    expect(screenOpen({ nicotine: ["snus"] }, "smoking")).toBe(true);
    expect(screenOpen({ smoking: "never", nicotine: ["none"] }, "smoking")).toBe(false);
  });

  it("closes a screen whose companion is a setting or a free text once its own field is answered", () => {
    expect(screenOpen({ field: ["tech"] }, "field")).toBe(false);
    expect(screenOpen({ occupation: ["tech"] }, "occupation")).toBe(false);
    expect(screenOpen({ hasKids: "no" }, "hasKids")).toBe(false);
  });
});

describe("laterFieldsShown", () => {
  it("draws only the half still open where both halves count and one is answered (#616)", () => {
    expect(laterFieldsShown({}, "smoking", false)).toEqual(["smoking", "nicotine"]);
    expect(laterFieldsShown({ smoking: "never" }, "smoking", false)).toEqual(["nicotine"]);
    expect(laterFieldsShown({ nicotine: ["snus"] }, "smoking", false)).toEqual(["smoking"]);
    expect(laterFieldsShown({ smoking: "never", nicotine: ["none"] }, "smoking", false)).toEqual([
      "smoking",
      "nicotine",
    ]);
  });

  it("draws both halves on a screen opened for its one answer, and a setting or a free text with its field", () => {
    expect(laterFieldsShown({ smoking: "never" }, "smoking", true)).toEqual([
      "smoking",
      "nicotine",
    ]);
    expect(laterFieldsShown({ hideFromField: true }, "field", false)).toEqual([
      "field",
      "hideFromField",
    ]);
    expect(laterFieldsShown({}, "occupation", false)).toEqual(["occupation", "occupationTitle"]);
    expect(laterFieldsShown({ smoking: "never" }, "hasKids", false)).toEqual(["hasKids"]);
  });
});

describe("LaterFieldScreen", () => {
  it("asks the first field with the progress, skips without writing, and saves before moving on", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    expect(screen.getByText("0 of 16 answered")).toBeTruthy();
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(answer("No kids")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids");
    expect(puts).toEqual([]);
    await press(answer("Yes, living with me"));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ displayName: "Aino", fields: { hasKids: "yes_with_me" } });
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(2));
    expect(screen.getByText("1 of 16 answered")).toBeTruthy();
  });

  it("leaves the questions for the profile in one step from an arrow pinned above them, saving nothing", async () => {
    const { puts } = fakeApi(named({}));
    router.back.mockClear();
    router.dismissTo.mockClear();
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    expectPinnedHeader("When you have a moment", "Back to your profile");
    await press(answer("Yes, living with me"));
    await press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.dismissTo).toHaveBeenCalledWith("/profile");
    expect(router.back).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("asks before an answer not saved is left, and leaves only on the word", async () => {
    const { puts } = fakeApi(named({}));
    navigation.dispatch.mockClear();
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
    await press(answer("Yes, living with me"));
    expect(navigation.setOptions.mock.lastCall?.[0]).toEqual({ gestureEnabled: false });

    expect((await leave()).preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Leave without saving?")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await leave();
    await press(screen.getByRole("button", { name: "Leave without saving" }));
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "POP_TO" });
    expect(puts).toEqual([]);
    // Dropped: back to what is saved, so a screen a link left mounted holds nothing.
    expect(checked("Yes, living with me")).toBe(false);
  });

  it("puts an answer back on Ask me later, so a question passed over holds nothing to ask about", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(answer("Yes, living with me"));
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids");
    expect(checked("Yes, living with me")).toBe(false);
    expect(navigation.setOptions.mock.lastCall?.[0]).toEqual({ gestureEnabled: true });
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("saves a Hide with the answer on Save and continue, and drops it on Ask me later (#515)", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(answer("Yes, living with me"));
    await press(screen.getByRole("button", { name: "Hide from your card: Kids" }));
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(puts).toEqual([]);
    expect(screen.queryByRole("button", { name: "Show on your card: Kids" })).toBeNull();

    await press(answer("Yes, living with me"));
    await press(screen.getByRole("button", { name: "Hide from your card: Kids" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    expect(puts).toMatchObject([{ fields: { hasKids: "yes_with_me" }, hiddenFields: ["hasKids"] }]);
    checkA11y();
  });

  it("lands on the first unanswered field when the first one is answered already", async () => {
    fakeApi(named({ hasKids: "no" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/profile/later/wantsKids"));
  });

  it("moves on past answered fields, to the next one without an answer", async () => {
    fakeApi(named({ wantsKids: "want", smoking: "never", nicotine: ["none"] }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("2 of 16 answered")).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/languages");
  });

  it("asks other nicotine of someone whose smoking was answered before it existed (#239)", async () => {
    // Sanna's history: kids and smoking answered, no other nicotine.
    fakeApi(named({ hasKids: "no", wantsKids: "want", smoking: "never" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/profile/later/smoking"));
    expect(laterProgress({ hasKids: "no", wantsKids: "want", smoking: "never" })).toEqual({
      answered: 2,
      total: 16,
    });
  });

  it("keeps the intro line on the first unanswered field while it is being answered", async () => {
    fakeApi(named({ hasKids: "no" }));
    await show(<LaterFieldScreen field="wantsKids" />);
    await waitFor(() => expect(screen.getByText(INTRO)).toBeTruthy());
    await press(answer("Want kids"));
    expect(screen.getByText(INTRO)).toBeTruthy();
  });

  it("has only the intro's one line left of what it said, and none over a later question (#581)", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText(INTRO)).toBeTruthy());
    expect(screen.queryByText(/One question at a time/)).toBeNull();
    expect(screen.queryByText(/Skip what you like/)).toBeNull();
    fakeApi(named({}));
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(answer("Never")).toBeTruthy());
    expect(screen.queryByText(INTRO)).toBeNull();
  });

  it.each([
    ["fi-FI", "Jokainen vastaus näkyy kortillasi vain, jos annat sen."],
    ["sv-FI", "Varje svar syns på ditt kort bara om du ger det."],
  ])("says the intro's line in %s", async (tag, line) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
    try {
      fakeApi(named({}));
      await show(<LaterFieldScreen field="hasKids" />);
      await waitFor(() => expect(screen.getByText(line)).toBeTruthy());
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  describe("what it draws the answers as (#581)", () => {
    it("one answer of a short list as whole-width radios, in a group the question names", async () => {
      fakeApi(named({}));
      await show(<LaterFieldScreen field="exercise" />);
      await waitFor(() => expect(answer("Weekly")).toBeTruthy());
      expect(screen.getByLabelText("Exercise").props.accessibilityRole).toBe("radiogroup");
      expect(screen.getAllByRole("radio")).toHaveLength(4);
      expect(screen.queryByRole("button", { name: "Weekly" })).toBeNull();
      checkA11y();
    });

    it("several answers of a short list as whole-width checkboxes", async () => {
      fakeApi(named({}));
      await show(<LaterFieldScreen field="pets" />);
      await waitFor(() => expect(answer("Dog")).toBeTruthy());
      expect(screen.getAllByRole("checkbox")).toHaveLength(5);
      expect(radioGroups()).toEqual([]);
      checkA11y();
    });

    it("a companion on the same screen as rows too, each by its own kind", async () => {
      fakeApi(named({}));
      await show(<LaterFieldScreen field="smoking" />);
      await waitFor(() => expect(answer("Never")).toBeTruthy());
      expect(screen.getAllByRole("radio")).toHaveLength(5);
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    });

    it.each([
      ["the parties", "politics", "Greens"],
      ["the star signs", "zodiac", "Corgi"],
      ["the languages", "languages", "Finnish"],
      ["the hobbies", "hobbies", "Yoga"],
    ])("a long list as chips, %s", async (_what, field, word) => {
      fakeApi(named({}));
      await show(<LaterFieldScreen field={field} />);
      await waitFor(() => expect(screen.getByRole("button", { name: word })).toBeTruthy());
      expect(screen.queryByRole("radio")).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });

  it("adapts the wants-kids texts to the kids answer", async () => {
    fakeApi(named({ hasKids: "yes_with_me" }));
    await show(<LaterFieldScreen field="wantsKids" />);
    await waitFor(() => expect(screen.getByText("Want more")).toBeTruthy());
    expect(screen.getByText("No more")).toBeTruthy();
    expect(screen.getByText("Not sure anymore")).toBeTruthy();
    expect(screen.queryByText("Want kids")).toBeNull();
    expect(laterProgress({ hasKids: "yes_with_me" })).toEqual({ answered: 1, total: 16 });
  });

  it("asks an article 9 field with no note or switch of its own, and saves the answer without a consent of its own", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="politics" />);
    await waitFor(() => expect(screen.getByText("Greens")).toBeTruthy());
    // No second switch (#204) and no note (#239): the consent was given at the seeks step; Settings is the one place for it.
    expect(screen.queryByLabelText("Sensitive answers")).toBeNull();
    expect(screen.queryByText(/withdraw it in Settings/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    checkA11y();
    await press(screen.getByRole("button", { name: "Greens" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ fields: { politics: ["vihr"] } });
    expect(puts[0]).not.toHaveProperty("specialCategoryConsent");
    expect(router.push).toHaveBeenCalledWith("/profile/later/religion");
  });

  it("searches a long list, and shows the hobbies in their groups", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="languages" />);
    await waitFor(() => expect(screen.getByText("Finnish")).toBeTruthy());
    expect(screen.getByText("English")).toBeTruthy();
    await type(screen.getByLabelText("Search"), "fin");
    expect(screen.getByText("Finnish")).toBeTruthy();
    expect(screen.queryByText("English")).toBeNull();
  });

  it("groups the hobbies and keeps the companion of a field on its screen", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="hobbies" />);
    await waitFor(() => expect(screen.getByText("Outdoors")).toBeTruthy());
    expect(screen.getByText("Hiking")).toBeTruthy();
    expect(screen.getByText("Something else")).toBeTruthy();
    const { unmount } = await act(async () => {
      const rendered = renderWithTheme(<LaterFieldScreen field="field" />);
      await settle();
      return rendered;
    });
    await waitFor(() => expect(screen.getByText("Hide me from people in my field")).toBeTruthy());
    unmount();
  });

  it("asks only other nicotine of someone whose smoking was answered before it existed, and keeps the smoking answer (#616)", async () => {
    const { puts } = fakeApi(named({ smoking: "never" }));
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("Other nicotine")).toBeTruthy());
    // Smoking's answers are radios, other nicotine's checkboxes (#581): none of smoking's is drawn.
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    checkA11y();
    await press(answer("Snus"));
    // Answered on the screen, the half stays in view: the screen reads the stored document.
    expect(answer("Snus")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ fields: { smoking: "never", nicotine: ["snus"] } });
  });

  it("asks only smoking of someone who answered other nicotine alone (#616)", async () => {
    fakeApi(named({ nicotine: ["pouches"] }));
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(answer("Never")).toBeTruthy());
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("asks other nicotine on the smoking screen, and saves both with one press (#239)", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("Other nicotine")).toBeTruthy());
    checkA11y();
    await press(answer("Vaping"));
    await press(answer("Snus"));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ fields: { smoking: "vaping", nicotine: ["snus"] } });
  });

  it("steps a number from the middle of its range, and clears it again", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="height" />);
    await waitFor(() => expect(screen.getByText("No answer yet")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "One more" }));
    expect(screen.getByText("175\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One more" }));
    expect(screen.getByText("176\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One less" }));
    expect(screen.getByText("175\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.fields).toEqual({ height: 175 });
    await press(screen.getByRole("button", { name: "Clear the answer" }));
    expect(screen.getByText("No answer yet")).toBeTruthy();
  });

  it("leads from the last field to the e-mail, and from an unknown one to the first", async () => {
    fakeApi(named({}));
    await show(<LaterFieldScreen field="zodiac" />);
    await waitFor(() => expect(screen.getByText("Corgi")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/account/email");
    const { unmount } = await act(async () => {
      const rendered = renderWithTheme(<LaterFieldScreen field="nope" />);
      await settle();
      return rendered;
    });
    expect(router.replace).toHaveBeenCalledWith("/profile/later/hasKids");
    unmount();
  });

  const ALL_ANSWERED = {
    hasKids: "no",
    wantsKids: "want",
    smoking: "never",
    languages: ["fi"],
    education: "amk",
    drinking: "never",
    drugsAttitude: "not_my_thing",
    hobbies: ["yoga"],
    height: 170,
    exercise: "weekly",
    pets: ["dog"],
    field: ["tech"],
    occupation: ["tech"],
    politics: ["kok"],
    religion: "atheist",
    zodiac: "aries",
    nicotine: ["snus"],
  };

  it("stays on the first field when every later field is answered, and leads on to the e-mail", async () => {
    fakeApi(named(ALL_ANSWERED));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("16 of 16 answered")).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/account/email");
  });

  it("says when the profile could not be loaded and tries again on request", async () => {
    let failing = true;
    globalThis.fetch = jest.fn(async () =>
      failing
        ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
        : json({ profile: null, completeness: { complete: false, missing: [] }, home: null }),
    ) as unknown as typeof fetch;
    await show(<LaterFieldScreen field="smoking" />);
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
  });

  /** The profile read as usual; a save waits for the test, or is refused with a code. */
  function refusingSaves(code: string | null) {
    fakeApi(named({}));
    const reads = globalThis.fetch;
    let answer: ((response: Response) => void) | undefined;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method !== "PUT") return reads(input, init);
      if (code) return json({ error: { code, message: "x", requestId: "r" } }, 400);
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }) as unknown as typeof fetch;
    return { answer: (response: Response) => answer?.(response) };
  }

  it("stays on a refused save and says a contact detail is not allowed yet", async () => {
    refusingSaves("text_contact_details");
    await show(<LaterFieldScreen field="occupation" />);
    await waitFor(() => expect(screen.getByLabelText("Job title")).toBeTruthy());
    await type(screen.getByLabelText("Job title"), "aino@example.test");
    await press(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText(/Your text has an e-mail address, a link/)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("gives any other refusal the generic line", async () => {
    refusingSaves("validation_failed");
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(answer("Never"));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText("Saving did not work. Check the fields and try again.")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  describe("what it says as it saves (#581)", () => {
    afterEach(() => jest.restoreAllMocks());

    it.each([
      ["ios", "announceForAccessibilityWithOptions", [["Saving…", { queue: true }]]],
      ["android", "announceForAccessibility", [["Saving…"]]],
    ] as const)(
      "says it is saving aloud on %s, with no line that pushes the buttons down, once for a press",
      async (os, call, heard) => {
        jest.replaceProperty(Platform, "OS", os);
        const said = jest.spyOn(AccessibilityInfo, call).mockClear();
        const server = refusingSaves(null);
        await show(<LaterFieldScreen field="smoking" />);
        await waitFor(() => expect(answer("Never")).toBeTruthy());
        await press(answer("Never"));
        expect(said).not.toHaveBeenCalled();
        await press(screen.getByRole("button", { name: "Save and continue" }));
        expect(said.mock.calls).toEqual(heard);
        expect(screen.queryByText("Saving…")).toBeNull();
        // Answered, as the next test's read waits for a save on its way.
        await act(async () => {
          server.answer(
            json({
              profile: {
                ...named({ smoking: "never" }),
                specialCategoryConsent: null,
                updatedAt: "2026-10-08T10:00:00.000Z",
              },
              completeness: { complete: false, missing: ["photos"] },
              home: null,
            }),
          );
          await settle();
        });
      },
    );

    it("says nothing on Ask me later, which saves nothing", async () => {
      const said = jest.spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions").mockClear();
      fakeApi(named({}));
      await show(<LaterFieldScreen field="smoking" />);
      await waitFor(() => expect(answer("Never")).toBeTruthy());
      await press(screen.getByRole("button", { name: "Ask me later" }));
      expect(said).not.toHaveBeenCalled();
    });
  });

  it("holds both buttons while it saves", async () => {
    const server = refusingSaves(null);
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(answer("Never"));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    for (const name of ["Save and continue", "Ask me later"]) {
      expect(screen.getByRole("button", { name }).props.accessibilityState?.disabled).toBe(true);
    }
    await act(async () => {
      server.answer(
        json({
          profile: {
            ...named({ smoking: "never" }),
            specialCategoryConsent: null,
            updatedAt: "2026-10-08T10:00:00.000Z",
          },
          completeness: { complete: false, missing: ["photos"] },
          home: null,
        }),
      );
      await settle();
    });
    expect(router.push).toHaveBeenCalledWith("/profile/later/languages");
  });

  /**
   * Save and continue, then away by the arrow with the save on its way (#542):
   * the stack takes the screen at once, and the save lands after it.
   */
  async function leftWhileSaving(ui: React.ReactElement, arrow: string) {
    const server = refusingSaves(null);
    const { unmount } = await act(async () => {
      const rendered = renderWithTheme(ui);
      await settle();
      return rendered;
    });
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await press(screen.getByRole("button", { name: arrow }));
    await act(async () => {
      unmount();
      await settle();
    });
    await act(async () => {
      server.answer(
        json({
          profile: {
            ...named({}),
            specialCategoryConsent: null,
            updatedAt: "2026-10-08T10:00:00.000Z",
          },
          completeness: { complete: false, missing: ["photos"] },
          home: null,
        }),
      );
      await settle();
    });
  }

  it("moves on to no next question when it was left while its save was on the way", async () => {
    router.dismissTo.mockClear();
    await leftWhileSaving(<LaterFieldScreen field="smoking" />, "Back to your profile");
    expect(router.dismissTo).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  // The second run of the effects comes after their cleanup, which marked the screen left.
  it("still moves on after a save once StrictMode has run the effects twice", async () => {
    const { puts } = fakeApi(named({}));
    // Around the root: below the providers, the effects run once.
    await act(async () => {
      render(underProviders(<LaterFieldScreen field="hasKids" />), { wrapper: StrictMode });
      await settle();
    });
    await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
    await press(answer("No kids"));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids"));
  });

  describe("opened for its one answer (#542)", () => {
    const SAVE = "Save and continue";
    const SKIP = "Ask me later";
    const ARROW = "Back to your deal-breakers";
    const ASKED = "Leave without saving?";
    const button = (name: string) => screen.getByRole("button", { name });
    /** An answer, by its word: a row of a short list, a chip of a long one (the star signs). */
    const either = (name: string) =>
      screen.getByRole(/^(radio|checkbox|button)$/, { name: new RegExp(`^(✓ )?${name}$`) });

    /**
     * The stack as `router.back` drives it: `beforeRemove` in the same tick, ahead
     * of any render, so a screen that still thinks itself unsaved is caught at it.
     * `popped` is each leaving, with how many saves had landed by then.
     */
    function popping(puts: Profile[] = []) {
      const popped: { saved: number; preventDefault: jest.Mock }[] = [];
      router.back.mockImplementation(() => {
        const event = {
          saved: puts.length,
          preventDefault: jest.fn(),
          data: { action: { type: "GO_BACK" } },
        };
        popped.push(event);
        navigation.emit("beforeRemove", event);
      });
      return popped;
    }

    beforeEach(() => {
      router.dismissTo.mockClear();
    });
    afterEach(() => {
      router.back.mockReset();
    });

    it("goes back to what opened it from the arrow, never out to the profile, saving nothing", async () => {
      const { puts } = fakeApi(named({}));
      const popped = popping(puts);
      await show(<LaterFieldScreen field="hasKids" once />);
      await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
      await press(button(ARROW));
      expect(popped).toHaveLength(1);
      expect(popped[0]?.preventDefault).not.toHaveBeenCalled();
      expect(router.dismissTo).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(puts).toEqual([]);
    });

    it("draws smoking beside other nicotine, the reason it was opened (#616)", async () => {
      fakeApi(named({ smoking: "never" }));
      await show(<LaterFieldScreen field="smoking" once />);
      await waitFor(() => expect(screen.getByText("Other nicotine")).toBeTruthy());
      expect(screen.getAllByRole("radio")).toHaveLength(5);
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    });

    it("still asks before the arrow leaves an answer not saved", async () => {
      const { puts } = fakeApi(named({}));
      const popped = popping(puts);
      await show(<LaterFieldScreen field="hasKids" once />);
      await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
      await press(answer("Yes, living with me"));
      await press(button(ARROW));
      expect(popped[0]?.preventDefault).toHaveBeenCalled();
      expect(screen.getByText(ASKED)).toBeTruthy();
      expect(puts).toEqual([]);
    });

    it.each([
      ["the first question", "hasKids", "No kids", { hasKids: "no" }],
      ["a question with a companion", "smoking", "Vaping", { smoking: "vaping" }],
      ["the last question", "zodiac", "Corgi", { zodiac: "corgi" }],
    ])(
      "saves %s, then goes back with nothing asked, on to no other screen",
      async (_what, field, word, fields) => {
        const { puts } = fakeApi(named({}));
        const popped = popping(puts);
        await show(<LaterFieldScreen field={field} once />);
        await waitFor(() => expect(either(word)).toBeTruthy());
        await press(either(word));
        await press(button(SAVE));
        await waitFor(() => expect(popped).toHaveLength(1));
        expect(puts).toEqual([expect.objectContaining({ fields })]);
        // The save first: back on the deal-breakers, the row reads what was stored.
        expect(popped[0]?.saved).toBe(1);
        expect(popped[0]?.preventDefault).not.toHaveBeenCalled();
        expect(screen.queryByText(ASKED)).toBeNull();
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.dismissTo).not.toHaveBeenCalled();
      },
    );

    it("pops once when it was left while its save was on the way: a second pop would take what opened it", async () => {
      const popped = popping();
      await leftWhileSaving(<LaterFieldScreen field="smoking" once />, ARROW);
      expect(popped).toHaveLength(1);
      expect(popped[0]?.preventDefault).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("stays on a refused save, with the reason and the answer, and still asks before it is left", async () => {
      refusingSaves("validation_failed");
      const popped = popping();
      await show(<LaterFieldScreen field="smoking" once />);
      await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
      await press(answer("Never"));
      await press(button(SAVE));
      expect(screen.getByText("Saving did not work. Check the fields and try again.")).toBeTruthy();
      expect(popped).toEqual([]);
      expect(router.push).not.toHaveBeenCalled();
      expect(checked("Never")).toBe(true);
      expect((await leave()).preventDefault).toHaveBeenCalled();
      expect(screen.getByText(ASKED)).toBeTruthy();
    });

    it.each([
      ["with nothing changed", []],
      ["even after a change", ["Yes, living with me"]],
    ])(
      "writes nothing on Ask me later and goes back with nothing asked, %s",
      async (_what, taps) => {
        const { puts } = fakeApi(named({}));
        const popped = popping(puts);
        await show(<LaterFieldScreen field="hasKids" once />);
        await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
        for (const name of taps) await press(answer(name));
        await press(button(SKIP));
        expect(popped).toHaveLength(1);
        expect(popped[0]?.preventDefault).not.toHaveBeenCalled();
        expect(screen.queryByText(ASKED)).toBeNull();
        expect(puts).toEqual([]);
        expect(router.push).not.toHaveBeenCalled();
      },
    );

    it("stays on the first field when it is answered already: the person came for this one", async () => {
      fakeApi(named({ hasKids: "no" }));
      await show(<LaterFieldScreen field="hasKids" once />);
      await waitFor(() => expect(screen.getByText("When you have a moment")).toBeTruthy());
      await waitFor(() => expect(checked("No kids")).toBe(true));
      expect(router.replace).not.toHaveBeenCalled();
    });

    it("goes back from the last field with every other answered too, never to the e-mail", async () => {
      const { puts } = fakeApi(named(ALL_ANSWERED));
      const popped = popping(puts);
      await show(<LaterFieldScreen field="zodiac" once />);
      await waitFor(() => expect(screen.getByText("16 of 16 answered")).toBeTruthy());
      await press(button(SKIP));
      expect(popped).toHaveLength(1);
      expect(router.push).not.toHaveBeenCalled();
    });
  });
});
