import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SectionScreen } from "./SectionScreen";
import { PROFILE_SECTIONS } from "./sections";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = (ui: React.ReactElement) =>
  act(async () => {
    renderWithTheme(ui);
    await settle();
  });
// Every event in its own act scope, settled before the next query: a state
// update dispatched outside one is not flushed by a later act in this runtime.
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

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const missing = ["display_name", "photos", "bio_or_prompts", "seeks", "age_window"];

/** A stored document with these fields, as GET /profile answers it. */
const stored = (fields: Record<string, unknown>) => ({
  displayName: "Aino",
  bio: null as string | null,
  bioPreset: null as string | null,
  fields,
  prompts: [],
  specialCategoryConsent: null,
  updatedAt: "2026-09-26T10:00:00.000Z",
});

function fakeApi(
  options: { saveStatus?: number; saveCode?: string; profile?: ReturnType<typeof stored> } = {},
) {
  const puts: unknown[] = [];
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
      return json({
        profile: options.profile ?? null,
        completeness: { complete: false, missing },
        tips: [],
      });
    }
    if (path === "/profile" && request.method === "PUT") {
      const body = await request.json();
      puts.push(body);
      if (options.saveStatus) {
        return json(
          {
            error: { code: options.saveCode ?? "validation_failed", message: "no", requestId: "r" },
          },
          options.saveStatus,
        );
      }
      return json({
        profile: {
          ...(body as object),
          specialCategoryConsent: null,
          updatedAt: "2026-09-26T10:00:00.000Z",
        },
        completeness: { complete: false, missing: ["photos", "seeks", "age_window"] },
        tips: [],
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { puts };
}

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: {
    addListener: jest.Mock;
    dispatch: jest.Mock;
    emit: (name: string, event: unknown) => void;
  };
  __router: { replace: jest.Mock; back: jest.Mock };
};

/** The back gesture, the back button or Android's back key, as the stack reports it. */
const leave = () =>
  act(async () => {
    navigation.emit("beforeRemove", {
      preventDefault: jest.fn(),
      data: { action: { type: "GO_BACK" } },
    });
    await settle();
  });

beforeEach(async () => {
  navigation.addListener.mockClear();
  navigation.dispatch.mockReset();
  router.replace.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("SectionScreen", () => {
  it.each(PROFILE_SECTIONS.map(({ id }) => id))(
    "renders the %s section's fields and options with a text, every control labelled, and no Save",
    async (id) => {
      fakeApi();
      await show(<SectionScreen section={id} />);
      await waitFor(() => expect(screen.queryByText("Loading your profile…")).toBeNull());
      // A text that is still its key means the catalogue and the registry disagree.
      expect(screen.queryAllByText(/^profile\./)).toEqual([]);
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      const found = pressables(screen.toJSON() as HostNode);
      expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    },
  );

  it("shows the section's own fields only", async () => {
    fakeApi();
    await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    expect(screen.getByText("Pets")).toBeTruthy();
    expect(screen.queryByText("Languages")).toBeNull();
    expect(screen.queryByLabelText("Name on your card")).toBeNull();
  });

  it("sends an unknown section to the list", async () => {
    fakeApi();
    await show(<SectionScreen section="nonsense" />);
    expect(router.replace).toHaveBeenCalledWith("/profile");
  });

  it("puts the note on the sensitive-answers consent at the head of the beliefs only", async () => {
    fakeApi();
    await show(<SectionScreen section="beliefs" />);
    await waitFor(() => expect(screen.getByText("Parties you could vote for")).toBeTruthy());
    expect(screen.getByText(/sensitive-answers consent/)).toBeTruthy();
    await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getAllByText("Smoking").length).toBeGreaterThan(0));
    expect(screen.queryByText(/sensitive-answers consent/)).toBeNull();
  });

  it("does not offer the identity label to everyone: only once it was given, to change it", async () => {
    fakeApi();
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Languages")).toBeTruthy());
    expect(screen.queryByText("Agender")).toBeNull();
  });

  it("shows the identity label a non-binary person gave in onboarding", async () => {
    fakeApi({ profile: stored({ identityLabel: "agender" }) });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Agender")).toBeTruthy());
  });

  it("leaves without a word or a request when nothing changed", async () => {
    const { puts } = fakeApi();
    await show(<SectionScreen section="relationship" />);
    await waitFor(() => expect(screen.getByText("Looking for")).toBeTruthy());
    expect(navigation.addListener).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it("saves the whole document once on leaving with an edit, then leaves", async () => {
    const { puts } = fakeApi({ profile: stored({ smoking: "never" }) });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), " Aino K ");
    await press(screen.getByRole("button", { name: "suomi" }));
    await press(screen.getByRole("button", { name: "English" }));
    await waitFor(() =>
      expect(navigation.addListener).toHaveBeenCalledWith("beforeRemove", expect.any(Function)),
    );
    await leave();
    expect(puts).toHaveLength(1);
    // The rest of the document goes with it: a section saves the whole profile.
    expect(puts[0]).toMatchObject({
      displayName: "Aino K",
      fields: { smoking: "never", languages: ["fi", "en"] },
    });
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
    expect(screen.queryByText("Leave without saving?")).toBeNull();
  });

  it("saves an answered prompt on leaving the prompts", async () => {
    const { puts } = fakeApi();
    await show(<SectionScreen section="prompts" />);
    await waitFor(() => expect(screen.getByText("My ideal Sunday")).toBeTruthy());
    await press(screen.getByRole("button", { name: "My ideal Sunday" }));
    await type(screen.getByLabelText("Your answer to: My ideal Sunday"), "A long breakfast.");
    await leave();
    expect(puts[0]).toMatchObject({ prompts: [{ key: "sunday", answer: "A long breakfast." }] });
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
  });

  it("stays on a refusal, says why, and leaves without saving only on the word", async () => {
    const { puts } = fakeApi({ saveStatus: 400, saveCode: "text_contact_details" });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await leave();
    expect(puts).toHaveLength(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(screen.getByText("Leave without saving?")).toBeTruthy();
    expect(screen.getAllByText(/e-mail address, a link/).length).toBeGreaterThan(0);

    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    // The reason stays on the screen while the person fixes it.
    expect(screen.getByText(/e-mail address, a link/)).toBeTruthy();
    expect(navigation.dispatch).not.toHaveBeenCalled();

    await leave();
    expect(puts).toHaveLength(2);
    await press(screen.getByRole("button", { name: "Leave without saving" }));
    expect(navigation.dispatch).toHaveBeenCalledWith({ type: "GO_BACK" });
  });

  it("takes a written bio over a placeholder", async () => {
    const { puts } = fakeApi({ profile: { ...stored({}), bioPreset: "photos_speak" } });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
    const preset = screen.getByRole("button", { name: "The photos say it. The rest over coffee." });
    expect(preset.props.accessibilityState?.selected).toBe(true);
    await type(screen.getByLabelText("About you"), "Long walks.");
    await leave();
    expect(puts[0]).toMatchObject({ bio: "Long walks.", bioPreset: null });
  });

  it("takes a placeholder over a written bio, and lets it go again", async () => {
    const { puts } = fakeApi({ profile: { ...stored({}), bio: "Long walks." } });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
    const preset = () =>
      screen.getByRole("button", { name: "The photos say it. The rest over coffee." });
    await press(preset());
    expect(screen.getByLabelText("About you").props.value).toBe("");
    expect(preset().props.accessibilityState?.selected).toBe(true);
    await press(preset());
    expect(preset().props.accessibilityState?.selected).toBe(false);
    await leave();
    expect(puts[0]).toMatchObject({ bio: null, bioPreset: null });
  });

  it("saves an emptied bio as none", async () => {
    const { puts } = fakeApi({ profile: { ...stored({}), bio: "Long walks." } });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
    await type(screen.getByLabelText("About you"), "");
    await leave();
    expect(puts[0]).toMatchObject({ bio: null, bioPreset: null });
  });

  it("says when the profile could not be loaded and tries again on request", async () => {
    let failing = true;
    globalThis.fetch = jest.fn(async () =>
      failing
        ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
        : json({ profile: null, completeness: { complete: false, missing }, tips: [] }),
    ) as unknown as typeof fetch;
    await show(<SectionScreen section="lifestyle" />);
    expect(screen.getByText("Your profile could not be loaded. Try again.")).toBeTruthy();
    failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
  });

  it("says it is saving, holds the back button, and saves once however often the person tries to leave", async () => {
    let answer: ((response: Response) => void) | undefined;
    const puts: unknown[] = [];
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET") {
        return json({ profile: stored({}), completeness: { complete: false, missing }, tips: [] });
      }
      puts.push(await request.json());
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }) as unknown as typeof fetch;
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "Aino K");
    await leave();
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back to your profile" }).props.accessibilityState
        ?.disabled,
    ).toBe(true);
    await leave();
    expect(puts).toHaveLength(1);
    await act(async () => {
      answer?.(
        json({
          profile: stored({}),
          completeness: { complete: false, missing },
          tips: [],
        }),
      );
      await settle();
    });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saving…")).toBeNull();
  });

  it("names a refusal for the sensitive answers, and gives any other the generic line", async () => {
    fakeApi({ saveStatus: 403, saveCode: "consent_required" });
    await show(<SectionScreen section="beliefs" />);
    await waitFor(() => expect(screen.getByText("Parties you could vote for")).toBeTruthy());
    await press(screen.getByRole("button", { name: "National Coalition Party" }));
    await leave();
    expect(
      screen.getAllByText("This field needs your explicit consent first.").length,
    ).toBeGreaterThan(0);
  });

  it("gives a refusal it has no words for the generic line, and the close control keeps the person here", async () => {
    fakeApi({ saveStatus: 422, saveCode: "validation_failed" });
    await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Dog" }));
    await leave();
    expect(
      screen.getAllByText("Saving did not work. Check the fields and try again.").length,
    ).toBeGreaterThan(0);
    await press(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });

  it("goes back to the list with its back button", async () => {
    fakeApi();
    router.back.mockClear();
    await show(<SectionScreen section="hobbies" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Hobbies" })).toBeTruthy());
    await press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
