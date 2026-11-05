import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader, hasCutText } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SectionScreen } from "./SectionScreen";
import { PROFILE_SECTIONS } from "./sections";
import { FAILED_TO_LOAD } from "@/test/failed";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const show = async (ui: React.ReactElement) => {
  let view: Awaited<ReturnType<typeof renderWithTheme>> | undefined;
  await act(async () => {
    view = await renderWithTheme(ui);
    await settle();
  });
  return view as NonNullable<typeof view>;
};
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
        home: null,
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
        home: null,
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { puts };
}

/** A ready line of the basics, a whole-width row (#581): its name says the mark when it is the one chosen. */
const preset = (name: string) => screen.getByRole("radio", { name });

const { __navigation: navigation, __router: router } = jest.requireMock("expo-router") as {
  __navigation: {
    addListener: jest.Mock;
    dispatch: jest.Mock;
    emit: (name: string, event: unknown) => void;
  };
  __router: { replace: jest.Mock; back: jest.Mock; push: jest.Mock };
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
  const event = await leave();
  await act(async () => {
    view.unmount();
    await settle();
  });
  return event;
};

beforeEach(async () => {
  navigation.addListener.mockClear();
  navigation.dispatch.mockReset();
  router.replace.mockClear();
  router.push.mockClear();
  router.back.mockClear();
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: `${token("family")}.${token("refresh")}`,
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("SectionScreen", () => {
  it.each(PROFILE_SECTIONS.map(({ id }) => id))(
    "renders the %s section's fields and options with a text, every control labelled, and no Save",
    async (id) => {
      fakeApi();
      await show(<SectionScreen section={id} />);
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
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

  it("keeps the section's name and the way back pinned above its fields", async () => {
    fakeApi();
    await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    expectPinnedHeader("Lifestyle", "Back to your profile");
  });

  it("sends an unknown section to the list", async () => {
    fakeApi();
    await show(<SectionScreen section="nonsense" />);
    expect(router.replace).toHaveBeenCalledWith("/profile");
  });

  it("asks the beliefs with no note on the sensitive-answers consent: Settings is the one place for it (#239)", async () => {
    fakeApi();
    await show(<SectionScreen section="beliefs" />);
    await waitFor(() => expect(screen.getByText("Parties you could vote for")).toBeTruthy());
    expect(screen.queryByText(/sensitive-answers consent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
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
    await waitFor(() => expect(screen.getByText("Relationship structure")).toBeTruthy());
    const event = await leave();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("saves the whole document once on leaving with an edit, and never holds the leaving", async () => {
    const { puts } = fakeApi({ profile: stored({ smoking: "never" }) });
    const view = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), " Aino K ");
    await press(screen.getByRole("button", { name: "Finnish" }));
    await press(screen.getByRole("button", { name: "English" }));
    // Held, the native swipe on iOS went back, forth and back again (#238).
    const event = await leaveAndGo(view);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(puts).toHaveLength(1);
    // The rest of the document goes with it: a section saves the whole profile.
    expect(puts[0]).toMatchObject({
      displayName: "Aino K",
      fields: { smoking: "never", languages: ["fi", "en"] },
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });

  it("saves a Hide on leaving, as any other change, with the answer kept (#515)", async () => {
    const { puts } = fakeApi({ profile: stored({ smoking: "never" }) });
    const view = await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Hide from your card: Smoking" }));
    // Nothing goes before the leaving: each save is a research event (ADR-011).
    expect(puts).toEqual([]);
    await leaveAndGo(view);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ fields: { smoking: "never" }, hiddenFields: ["smoking"] });
  });

  it("saves nothing when a Hide was taken back before leaving (#515)", async () => {
    const { puts } = fakeApi({ profile: stored({ smoking: "never" }) });
    const view = await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Hide from your card: Smoking" }));
    await press(screen.getByRole("button", { name: "Show on your card: Smoking" }));
    await leaveAndGo(view);
    expect(puts).toEqual([]);
  });

  it("saves an answered prompt on leaving the prompts", async () => {
    const { puts } = fakeApi();
    const view = await show(<SectionScreen section="prompts" />);
    await waitFor(() => expect(screen.getByText("My ideal Sunday")).toBeTruthy());
    await press(screen.getByRole("button", { name: "My ideal Sunday" }));
    await type(screen.getByLabelText("Your answer to: My ideal Sunday"), "A long breakfast.");
    await leaveAndGo(view);
    expect(puts[0]).toMatchObject({ prompts: [{ key: "sunday", answer: "A long breakfast." }] });
  });

  it("saves once however often the stack reports the leaving", async () => {
    const { puts } = fakeApi();
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "Aino K");
    await leave();
    await leave();
    expect(puts).toHaveLength(1);
  });

  it("brings a refused section back with the draft and the reason, and asks before leaving without saving", async () => {
    const { puts } = fakeApi({ saveStatus: 400, saveCode: "text_contact_details" });
    const view = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await leaveAndGo(view);
    expect(puts).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith("/profile/section/basics");

    // The stack opens the section again: what was typed is there, and why it was refused.
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
    expect(screen.getByLabelText("Name on your card").props.value).toBe("aino@example.com");
    expect(screen.getAllByText(/e-mail address, a link/).length).toBeGreaterThan(0);

    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    // The reason stays on the screen while the person fixes it.
    expect(screen.getByText(/e-mail address, a link/)).toBeTruthy();
    // Fixed, it saves on leaving like any other edit, and nothing opens again.
    const after = fakeApi();
    await type(screen.getByLabelText("Name on your card"), "Aino");
    await leave();
    expect(after.puts).toEqual([expect.objectContaining({ displayName: "Aino" })]);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("says why in the question itself", async () => {
    fakeApi({ saveStatus: 400, saveCode: "text_contact_details" });
    const view = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await leaveAndGo(view);
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
    // On the screen and in the dialog: the screen's own line stays once the dialog has gone.
    expect(screen.getAllByText(/e-mail address, a link/)).toHaveLength(2);
  });

  it("lets a refused draft go on the word, with no save on the way out", async () => {
    const { puts } = fakeApi({ saveStatus: 400, saveCode: "text_contact_details" });
    const view = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await leaveAndGo(view);
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Leave without saving" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    await leave();
    expect(puts).toHaveLength(1);
  });

  it("keeps another section's save when a refused one comes back and is left after it (#238)", async () => {
    // One stored document, as the API keeps it: a save replaces it, a contact detail is refused.
    let document = stored({ smoking: "never" });
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT") {
        const body = (await request.json()) as { displayName: string };
        if (body.displayName.includes("@")) {
          const error = { code: "text_contact_details", message: "no", requestId: "r" };
          return json({ error }, 400);
        }
        document = { ...document, ...body };
      }
      return json({ profile: document, completeness: { complete: false, missing }, home: null });
    }) as unknown as typeof fetch;

    const basics = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "aino@example.com");
    await leaveAndGo(basics);
    expect(router.push).toHaveBeenCalledWith("/profile/section/basics");

    // Meanwhile another section is changed and saved.
    const intent = await show(<SectionScreen section="intent" />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Something casual" })).toBeTruthy(),
    );
    await press(screen.getByRole("radio", { name: "Something casual" }));
    await leaveAndGo(intent);
    expect(document.fields).toEqual({ smoking: "never", intent: "casual" });

    // The refused section, back, fixed and left last, saves its own change and undoes none.
    const again = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Keep editing" }));
    await type(screen.getByLabelText("Name on your card"), "Aino K");
    await leaveAndGo(again);
    expect(document).toMatchObject({
      displayName: "Aino K",
      fields: { smoking: "never", intent: "casual" },
    });
  });

  it("opens nothing again when the session ended while the save was on its way", async () => {
    fakeApi({ saveStatus: 401, saveCode: "unauthenticated" });
    const view = await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    await type(screen.getByLabelText("Name on your card"), "Aino K");
    await act(async () => {
      await clearSession();
    });
    await leaveAndGo(view);
    expect(router.push).not.toHaveBeenCalled();
    // And nothing is held for the next time the section opens.
    fakeApi();
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
    expect(screen.queryByText("Leave without saving?")).toBeNull();
  });

  describe("the basics, with what they explained gone (#581)", () => {
    const LINES = [
      "I was too lazy to write anything here, so this placeholder says I am a nice fellow.",
      "Ask me. I answer better than I write.",
      "The photos say it. The rest over coffee.",
    ];

    it("has the name's label and no hint: the field stops at its length by itself", async () => {
      fakeApi();
      await show(<SectionScreen section="basics" />);
      await waitFor(() => expect(screen.getByLabelText("Name on your card")).toBeTruthy());
      expect(screen.getByText("Name on your card")).toBeTruthy();
      expect(screen.getByLabelText("Name on your card").props.maxLength).toBe(20);
      expect(screen.queryByText(/How you want to be called/)).toBeNull();
    });

    it("has the bio's heading of ready lines and no hint: its length is on the list when it matters", async () => {
      fakeApi();
      await show(<SectionScreen section="basics" />);
      await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
      expect(screen.queryByText(/count as a bio/)).toBeNull();
      expect(screen.getByText("Or pick a line instead")).toBeTruthy();
    });

    it("offers the ready lines as whole-width rows, radios in a group the heading names, with the line chosen said", async () => {
      fakeApi({ profile: { ...stored({}), bioPreset: "ask_me_instead" } });
      await show(<SectionScreen section="basics" />);
      await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
      const group = screen.getByLabelText("Or pick a line instead");
      expect(group.props.accessibilityRole).toBe("radiogroup");
      expect(group.props.className).not.toMatch(/\bflex-row\b/);
      expect(screen.getAllByRole("radio").map((row) => row.props.accessibilityLabel)).toEqual([
        LINES[0],
        `✓ ${LINES[1]}`,
        LINES[2],
      ]);
      expect(screen.getByText(`✓ ${LINES[1]}`)).toBeTruthy();
      const found = pressables(screen.toJSON() as HostNode);
      expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    });

    it("gives the ready lines no line count or fixed height to cut them", async () => {
      fakeApi();
      await show(<SectionScreen section="basics" />);
      await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
      expect(hasCutText(screen.toJSON() as HostNode)).toBe(false);
    });

    it.each([
      ["fi-FI", "Tai valitse valmis rivi", "Kuvat kertovat. Loput kahvilla."],
      ["sv-FI", "Eller välj en färdig rad", "Bilderna säger det. Resten över en kaffe."],
    ])("names the group and its lines in %s", async (tag, heading, line) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        fakeApi();
        await show(<SectionScreen section="basics" />);
        await waitFor(() => expect(screen.getByLabelText(heading)).toBeTruthy());
        expect(screen.getByLabelText(heading).props.accessibilityRole).toBe("radiogroup");
        expect(preset(line)).toBeTruthy();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("says of the job title only what to leave out: the field stops at its length by itself", async () => {
      fakeApi();
      await show(<SectionScreen section="work" />);
      await waitFor(() => expect(screen.getByLabelText("Job title")).toBeTruthy());
      expect(screen.getByText("Without the employer's name")).toBeTruthy();
      expect(screen.queryByText(/characters/)).toBeNull();
      expect(screen.getByLabelText("Job title").props.maxLength).toBe(40);
    });
  });

  describe("what it draws the answers as (#581)", () => {
    it("a section of several fields as chips, however short the lists", async () => {
      fakeApi();
      await show(<SectionScreen section="lifestyle" />);
      await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
      expect(screen.queryByRole("radio")).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.getByRole("button", { name: "Vaping" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dog" })).toBeTruthy();
    });

    it("a section of one field as whole-width rows, where the list is short", async () => {
      fakeApi();
      await show(<SectionScreen section="intent" />);
      await waitFor(() => expect(screen.getByLabelText("Looking for")).toBeTruthy());
      expect(screen.getByLabelText("Looking for").props.accessibilityRole).toBe("radiogroup");
      expect(screen.getAllByRole("radio")).toHaveLength(4);
    });

    it("a section of one field as chips, where the list is long: the hobbies", async () => {
      fakeApi();
      await show(<SectionScreen section="hobbies" />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Yoga" })).toBeTruthy());
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });

  it("takes a written bio over a placeholder", async () => {
    const { puts } = fakeApi({ profile: { ...stored({}), bioPreset: "photos_speak" } });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
    expect(preset("✓ The photos say it. The rest over coffee.")).toBeTruthy();
    await type(screen.getByLabelText("About you"), "Long walks.");
    expect(preset("The photos say it. The rest over coffee.")).toBeTruthy();
    await leave();
    expect(puts[0]).toMatchObject({ bio: "Long walks.", bioPreset: null });
  });

  it("takes a placeholder over a written bio, and lets it go again", async () => {
    const { puts } = fakeApi({ profile: { ...stored({}), bio: "Long walks." } });
    await show(<SectionScreen section="basics" />);
    await waitFor(() => expect(screen.getByLabelText("About you")).toBeTruthy());
    await press(preset("The photos say it. The rest over coffee."));
    expect(screen.getByLabelText("About you").props.value).toBe("");
    const chosen = preset("✓ The photos say it. The rest over coffee.");
    expect(chosen.props.accessibilityState?.checked).toBe(true);
    await press(chosen);
    const taken = preset("The photos say it. The rest over coffee.");
    expect(taken.props.accessibilityState?.checked).toBe(false);
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
        : json({ profile: null, completeness: { complete: false, missing }, home: null }),
    ) as unknown as typeof fetch;
    await show(<SectionScreen section="lifestyle" />);
    expect(screen.getByText(FAILED_TO_LOAD)).toBeTruthy();
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
  });

  it("names a refusal for the sensitive answers, and gives any other the generic line", async () => {
    fakeApi({ saveStatus: 403, saveCode: "consent_required" });
    const view = await show(<SectionScreen section="beliefs" />);
    await waitFor(() => expect(screen.getByText("Parties you could vote for")).toBeTruthy());
    await press(screen.getByRole("button", { name: "National Coalition Party" }));
    await leaveAndGo(view);
    await show(<SectionScreen section="beliefs" />);
    await waitFor(() =>
      expect(
        screen.getAllByText("This field needs your explicit consent first.").length,
      ).toBeGreaterThan(0),
    );
  });

  it("gives a refusal it has no words for the generic line, and the close control keeps the person here", async () => {
    fakeApi({ saveStatus: 422, saveCode: "validation_failed" });
    const view = await show(<SectionScreen section="lifestyle" />);
    await waitFor(() => expect(screen.getByText("Smoking")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Dog" }));
    await leaveAndGo(view);
    await show(<SectionScreen section="lifestyle" />);
    await waitFor(() =>
      expect(
        screen.getAllByText("Saving did not work. Check the fields and try again.").length,
      ).toBeGreaterThan(0),
    );
    await press(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Leave without saving?")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
  });

  it("goes back to the list with its back button", async () => {
    fakeApi();
    await show(<SectionScreen section="hobbies" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Hobbies" })).toBeTruthy());
    await press(screen.getByRole("button", { name: "Back to your profile" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  describe("what one is here for, a section of its own (#542)", () => {
    const LEAD = "This also decides who sees you: people who want the same thing.";
    const QUESTION = "What are you here for?";
    const BACK = "Back to what you seek";
    /** An answer by its word, chosen or not: the chosen one's name carries its mark. */
    const option = (name: string) =>
      screen.getByRole("radio", { name: new RegExp(`^(✓ )?${name}$`) });
    const ready = () => waitFor(() => expect(option("Something casual")).toBeTruthy());

    it("is titled by onboarding's question, says what the answer does, and goes back to What you seek", async () => {
      fakeApi({ profile: stored({ intent: "casual" }) });
      await show(<SectionScreen section="intent" />);
      await ready();
      expectPinnedHeader(QUESTION, BACK);
      expect(screen.getByText(LEAD)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Back to your profile" })).toBeNull();
      await press(screen.getByRole("button", { name: BACK }));
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "fi-FI",
        "Mitä etsit täältä?",
        "Takaisin siihen, mitä etsit",
        "Tämä ratkaisee myös, ketkä näkevät sinut: ne, jotka haluavat samaa.",
      ],
      [
        "sv-FI",
        "Vad är du här för?",
        "Tillbaka till vad du söker",
        "Det här avgör också vilka som ser dig: de som vill samma sak.",
      ],
    ])("speaks %s", async (tag, title, back, lead) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        fakeApi();
        await show(<SectionScreen section="intent" />);
        await waitFor(() => expect(screen.getByText(lead)).toBeTruthy());
        expectPinnedHeader(title, back);
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("leaves the lead to itself: the section it left keeps its own way back and has none", async () => {
      fakeApi();
      await show(<SectionScreen section="relationship" />);
      await waitFor(() => expect(screen.getByText("Relationship structure")).toBeTruthy());
      expectPinnedHeader("Relationship and kids", "Back to your profile");
      expect(screen.queryByText(LEAD)).toBeNull();
      expect(screen.queryByRole("button", { name: BACK })).toBeNull();
      // Nor is the answer asked here any more: one answer, one door.
      expect(screen.queryByText("Looking for")).toBeNull();
      expect(screen.queryByText("Something casual")).toBeNull();
    });

    it("saves nothing when the chosen answer is pressed again", async () => {
      const { puts } = fakeApi({ profile: stored({ intent: "casual" }) });
      const view = await show(<SectionScreen section="intent" />);
      await ready();
      await press(option("Something casual"));
      expect(option("Something casual").props.accessibilityState?.checked).toBe(true);
      await leaveAndGo(view);
      expect(puts).toEqual([]);
    });

    it("saves a changed answer on leaving, the rest of the document with it", async () => {
      const { puts } = fakeApi({ profile: stored({ intent: "casual", smoking: "never" }) });
      const view = await show(<SectionScreen section="intent" />);
      await ready();
      await press(option("Something long-term"));
      expect(puts).toEqual([]);
      const event = await leaveAndGo(view);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(puts).toEqual([
        expect.objectContaining({ fields: { intent: "long_term", smoking: "never" } }),
      ]);
    });

    it("saves a Hide on leaving, the answer kept: Hide moved here with it", async () => {
      const { puts } = fakeApi({ profile: stored({ intent: "casual" }) });
      const view = await show(<SectionScreen section="intent" />);
      await ready();
      await press(screen.getByRole("button", { name: "Hide from your card: Looking for" }));
      await leaveAndGo(view);
      expect(puts).toEqual([
        expect.objectContaining({ fields: { intent: "casual" }, hiddenFields: ["intent"] }),
      ]);
    });

    it("comes back to itself when a change is refused, with the draft and the reason", async () => {
      fakeApi({ profile: stored({ intent: "casual" }), saveStatus: 422 });
      const view = await show(<SectionScreen section="intent" />);
      await ready();
      await press(option("Something long-term"));
      await leaveAndGo(view);
      expect(router.push).toHaveBeenCalledWith("/profile/section/intent");

      await show(<SectionScreen section="intent" />);
      await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
      expect(
        screen.getAllByText("Saving did not work. Check the fields and try again."),
      ).toHaveLength(2);
      expect(option("Something long-term").props.accessibilityState?.checked).toBe(true);
    });
  });

  describe("opened for one answer, from the deal-breakers' Answer it (#542)", () => {
    const TITLE = "Relationship and kids";
    const ARROW = "Back to your deal-breakers";
    const ready = () =>
      waitFor(() => expect(screen.getByText("Relationship structure")).toBeTruthy());

    it("says its arrow goes back to the deal-breakers, and goes back", async () => {
      fakeApi();
      await show(<SectionScreen section="relationship" once />);
      await ready();
      expectPinnedHeader(TITLE, ARROW);
      expect(screen.queryByRole("button", { name: "Back to your profile" })).toBeNull();
      await press(screen.getByRole("button", { name: ARROW }));
      expect(router.back).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["fi-FI", "Takaisin ehdottomiin rajoihisi"],
      ["sv-FI", "Tillbaka till dina absoluta gränser"],
    ])("says so in %s", async (tag, arrow) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        fakeApi();
        await show(<SectionScreen section="relationship" once />);
        await waitFor(() => expect(screen.getByRole("button", { name: arrow })).toBeTruthy());
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("comes back at the path that says once when a change is refused, so the arrow still says it", async () => {
      fakeApi({ saveStatus: 422 });
      const view = await show(<SectionScreen section="relationship" once />);
      await ready();
      await press(screen.getByRole("button", { name: "Monogamous" }));
      await leaveAndGo(view);
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/profile/section/[id]",
        params: { id: "relationship", once: "1" },
      });

      // The stack opens that path, and the route hands `once` on (routes.test.tsx).
      await show(<SectionScreen section="relationship" once />);
      await waitFor(() => expect(screen.getByText("Leave without saving?")).toBeTruthy());
      await press(screen.getByRole("button", { name: "Keep editing" }));
      expectPinnedHeader(TITLE, ARROW);
      expect(
        screen.getByRole("button", { name: "Monogamous" }).props.accessibilityState?.selected,
      ).toBe(true);
    });
  });
});
