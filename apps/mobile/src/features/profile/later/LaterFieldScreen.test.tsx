import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { LaterFieldScreen, laterProgress } from "./LaterFieldScreen";

const { __router: router } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};
const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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

  it("lands on the first unanswered field when the first one is answered already", async () => {
    fakeApi(named({ hasKids: "no" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/profile/later/wantsKids"));
  });

  it("moves on past answered fields, to the next one without an answer", async () => {
    fakeApi(named({ wantsKids: "want", smoking: "never" }));
    await show(<LaterFieldScreen field="hasKids" />);
    await waitFor(() => expect(screen.getByText("2 of 16 answered")).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
    await press(screen.getByRole("button", { name: "Ask me later" }));
    expect(router.push).toHaveBeenCalledWith("/profile/later/languages");
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

  it("shows an article 9 field under the note on its consent, and saves the answer without a consent of its own", async () => {
    const { puts } = fakeApi(named({}));
    await show(<LaterFieldScreen field="politics" />);
    await waitFor(() => expect(screen.getByText("Greens")).toBeTruthy());
    // No second switch (#204): the consent was given at the seeks step; Settings is where it is withdrawn.
    expect(screen.queryByLabelText("Sensitive answers")).toBeNull();
    expect(screen.getByText(/withdraw it in Settings/)).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Settings" }));
    expect(router.push).toHaveBeenCalledWith("/settings");
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
    await waitFor(() =>
      expect(screen.getByLabelText("Job title, without the employer's name")).toBeTruthy(),
    );
    await type(
      screen.getByLabelText("Job title, without the employer's name"),
      "aino@example.test",
    );
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
