import { LATER_FIELD_ORDER, PROFILE_FIELDS, type ProfileFieldKey } from "@kuutti/schema";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
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
 * last one again after that. `tips` are the advisory kinds of #56 (none by
 * default); `fishSpecies` the fish the fish tip names (#253), absent by default
 * as from an API older than it; `document` the stored profile (none by
 * default); `photos` the photo list's photos (none by default), or "failing"
 * for a list that cannot be read.
 */
function fakeApi(
  missingByRead: string[][],
  tips: string[] = [],
  fishSpecies?: string,
  {
    document,
    photos = [],
  }: { document?: Document; photos?: ReturnType<typeof approved>[] | "failing" } = {},
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
        tips,
        ...(fishSpecies ? { fishSpecies } : {}),
      });
    }
    if (path === "/photos" && request.method === "GET") {
      photoReads += 1;
      if (photos === "failing") {
        return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
      }
      return json({ photos, maxPhotos: 6 });
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
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("ProfileScreen", () => {
  it("lists the photos and the sections with what each holds, after what the card still needs, every row labelled", async () => {
    fakeApi([["display_name", "photos"]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.getByText("Before your card can be shown")).toBeTruthy();
    expect(screen.getByText("At least 2 approved photos")).toBeTruthy();
    for (const title of [
      "Photos",
      "Prompts",
      "Relationship and kids",
      "Work and education",
      "Lifestyle",
      "Hobbies",
      "Beliefs",
    ]) {
      expect(screen.getByRole("button", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("Smoking, nicotine, drinking, drugs, exercise and pets")).toBeTruthy();
    expect(screen.getByText("What others see first on your card")).toBeTruthy();
    // No lead text about the card: a dating app's profile explains itself (#239).
    expect(screen.queryByText(/What others see on your card/)).toBeNull();
    // Nothing is edited on the list, so there is nothing to save.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryAllByText(/^profile\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    // The back arrow and the eye, the photos and seven sections, the deal-breakers and the later questions.
    expect(found).toHaveLength(12);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
  });

  it("says nothing about the card once it is complete (#239)", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.queryByText("Before your card can be shown")).toBeNull();
    expect(screen.queryByText(/complete/i)).toBeNull();
  });

  it("marks how far each part is filled: a check mark once done, the words for a screen reader (#239)", async () => {
    fakeApi([[]], [], undefined, {
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
    expect(progressValue("Prompts")).toBe("1 of 3 answered");
    expect(progressValue("Relationship and kids")).toBe("Done");
    expect(progressValue("Work and education")).toBe("1 of 3 answered");
    expect(progressValue("Lifestyle")).toBe("1 of 6 answered");
    expect(progressValue("Hobbies")).toBe("Done");
    expect(progressValue("Beliefs")).toBe("0 of 3 answered");
    // The label stays the title alone, so the row is found by its name whatever its state.
    expect(screen.getByRole("button", { name: "Hobbies" }).props.accessibilityLabel).toBe(
      "Hobbies",
    );
    // Rows take turns between the two marks for the maintainer to compare (#239):
    // the photos, prompts, work and hobbies rows carry a ring (one of them done),
    // the basics, relationship, lifestyle and beliefs rows a count (two of them done).
    // Both are hidden from screen readers, which hear the value instead.
    const hidden = { includeHiddenElements: true };
    expect(screen.getAllByTestId("progress-ring", hidden)).toHaveLength(3);
    expect(screen.queryAllByTestId("progress-ring")).toEqual([]);
    expect(screen.getByText("1/6", hidden)).toBeTruthy();
    expect(screen.getByText("0/3", hidden)).toBeTruthy();
    expect(screen.queryByText("1/6")).toBeNull();
    // No mark on the deal-breakers or the later questions: neither is a part one fills.
    expect(progressValue("Your deal-breakers")).toBeUndefined();
    expect(progressValue("Fill in the rest while you wait")).toBeUndefined();
  });

  it("marks the photos done at the two a card needs, and leaves the mark out when the list cannot be read", async () => {
    fakeApi([[]], [], undefined, { photos: [approved(1), approved(2), approved(3)] });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Photos")).toBe("Done"));
    fakeApi([[]], [], undefined, { photos: "failing" });
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
    fakeApi([[]], [], undefined, { document: { fields: all } });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Hobbies")).toBe("Done"));
    expect(screen.queryByRole("button", { name: "Fill in the rest while you wait" })).toBeNull();
    expect(screen.getByRole("button", { name: "Your deal-breakers" })).toBeTruthy();
  });

  it("keeps the invitation while other nicotine alone is unanswered, as the smoking screen asks it (#239)", async () => {
    const all = Object.fromEntries(LATER_FIELD_ORDER.map((key) => [key, answerOf(key)])) as Record<
      string,
      unknown
    >;
    fakeApi([[]], [], undefined, { document: { fields: all } });
    await show(<ProfileScreen />);
    await waitFor(() => expect(progressValue("Lifestyle")).toBe("5 of 6 answered"));
    expect(screen.getByRole("button", { name: "Fill in the rest while you wait" })).toBeTruthy();
  });

  it("shows one tip at a time; a dismissed one gives way to the next and stays dismissed", async () => {
    fakeApi([[]], ["sunglasses", "few_photos"]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("A tip for your photos")).toBeTruthy());
    expect(screen.getByText(/without sunglasses/)).toBeTruthy();
    expect(screen.queryByText(/fuller picture/)).toBeNull();
    expect(screen.queryAllByText(/^profile\.tip\./)).toEqual([]);
    const found = pressables(screen.toJSON() as HostNode);
    // The twelve of the list plus the tip's dismiss.
    expect(found).toHaveLength(13);
    expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
    await press(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/without sunglasses/)).toBeNull();
    expect(screen.getByText(/fuller picture/)).toBeTruthy();
    // A profile screen opened again keeps the dismissal for this run.
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText(/fuller picture/)).toBeTruthy());
    expect(screen.queryByText(/without sunglasses/)).toBeNull();
    await press(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("A tip for your photos")).toBeNull();
  });

  it("names the fish of the fish tip when the API is sure of it (#253)", async () => {
    fakeApi([[]], ["fish"], "pike");
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText(/Is that a pike\?/)).toBeTruthy());
  });

  it("says the plain fish tip when the API names no fish", async () => {
    fakeApi([[]], ["fish"]);
    await show(<ProfileScreen />);
    await waitFor(() =>
      expect(screen.getByText(/A fish in the main photo is a classic/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Is that/)).toBeNull();
  });

  it("opens the photos, a section, the card from the eye, the deal-breakers and the later questions", async () => {
    fakeApi([[]]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("Lifestyle")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Photos" }));
    await press(screen.getByRole("button", { name: "Lifestyle" }));
    await press(screen.getByRole("button", { name: "See your card" }));
    await press(screen.getByRole("button", { name: "Your deal-breakers" }));
    await press(screen.getByRole("button", { name: "Fill in the rest while you wait" }));
    expect(router.push.mock.calls.map(([path]) => path)).toEqual([
      "/photos",
      "/profile/section/lifestyle",
      "/profile/card",
      "/profile/deal-breakers",
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
        return json({ photos: [approved(1), approved(2)], maxPhotos: 6 });
      }
      return json({ profile: null, completeness: { complete: true, missing: [] }, tips: [] });
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

  it("leaves out a tip this build does not know, and loads the rest", async () => {
    // A newer API names a tip kind this app has no words for yet.
    // mirror_selfie: a kind no earlier test dismisses for the app's run.
    fakeApi([[]], ["a_kind_from_a_later_api", "mirror_selfie"]);
    await show(<ProfileScreen />);
    await waitFor(() => expect(screen.getByText("The basics")).toBeTruthy());
    expect(screen.getByText("Try a photo that is not a mirror selfie.")).toBeTruthy();
    expect(screen.queryByText("Your profile could not be loaded.")).toBeNull();
  });

  it("offers to update the app when the API answers what this build cannot read", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({
        profile: null,
        completeness: { complete: true, missing: ["a_later_item"] },
        tips: [],
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
