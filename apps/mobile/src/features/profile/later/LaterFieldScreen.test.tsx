import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { LaterFieldScreen, laterProgress, screenOpen } from "./LaterFieldScreen";

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
    tips: [],
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

beforeEach(async () => {
  router.push.mockReset();
  router.replace.mockReset();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
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

describe("LaterFieldScreen", () => {
  it("asks the first field with the progress, skips without writing, and saves before moving on", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    expect(screen.getByText("0 of 16 answered")).toBeTruthy();
    expect(screen.getByText(/One question at a time/)).toBeTruthy();
    expect(screen.getByText("No kids")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids");
    expect(puts).toEqual([]);
    await press(screen.getByRole("button", { name: "Yes, living with me" }));
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
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    expectPinnedHeader("While you wait", "Back to your profile");
    await press(screen.getByRole("button", { name: "Yes, living with me" }));
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
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Yes, living with me" }));
    expect(navigation.setOptions.mock.lastCall?.[0]).toEqual({ gestureEnabled: false });

    expect((await leave()).preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Your changes are not saved yet.")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await leave();
    await press(screen.getByRole("button", { name: "Leave without saving" }));
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "POP_TO" });
    expect(puts).toEqual([]);
  });

  it("puts an answer back on Ask me later, so a question passed over holds nothing to ask about", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Yes, living with me" }));
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/wantsKids");
    expect(
      screen.getByRole("button", { name: "Yes, living with me" }).props.accessibilityState
        ?.selected,
    ).toBe(false);
    expect(navigation.setOptions.mock.lastCall?.[0]).toEqual({ gestureEnabled: true });
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
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
    await waitFor(() => expect(screen.getByText(/One question at a time/)).toBeTruthy());
    await press(screen.getByRole("button", { name: "Want kids" }));
    expect(screen.getByText(/One question at a time/)).toBeTruthy();
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

  it("asks other nicotine on the smoking screen, and saves both with one press (#239)", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("Other nicotine")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "Vaping" }));
    await press(screen.getByRole("button", { name: "Snus" }));
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
    expect(screen.getByText("180\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One more" }));
    expect(screen.getByText("181\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "One less" }));
    expect(screen.getByText("180\u00a0cm")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.fields).toEqual({ height: 180 });
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
        : json({ profile: null, completeness: { complete: false, missing: [] }, tips: [] }),
    ) as unknown as typeof fetch;
    await show(<LaterFieldScreen field="smoking" />);
    expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy();
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Never" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText("Saving did not work. Check the fields and try again.")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says it is saving and holds both buttons meanwhile", async () => {
    const server = refusingSaves(null);
    await show(<LaterFieldScreen field="smoking" />);
    await waitFor(() => expect(screen.getByText("While you wait")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Never" }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByText("Saving…")).toBeTruthy();
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
          tips: [],
        }),
      );
      await settle();
    });
    expect(router.push).toHaveBeenCalledWith("/profile/later/languages");
  });
});
