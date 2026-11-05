import {
  type HomeSummary,
  LATER_FIELD_ORDER,
  PROFILE_FIELDS,
  type ProfileFieldKey,
} from "@kuutti/schema";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { ProfileScreen } from "./ProfileScreen";

/** A valid answer to any field of the registry, for a document that answers everything. */
function answerOf(key: ProfileFieldKey): unknown {
  const spec = PROFILE_FIELDS[key];
  if (spec.kind === "single") return spec.options[0];
  if (spec.kind === "multi") return [spec.options[0]];
  if (spec.kind === "number") return spec.min;
  if (spec.kind === "text") return "x";
  return true;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
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

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Document = {
  displayName?: string;
  bio?: string | null;
  bioPreset?: string | null;
  fields?: Record<string, unknown>;
  prompts?: Array<{ key: string; answer: string }>;
};

const approved = (n: number) => ({
  id: `0b1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a${n.toString(16).padStart(2, "0")}`,
  blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  width: 1600,
  height: 1200,
  state: "approved",
  rejectionReason: null,
  appealable: false,
  position: n - 1,
  createdAt: "2026-09-25T12:00:00.000Z",
});

/**
 * GET /profile answering each read with the next list of what is missing, the
 * last one again after that; `document` the stored profile (none by
 * default); `photos` the photo list's photos (none by default), or "failing"
 * for a list that cannot be read; `home` the person's home (none by default);
 * `gender` the status's gender, or "failing" for a status that cannot be read.
 */
function fakeApi(
  missingByRead: string[][],
  {
    document,
    photos = [],
    home = null,
    gender = "woman",
  }: {
    document?: Document;
    photos?: ReturnType<typeof approved>[] | "failing";
    home?: HomeSummary | null;
    gender?: string | (() => string) | "failing";
  } = {},
) {
  let reads = 0;
  let photoReads = 0;
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/profile" && request.method === "GET") {
      const missing = missingByRead[Math.min(reads, missingByRead.length - 1)] ?? [];
      reads += 1;
      return json({
        profile: document
          ? {
              displayName: "Aino",
              bio: null,
              bioPreset: null,
              fields: {},
              prompts: [],
              ...document,
              specialCategoryConsent: null,
              updatedAt: "2026-09-26T10:00:00.000Z",
            }
          : null,
        completeness: { complete: missing.length === 0, missing },
        home,
      });
    }
    if (path === "/photos" && request.method === "GET") {
      photoReads += 1;
      if (photos === "failing") {
        return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
      }
      return json({ photos, maxPhotos: 6, tips: [] });
    }
    if (path === "/onboarding" && request.method === "GET") {
      const answer = typeof gender === "function" ? gender() : gender;
      if (answer === "failing") {
        return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
      }
      return json({
        state: "active",
        age: 36,
        gender: answer,
        home: null,
        preferences: { seeks: ["man"], ageWindow: { min: 25, max: 40 } },
        consents: { terms: "t", privacy: "p", specialCategory: "s", research: null },
        currentVersions: { terms: "t", privacy: "p", research: "r", special_category: "s" },
        nextChange: { gender: null },
        missing: [],
        complete: true,
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { reads: () => reads, photoReads: () => photoReads };
}

/** A row's accessibility value: how far it is filled, in words. */
const progressValue = (name: string) =>
  screen.getByRole("button", { name }).props.accessibilityValue?.text as string | undefined;

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; back: jest.Mock };
  __focus: () => void;
};

beforeEach(async () => {
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

describe("ProfileScreen", () => {
  describe("the home's row (#514, ADR-061)", () => {
    const town = { fi: "Helsinki", sv: "Helsingfors" };
    const area = { fi: "Kallio", sv: "Berghäll" };
    const ready = async (home: HomeSummary | null) => {
      fakeApi([[]], { home });
      await show(<ProfileScreen />);
      await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    };

    it("stands between the photos and the sections, and opens the home's screen", async () => {
      await ready({ town, area, showArea: false });
      const rows = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
      expect(rows.indexOf("Home")).toBe(rows.indexOf("Photos") + 1);
      expect(rows.indexOf("Home")).toBeLessThan(rows.indexOf("The basics"));
      await press(screen.getByRole("button", { name: "Home" }));
      expect(router.push).toHaveBeenCalledWith("/profile/place");
    });

    it.each([
      ["the town", { town, area, showArea: false }, "Helsinki"],
      ["the area the person chose", { town, area, showArea: true }, "Kallio"],
      ["the town where no area is kept", { town, area: null, showArea: false }, "Helsinki"],
    ])("says %s, what the card says, heard as the hint", async (_what, home, name) => {
      await ready(home);
      expect(screen.getByText(name)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Home" }).props.accessibilityHint).toBe(name);
    });

    it("says the name in the reader's language, and never digits", async () => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "sv-FI" }]);
      try {
        fakeApi([[]], { home: { town, area, showArea: false } });
        await show(<ProfileScreen />);
        await waitFor(() => expect(screen.getByText("Hem")).toBeTruthy());
        expect(screen.getByText("Helsingfors")).toBeTruthy();
        expect(screen.queryByText(/\d{5}/)).toBeNull();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });

    it("carries no mark or progress: a home is there or the step is open", async () => {
      await ready({ town, area, showArea: false });
      expect(progressValue("Home")).toBeUndefined();
    });

    it("has nothing under its title for somebody with no home, and still opens", async () => {
      await ready(null);
      const row = screen.getByRole("button", { name: "Home" });
      expect(row.props.accessibilityHint).toBeUndefined();
      await press(row);
      expect(router.push).toHaveBeenCalledWith("/profile/place");
    });

    it("reads a new home when the list is back in front", async () => {
      const api = fakeApi([[]], { home: { town, area, showArea: false } });
      await show(<ProfileScreen />);
      await waitFor(() => expect(screen.getByText("Helsinki")).toBeTruthy());
      fakeApi([[]], { home: { town, area, showArea: true } });
      await act(async () => {
        focus();
        await settle();
      });
      await waitFor(() => expect(screen.getByText("Kallio")).toBeTruthy());
      expect(api.reads()).toBe(1);
    });
  });

  it("keeps the title, the way back and the card's button pinned above the list", async () => {
    fakeApi([["display_name", "photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expectPinnedHeader("Your profile", "Back");
    expectPinnedHeader("Your profile", "See your card");
  });

  it("lists the photos and the sections, after what the card still needs, every row labelled", async () => {
    fakeApi([["display_name", "photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.getByText("Before your card can be shown")).toBeTruthy();
    expect(screen.getByText("At least 2 approved photos")).toBeTruthy();
    for (const title of [
      "Photos",
      "Home",
      "Gender",
      "Questions",
      "Relationship and kids",
      "Work and education",
      "Lifestyle",
      "Hobbies",
      "Beliefs",
    ]) {
      expect(screen.getByRole("button", { name: title })).toBeTruthy();
    }
    // No lead text about the card: a dating app's profile explains itself (#239).
    expect(screen.queryByText(/What others see on your card/)).toBeNull();
    // Nothing is edited on the list, so there is nothing to save.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryAllByText(/^profile\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    // The back arrow and the eye, the photos, the home, the gender and seven sections, What you seek and the later questions.
    expect(found).toHaveLength(14);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  describe("what each row holds, heard and not drawn (#581)", () => {
    const row = (name: string) => screen.getByRole("button", { name });
    const ready = async () => {
      fakeApi([[]]);
      await show(<ProfileScreen />);
      await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    };
    const HINTS = [
      ["The basics", "Name, a few words about you, height and languages"],
      ["Relationship and kids", "Relationship structure and kids"],
      ["Work and education", "Education, field, work and job title"],
      ["Lifestyle", "Smoking, nicotine, drinking, drugs, exercise and pets"],
      ["Hobbies", "Things you like doing, as many as you like"],
      ["Beliefs", "Parties you could vote for, religion and star sign"],
    ];

    it.each(HINTS)(
      "says what %s holds to a screen reader, and draws no second line",
      async (title, hint) => {
        await ready();
        expect(row(title).props.accessibilityHint).toBe(hint);
        expect(screen.queryByText(hint)).toBeNull();
        expect(screen.queryByText(hint, { includeHiddenElements: true })).toBeNull();
      },
    );

    it.each([
      ["Photos", "What others see first on your card"],
      ["Questions", "Up to three questions, answered in your own words"],
      ["What you seek", "Whom, what ages, what you are here for and your deal-breakers"],
    ])("has no hint on %s, and no line: its title and its count say it", async (title, line) => {
      await ready();
      expect(row(title).props.accessibilityHint).toBeUndefined();
      expect(screen.queryByText(line)).toBeNull();
    });

    it("draws each row's title and count alone: the list fits one phone screen", async () => {
      await ready();
      const lines = (title: string) =>
        within(row(title))
          .getAllByText(/./, { includeHiddenElements: true })
          .map((node) => node.props.children);
      expect(lines("Lifestyle")).toEqual(["Lifestyle", "0/6"]);
      expect(lines("Questions")).toEqual(["Questions", "0/3"]);
      expect(lines("Photos")).toEqual(["Photos", "0/2"]);
      expect(lines("What you seek")).toEqual(["What you seek"]);
    });

    it.each([
      [
        "fi-FI",
        "Elämäntavat",
        "Tupakointi, nikotiini, alkoholi, huumeet, liikunta ja lemmikit",
        "Kysymykset",
      ],
      ["sv-FI", "Livsstil", "Rökning, nikotin, alkohol, droger, motion och husdjur", "Frågor"],
    ])("says it in %s", async (tag, title, hint, questions) => {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: tag }]);
      try {
        fakeApi([[]]);
        await show(<ProfileScreen />);
        await waitFor(() => expect(row(title)).toBeTruthy());
        expect(row(title).props.accessibilityHint).toBe(hint);
        expect(screen.queryByText(hint)).toBeNull();
        expect(row(questions).props.accessibilityHint).toBeUndefined();
      } finally {
        (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
      }
    });
  });

  it("says nothing about the card once it is complete (#239)", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.queryByText("Before your card can be shown")).toBeNull();
    expect(screen.queryByText(/complete/i)).toBeNull();
  });

  it("marks how far each part is filled: a check mark once done, the words for a screen reader (#239)", async () => {
    fakeApi([[]], {
      document: {
        displayName: "Aino",
        bio: "Long walks and short questions.",
        fields: {
          intent: "long_term",
          height: 172,
          languages: ["fi"],
          monogamy: "monogamous",
          hasKids: "no",
          wantsKids: "want",
          smoking: "never",
          hobbies: ["sauna"],
          // A setting and a free text: neither counts (the job title is no gap).
          hideFromField: true,
          occupationTitle: "Nurse",
          field: ["health"],
        },
        prompts: [{ key: "sunday", answer: "A long breakfast." }],
      },
      photos: [approved(1)],
    });
    await show(<ProfileScreen />);
    // Photos are approved, not answered.
    await waitFor(() => expect(progressValue("Photos")).toBe("1 of 2 approved"));
    expect(progressValue("The basics")).toBe("Done");
    expect(progressValue("Questions")).toBe("1 of 3 answered");
    expect(progressValue("Relationship and kids")).toBe("Done");
    expect(progressValue("Work and education")).toBe("1 of 3 answered");
    expect(progressValue("Lifestyle")).toBe("1 of 6 answered");
    expect(progressValue("Hobbies")).toBe("Done");
    expect(progressValue("Beliefs")).toBe("0 of 3 answered");
    // The label stays the title alone, so the row is found by its name whatever its state.
    expect(screen.getByRole("button", { name: "Hobbies" }).props.accessibilityLabel).toBe(
      "Hobbies",
    );
    // A count on every part not yet done, where one question is one item (#581), and a
    // check mark on the rest, each hidden from screen readers, which hear the value instead.
    const hidden = { includeHiddenElements: true };
    expect(screen.getAllByText(/^\d+\/\d+$/, hidden).map((node) => node.props.children)).toEqual([
      "1/2",
      "1/3",
      "1/3",
      "1/6",
      "0/3",
    ]);
    expect(screen.queryAllByText(/^\d+\/\d+$/)).toEqual([]);
    expect(screen.getAllByTestId("progress-done", hidden)).toHaveLength(3);
    expect(screen.queryAllByTestId("progress-done")).toEqual([]);
    // No mark on What you seek or the later questions: neither is a part one fills.
    expect(progressValue("What you seek")).toBeUndefined();
    expect(progressValue("Fill in the rest when you have a moment")).toBeUndefined();
  });

  it("draws the count on every part with nothing answered, the section that left the list none (#542, #581)", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Photos")).toBe("0 of 2 approved"));
    const hidden = { includeHiddenElements: true };
    const markOf = (name: string) =>
      within(screen.getByRole("button", { name }))
        .queryAllByText(/^\d+\/\d+$/, hidden)
        .map((node) => node.props.children);
    expect(
      [
        "Photos",
        "The basics",
        "Questions",
        "Relationship and kids",
        "Work and education",
        "Lifestyle",
        "Hobbies",
        "Beliefs",
      ].map((name) => [name, markOf(name)]),
    ).toEqual([
      ["Photos", ["0/2"]],
      ["The basics", ["0/4"]],
      ["Questions", ["0/3"]],
      ["Relationship and kids", ["0/3"]],
      ["Work and education", ["0/3"]],
      ["Lifestyle", ["0/6"]],
      ["Hobbies", ["0/1"]],
      ["Beliefs", ["0/3"]],
    ]);
  });

  it("counts three in the relationship now what one is here for has left it (#542)", async () => {
    fakeApi([[]], {
      document: { fields: { monogamy: "monogamous", hasKids: "no", wantsKids: "want" } },
    });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Relationship and kids")).toBe("Done"));
  });

  describe("What you seek's row (#542)", () => {
    const ready = async (document?: Document) => {
      fakeApi([[]], { document });
      await show(<ProfileScreen />);
      await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    };

    it("opens the list, its title alone (#581)", async () => {
      await ready();
      const row = screen.getByRole("button", { name: "What you seek" });
      expect(row.props.accessibilityHint).toBeUndefined();
      expect(
        within(row)
          .getAllByText(/./)
          .map((node) => node.props.children),
      ).toEqual(["What you seek"]);
      await press(row);
      expect(router.push).toHaveBeenCalledWith("/profile/seek");
    });

    it("holds no answer, whatever is answered: the list is where those are", async () => {
      await ready({ fields: { intent: "casual" } });
      const row = screen.getByRole("button", { name: "What you seek" });
      expect(row.props.accessibilityHint).toBeUndefined();
      expect(row.props.accessibilityValue?.text).toBeUndefined();
      expect(screen.queryByText("Something casual")).toBeNull();
    });

    it("takes the deal-breakers' place, and what one is here for has no row: one answer, one door", async () => {
      await ready();
      expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
        "Back",
        "See your card",
        "Photos",
        "Home",
        "Gender",
        "The basics",
        "Questions",
        "Relationship and kids",
        "Work and education",
        "Lifestyle",
        "Hobbies",
        "Beliefs",
        "What you seek",
        "Fill in the rest when you have a moment",
      ]);
    });
  });

  describe("the gender's row (#552)", () => {
    const row = () => screen.getByRole("button", { name: "Gender" });
    const ready = async (gender?: string | (() => string) | "failing") => {
      fakeApi([[]], gender === undefined ? {} : { gender });
      await show(<ProfileScreen />);
      await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    };

    it("stands beside the home, and opens the gender's screen", async () => {
      await ready();
      const rows = screen.getAllByRole("button").map((node) => node.props.accessibilityLabel);
      expect(rows.indexOf("Gender")).toBe(rows.indexOf("Home") + 1);
      await press(row());
      expect(router.push).toHaveBeenCalledWith("/profile/gender");
    });

    it("says the answer under its title, heard once as its value, with no mark", async () => {
      await ready("non_binary");
      await waitFor(() => expect(screen.getByText("Non-binary")).toBeTruthy());
      expect(row().props.accessibilityValue?.text).toBe("Non-binary");
      expect(row().props.accessibilityHint).toBeUndefined();
    });

    it("reads the answer again when the list is back in front, after a change on its screen", async () => {
      let stored = "woman";
      await ready(() => stored);
      await waitFor(() => expect(screen.getByText("Woman")).toBeTruthy());
      stored = "man";
      await act(async () => {
        focus();
        await settle();
      });
      expect(screen.getByText("Man")).toBeTruthy();
      expect(screen.queryByText("Woman")).toBeNull();
    });

    it("shows its title alone when the status cannot be read: its screen says what failed", async () => {
      await ready("failing");
      expect(row().props.accessibilityValue?.text).toBeUndefined();
      expect(screen.queryByText("Woman")).toBeNull();
    });

    it("takes back an answer it can no longer vouch for when a read again fails", async () => {
      let stored = "woman";
      await ready(() => stored);
      await waitFor(() => expect(screen.getByText("Woman")).toBeTruthy());
      stored = "failing";
      await act(async () => {
        focus();
        await settle();
      });
      expect(screen.queryByText("Woman")).toBeNull();
    });
  });

  it("marks the photos done at the two a card needs, and leaves the mark out when the list cannot be read", async () => {
    fakeApi([[]], { photos: [approved(1), approved(2), approved(3)] });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Photos")).toBe("Done"));
    fakeApi([[]], { photos: "failing" });
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getAllByText("The basics").length).toBeGreaterThan(0));
    expect(
      screen.getAllByRole("button", { name: "Photos" }).at(-1)?.props.accessibilityValue?.text,
    ).toBeUndefined();
  });

  it("invites to the later questions only while one is unanswered (#239)", async () => {
    const all = Object.fromEntries(
      [...LATER_FIELD_ORDER, "nicotine" as const].map((key) => [key, answerOf(key)]),
    ) as Record<string, unknown>;
    fakeApi([[]], { document: { fields: all } });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Hobbies")).toBe("Done"));
    expect(
      screen.queryByRole("button", { name: "Fill in the rest when you have a moment" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "What you seek" })).toBeTruthy();
  });

  it("keeps the invitation while other nicotine alone is unanswered, as the smoking screen asks it (#239)", async () => {
    const all = Object.fromEntries(LATER_FIELD_ORDER.map((key) => [key, answerOf(key)])) as Record<
      string,
      unknown
    >;
    fakeApi([[]], { document: { fields: all } });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Lifestyle")).toBe("5 of 6 answered"));
    expect(
      screen.getByRole("button", { name: "Fill in the rest when you have a moment" }),
    ).toBeTruthy();
  });

  it("opens the photos, a section, the card from the eye, What you seek and the later questions", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("Lifestyle")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Photos" }));
    await press(screen.getByRole("button", { name: "Lifestyle" }));
    await press(screen.getByRole("button", { name: "See your card" }));
    await press(screen.getByRole("button", { name: "What you seek" }));
    await press(screen.getByRole("button", { name: "Fill in the rest when you have a moment" }));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/photos",
      "/profile/section/lifestyle",
      "/profile/card",
      "/profile/seek",
      expect.stringMatching(/^\/profile\/later\//),
    ]);
  });

  it("reads the profile again when a section hands back, and the checklist follows", async () => {
    const api = fakeApi([["display_name", "photos"], ["photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("A name on the card")).toBeTruthy());
    expect(api.reads()).toBe(1);
    expect(api.photoReads()).toBe(1);
    await act(async () => {
      focus();
      await settle();
    });
    expect(api.reads()).toBe(2);
    // The photos too: the photos screen hands back the same way.
    expect(api.photoReads()).toBe(2);
    expect(screen.queryByText("A name on the card")).toBeNull();
    // The list stays while it reads: no loading screen in between.
    expect(screen.getByText("At least 2 approved photos")).toBeTruthy();
  });

  it("says when the profile could not be loaded and tries again on request, the photos too", async () => {
    let failing = true;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (failing) {
        return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
      }
      if (new URL(request.url).pathname === "/photos") {
        return json({ photos: [approved(1), approved(2)], maxPhotos: 6, tips: [] });
      }
      return json({ profile: null, completeness: { complete: true, missing: [] }, home: null });
    }) as unknown as typeof fetch;
    await show(<ProfileScreen />);
    expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy();
    // Why, in words: the API answered 500.
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    failing = false;
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    // The photos failed with the profile, and are read again with it.
    expect(progressValue("Photos")).toBe("Done");
  });

  it("offers to update the app when the API answers what this build cannot read", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({
        profile: null,
        completeness: { complete: true, missing: ["a_later_item"] },
      }),
    ) as unknown as typeof fetch;
    await show(<ProfileScreen />);
    expect(screen.getByText("Your profile could not be loaded.")).toBeTruthy();
    expect(screen.getByText(/older than Kuutti's server/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update the app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("goes back with its back button", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
