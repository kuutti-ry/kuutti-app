import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import type * as React from "react";
import { saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { defaultAgeWindow, OnboardingScreen } from "./OnboardingScreen";

const { __router: router, __focus: focus } = jest.requireMock("expo-router") as {
  __router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
  __focus: () => void;
};
// Long enough for a step's call and the status reads that follow it: an
// update that lands outside an act scope is never flushed in this runtime.
const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const flush = () => act(() => settle(120));
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
// The versions this build carries, each kind its own since the privacy
// summary moved on alone (#102): what the welcome step shows and records.
const TERMS = CONSENT_VERSIONS.terms;
const PRIVACY = CONSENT_VERSIONS.privacy;
const RESEARCH = CONSENT_VERSIONS.research;
const SPECIAL = CONSENT_VERSIONS.special_category;
const POND = {
  id: "5f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a00",
  slug: "suomi",
  name: "Suomi",
  nameInessive: "Suomessa",
  parentId: null,
};
const CAPITAL = {
  id: "5f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a01",
  slug: "paakaupunkiseutu",
  name: "Pääkaupunkiseutu",
  nameInessive: "Pääkaupunkiseudulla",
  parentId: null,
};
const ACTIVATION = ["gender", "seeks", "age_window", "pond", "terms", "privacy"];

type Profile = {
  displayName: string;
  bio: string | null;
  bioPreset: string | null;
  fields: Record<string, unknown>;
  prompts: { key: string; answer: string }[];
};

/**
 * A tiny server: the status is computed from what the steps wrote, as the API
 * does (#146). It answers the invitations (#107) only when a test says whether
 * a code may be typed; otherwise their read is a 404, which onboarding passes
 * over without a word.
 */
function fakeApi(
  options: { version?: string; age?: number; redeemable?: boolean; redeem?: () => Response } = {},
) {
  // A version the API holds as current that this build does not carry, for every kind but the sensitive answers'.
  const current = (version: string) => options.version ?? version;
  const server: {
    gender: string | null;
    seeks: string[] | null;
    ageWindow: { min: number; max: number } | null;
    /** Every row given; a withdrawn one keeps its row with the time (ADR-010 §4). */
    consents: { kind: string; version: string; locale: string; withdrawnAt?: string }[];
    profile: Profile | null;
    photos: number;
    /** From when a gender change is possible again; set, the API refuses one with 429 (#147). */
    genderFrom: string | null;
    /** The pond; null when there is more than one and the person has not chosen (#174). */
    pond: typeof POND | null;
  } = {
    gender: null,
    seeks: null,
    ageWindow: null,
    consents: [],
    profile: null,
    photos: 0,
    genderFrom: null,
    pond: POND,
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const has = (kind: string, version: string) =>
    server.consents.some((c) => c.kind === kind && c.version === version && !c.withdrawnAt);
  const status = () => {
    const bio = server.profile?.bio ?? "";
    const prompts = server.profile?.prompts.filter((p) => p.answer.length > 0).length ?? 0;
    const missing = [
      ...(has("terms", TERMS) ? [] : ["terms"]),
      ...(has("privacy", PRIVACY) ? [] : ["privacy"]),
      ...(server.profile?.displayName ? [] : ["name"]),
      ...(server.gender ? [] : ["gender"]),
      ...(server.seeks && has("special_category", SPECIAL) ? [] : ["seeks"]),
      ...(server.profile?.fields.intent ? [] : ["intent"]),
      ...(server.ageWindow ? [] : ["age_window"]),
      ...(server.pond ? [] : ["pond"]),
      ...(server.photos >= 3 ? [] : ["photos"]),
      // A ready line counts like a bio (#239), as the API's completeness has it.
      ...(bio.length >= 50 || server.profile?.bioPreset || prompts >= 2 ? [] : ["prompts_or_bio"]),
    ];
    const research = server.consents.find((c) => c.kind === "research" && !c.withdrawnAt);
    return {
      state: missing.some((step) => ACTIVATION.includes(step)) ? "registered" : "active",
      age: options.age ?? 36,
      gender: server.gender,
      pond: server.pond,
      preferences: { seeks: server.seeks, ageWindow: server.ageWindow },
      consents: {
        terms: has("terms", TERMS) ? TERMS : null,
        privacy: has("privacy", PRIVACY) ? PRIVACY : null,
        specialCategory: has("special_category", SPECIAL) ? SPECIAL : null,
        research: research ? { version: RESEARCH, givenAt: "2026-09-26T10:00:00.000Z" } : null,
      },
      currentVersions: {
        terms: current(TERMS),
        privacy: current(PRIVACY),
        research: current(RESEARCH),
        special_category: SPECIAL,
      },
      nextChange: { gender: server.genderFrom, seeks: null },
      missing,
      complete: missing.length === 0,
    };
  };
  const profileResponse = () => ({
    profile: server.profile
      ? { ...server.profile, specialCategoryConsent: null, updatedAt: "2026-09-26T10:00:00.000Z" }
      : null,
    completeness: { complete: false, missing: [] },
  });
  globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "GET" ? undefined : await request.json();
    calls.push({ method: request.method, path, body });
    if (path === "/onboarding") return json(status());
    if (path === "/invitations" && options.redeemable !== undefined) {
      return json({
        canInvite: false,
        redeemable: options.redeemable,
        reward: { fish: 1, likes: 0 },
        open: [],
        counted: 0,
        earned: { fish: 0, likes: 0 },
      });
    }
    if (path === "/invitations/redeem") {
      return options.redeem?.() ?? new Response(null, { status: 204 });
    }
    if (path === "/profile" && request.method === "GET") return json(profileResponse());
    if (path === "/profile") {
      const b = body as Profile;
      server.profile = {
        displayName: b.displayName,
        bio: b.bio,
        bioPreset: b.bioPreset,
        fields: b.fields,
        prompts: b.prompts,
      };
      return json(profileResponse());
    }
    if (path === "/account/gender" && server.genderFrom) {
      const error = { code: "change_too_soon", message: "Changed recently", requestId: "r" };
      return json({ error }, 429);
    }
    if (path === "/account/gender") {
      server.gender = (body as { gender: string }).gender;
      return new Response(null, { status: 204 });
    }
    if (path === "/ponds") return json({ ponds: [CAPITAL, POND] });
    if (path === "/account/pond") {
      const { pondId } = body as { pondId: string };
      server.pond = [CAPITAL, POND].find((pond) => pond.id === pondId) ?? null;
      return new Response(null, { status: 204 });
    }
    if (path === "/preferences") {
      // Either row or both, each replacing its own (ADR-010 §13).
      const b = body as { seeks?: string[]; ageWindow?: { min: number; max: number } };
      if (b.seeks) server.seeks = b.seeks;
      if (b.ageWindow) server.ageWindow = b.ageWindow;
      return json({ seeks: server.seeks, ageWindow: server.ageWindow });
    }
    if (path === "/consents") {
      if (request.method === "POST") {
        server.consents.push(body as { kind: string; version: string; locale: string });
      }
      return json({
        // The newest hundred, as the API lists them (ADR-010 §4).
        consents: server.consents.slice(-100).map((c) => ({
          ...c,
          givenAt: "2026-09-26T10:00:00.000Z",
          withdrawnAt: c.withdrawnAt ?? null,
        })),
        currentVersions: status().currentVersions,
      });
    }
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  return { server, calls };
}

const checkA11y = () => {
  const found = pressables(screen.toJSON() as HostNode);
  expect(found.flatMap((node) => a11yProblems(node))).toEqual([]);
};
const consented = (kind: string) => ({
  kind,
  version: { terms: TERMS, privacy: PRIVACY, research: RESEARCH, special_category: SPECIAL }[
    kind as "terms" | "privacy" | "research" | "special_category"
  ],
  locale: "en",
});

const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const AGREED = "kuutti.preference.agreedVersions";

beforeEach(async () => {
  router.replace.mockReset();
  router.push.mockReset();
  store.delete(AGREED);
  await saveSession({
    sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
    accessToken: token("access"),
    accessExpiresAt: "2030-01-01T00:15:00.000Z",
    refreshToken: token("refresh"),
    refreshExpiresAt: "2030-04-01T00:00:00.000Z",
  });
});

describe("OnboardingScreen", () => {
  it("walks a registered account through the sheet's steps with buttons and leaves when nothing is missing", async () => {
    // The terms and the privacy summary became rows right after the bank login (#418):
    // the first question is the name, the first of eight numbered steps.
    const { server, calls } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(screen.queryByText("How we do things here")).toBeNull();
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    checkA11y();
    await type(screen.getByLabelText("Name on your card"), "Aino");
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    expect(server.profile?.displayName).toBe("Aino");
    checkA11y();
    expect(screen.getByText("Step 2 of 8")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Woman" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    expect(server.gender).toBe("woman");
    expect(screen.getByText("Step 3 of 8")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Men" }));
    await press(screen.getByRole("button", { name: "Non-binary people" }));
    // Nothing moves on without the article 9 consent, given on this screen.
    expect(
      screen.getByRole("button", { name: "Continue" }).props.accessibilityState?.disabled,
    ).toBe(true);
    expect(screen.getByText(/special categories of personal data/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: `Read the full text on kuutti.app (version ${SPECIAL})` }),
    ).toBeTruthy();
    await press(screen.getByLabelText("I consent to Kuutti storing whom I seek"));
    await flush();
    expect(server.consents.at(-1)).toEqual(consented("special_category"));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("What are you here for?")).toBeTruthy());
    // Whom one seeks is saved on leaving its screen, before the ages (ADR-010 §13).
    expect(server.seeks).toEqual(["man", "non_binary"]);
    expect(server.ageWindow).toBeNull();
    checkA11y();
    await press(screen.getByRole("button", { name: "Something casual" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What ages?")).toBeTruthy());
    expect(server.profile?.fields).toEqual({ intent: "casual" });
    // The window starts around the person's own age (36): 31 to 41, moved by buttons.
    expect(screen.getByText("31")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Youngest, one year younger" }));
    await press(screen.getByRole("button", { name: "Oldest, one year older" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("Two photos of you")).toBeTruthy());
    expect(server.seeks).toEqual(["man", "non_binary"]);
    expect(server.ageWindow).toEqual({ min: 30, max: 42 });
    checkA11y();
    // The pond is a step only where there is a choice (#174): its number stays, unshown here.
    expect(screen.getByText("Step 7 of 8")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Add photos" }));
    // The photos screen says the same step as every other one (#146).
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/photos",
      params: { step: "7", total: "8" },
    });
    // Back from the photos screen with three photos: the focus reads the status again.
    server.photos = 3;
    await act(async () => {
      focus();
      await settle(120);
    });
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    expect(screen.getByText("Step 8 of 8")).toBeTruthy();
    checkA11y();
    await type(
      screen.getByLabelText("About you"),
      "A bio long enough to count for completeness, which is fifty characters.",
    );
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    expect(server.consents.map((c) => c.kind)).toEqual(["terms", "privacy", "special_category"]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([
      "/profile",
      "/account/gender",
      "/consents",
      "/preferences",
      "/profile",
      "/preferences",
      "/profile",
    ]);
    expect(calls.filter((c) => c.path === "/preferences" && c.method === "PUT")).toEqual([
      { method: "PUT", path: "/preferences", body: { seeks: ["man", "non_binary"] } },
      { method: "PUT", path: "/preferences", body: { ageWindow: { min: 30, max: 42 } } },
    ]);
  });

  it("offers a friend's invitation code once, right after the welcome, counting no step, and Skip goes on to the name (#107, #418)", async () => {
    const { calls } = fakeApi({ redeemable: true });
    await show(<OnboardingScreen />);
    await press(await screen.findByRole("button", { name: "I'm in, and I accept both" }));
    await flush();
    await waitFor(() => expect(screen.getByText("Did a friend invite you?")).toBeTruthy());
    // Offered once and never required: no number, as the welcome step has none.
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull();
    expect(screen.getByLabelText("Invitation code")).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    // Once a walk: the status read again on focus does not bring it back.
    await act(async () => {
      focus();
      await settle(120);
    });
    expect(screen.getByText("What should we call you?")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/invitations")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/invitations/redeem")).toEqual([]);
  });

  it("takes a code that works, thanks the person, and Continue goes on to the name (#107)", async () => {
    const { server, calls } = fakeApi({ redeemable: true });
    server.consents.push(consented("terms"), consented("privacy"));
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Did a friend invite you?")).toBeTruthy());
    await type(screen.getByLabelText("Invitation code"), "abcde-fghjk");
    await press(screen.getByRole("button", { name: "Use the code" }));
    expect(calls.filter((c) => c.path === "/invitations/redeem")).toEqual([
      { method: "POST", path: "/invitations/redeem", body: { code: "abcde-fghjk" } },
    ]);
    expect(
      screen.getByText(
        "The code is in. Your friend's invitation counts once your profile is complete.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    checkA11y();
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
  });

  it("says a refused code in the API's words and stays at the step until it is skipped (#107)", async () => {
    const { server } = fakeApi({
      redeemable: true,
      redeem: () =>
        json({ error: { code: "invitation_unknown", message: "x", requestId: "r" } }, 404),
    });
    server.consents.push(consented("terms"), consented("privacy"));
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Did a friend invite you?")).toBeTruthy());
    await type(screen.getByLabelText("Invitation code"), "ABCDE FGHJK");
    await press(screen.getByRole("button", { name: "Use the code" }));
    expect(screen.getByText("That code does not work. Check it and try again.")).toBeTruthy();
    // The step's own words, not onboarding's: nothing in onboarding failed.
    expect(screen.queryByText("Something did not load. Try again.")).toBeNull();
    expect(screen.getByText("Did a friend invite you?")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
  });

  it.each([
    ["the API says no code may be typed", false],
    ["the invitations cannot be read", undefined],
  ])("goes straight on to the name when %s (#107)", async (_why, redeemable) => {
    const { server, calls } = fakeApi({ redeemable });
    server.consents.push(consented("terms"), consented("privacy"));
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(screen.queryByText("Did a friend invite you?")).toBeNull();
    expect(calls.filter((c) => c.path === "/invitations")).toHaveLength(1);
  });

  it("does not offer the code to a walk resumed past the name, and asks nothing about it (#107)", async () => {
    const { server, calls } = fakeApi({ redeemable: true });
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Onni", bio: null, bioPreset: null, fields: {}, prompts: [] };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    expect(calls.filter((c) => c.path === "/invitations")).toEqual([]);
  });

  it("resumes at the intent with whom one seeks kept when the app closed before the ages", async () => {
    // What a relaunch finds after leaving the seek screen: the answer and its consent stored,
    // the intent and the window not yet (ADR-010 §13). The screen's own memory is empty.
    const { server, calls } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.profile = { displayName: "Onni", bio: null, bioPreset: null, fields: {}, prompts: [] };
    server.gender = "non_binary";
    server.seeks = ["woman", "man", "non_binary"];
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("What are you here for?")).toBeTruthy());
    expect(screen.queryByText("Whom are you looking for?")).toBeNull();
    await press(screen.getByRole("button", { name: "Something long-term" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What ages?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    expect(server.seeks).toEqual(["woman", "man", "non_binary"]);
    expect(server.ageWindow).toEqual({ min: 31, max: 41 });
    expect(calls.filter((c) => c.path === "/preferences" && c.method === "PUT")).toEqual([
      { method: "PUT", path: "/preferences", body: { ageWindow: { min: 31, max: 41 } } },
    ]);
  });

  it("offers a dance partner beside the other three intents, and saves it (#175)", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.profile = { displayName: "Onni", bio: null, bioPreset: null, fields: {}, prompts: [] };
    server.gender = "man";
    server.seeks = ["woman"];
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("What are you here for?")).toBeTruthy());
    expect(
      screen.getByText(
        "You're shown only to people who want the same thing. Open to either covers long-term and casual. You can change this later.",
      ),
    ).toBeTruthy();
    for (const name of [
      "Something long-term",
      "Something casual",
      "Open to either",
      "A dance partner",
    ]) {
      expect(screen.getByRole("button", { name, selected: false })).toBeTruthy();
    }
    checkA11y();
    await press(screen.getByRole("button", { name: "A dance partner" }));
    expect(screen.getByRole("button", { name: "A dance partner", selected: true })).toBeTruthy();
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What ages?")).toBeTruthy());
    expect(server.profile?.fields).toEqual({ intent: "dance_partner" });
  });

  it("asks the pond with one button per area, in the person's language, when there is more than one to choose from", async () => {
    const { server, calls } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.gender = "woman";
    server.seeks = ["man"];
    server.ageWindow = { min: 30, max: 40 };
    server.profile = {
      displayName: "Aino",
      bio: "x".repeat(50),
      bioPreset: null,
      fields: { intent: "casual" },
      prompts: [],
    };
    server.photos = 3;
    server.pond = null;
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Where do you live?")).toBeTruthy());
    // The seeded slugs read in the app's language, never the Finnish name the API sends (#174).
    await waitFor(() => expect(screen.getByRole("button", { name: "Capital Area" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Finland" })).toBeTruthy();
    expect(screen.queryByText("Suomi")).toBeNull();
    checkA11y();
    await press(screen.getByRole("button", { name: "Finland" }));
    expect(calls.some((c) => c.method === "PUT" && c.path === "/account/pond")).toBe(true);
    await waitFor(() => expect(screen.queryByText("Where do you live?")).toBeNull());
    expect(server.pond).toMatchObject({ slug: "suomi" });
  });

  it("offers the identity label after a non-binary gender only, and saves the one chosen", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Non-binary" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("A word for it, if you like")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "Genderfluid" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    expect(server.profile?.fields).toEqual({ identityLabel: "genderfluid" });
  });

  it("says from when a gender change is possible when one is refused for its cadence", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    server.genderFrom = "2026-11-08T10:00:00.000Z";
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Woman" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText(/You changed this recently/)).toBeTruthy());
    expect(screen.getByText("Next change possible: 8.11.2026.")).toBeTruthy();
  });

  it("skips the identity label on request and never offers it after another gender", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Non-binary" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("A word for it, if you like")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    expect(server.profile?.fields).toEqual({});
  });

  it("keeps the age window inside the bounds and the youngest at most the oldest", async () => {
    expect(defaultAgeWindow(36)).toEqual({ min: 31, max: 41 });
    expect(defaultAgeWindow(18)).toEqual({ min: 18, max: 23 });
    expect(defaultAgeWindow(99)).toEqual({ min: 94, max: 99 });
    const { server } = fakeApi({ age: 18 });
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.profile = {
      displayName: "Onni",
      bio: null,
      bioPreset: null,
      fields: { intent: "long_term" },
      prompts: [],
    };
    server.gender = "man";
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Anyone" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("What ages?")).toBeTruthy());
    const disabled = (name: string) =>
      screen.getByRole("button", { name }).props.accessibilityState?.disabled === true;
    expect(disabled("Youngest, one year younger")).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      await press(screen.getByRole("button", { name: "Oldest, one year younger" }));
    }
    expect(screen.getAllByText("18")).toHaveLength(2);
    expect(disabled("Oldest, one year younger")).toBe(true);
    expect(disabled("Youngest, one year older")).toBe(true);
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    expect(server.ageWindow).toEqual({ min: 18, max: 18 });
    expect(server.seeks).toEqual(["woman", "man", "non_binary"]);
  });

  it("asks only whom one seeks again after a withdrawal, and keeps the age window", async () => {
    // A withdrawal of the sensitive-answers consent removes whom one seeks (#204); the window
    // is no sensitive answer and stays, so the ages are not asked again (ADR-010 §13).
    const { server, calls } = fakeApi({ age: 43 });
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = {
      displayName: "Noa",
      bio: null,
      bioPreset: null,
      fields: { intent: "open_to_either" },
      prompts: [],
    };
    server.gender = "woman";
    server.ageWindow = { min: 35, max: 50 };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Anyone" }));
    await press(screen.getByLabelText("I consent to Kuutti storing whom I seek"));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Two photos of you")).toBeTruthy());
    expect(screen.queryByText("What ages?")).toBeNull();
    expect(server.seeks).toEqual(["woman", "man", "non_binary"]);
    expect(server.ageWindow).toEqual({ min: 35, max: 50 });
    expect(calls.filter((c) => c.path === "/preferences" && c.method === "PUT")).toEqual([
      { method: "PUT", path: "/preferences", body: { seeks: ["woman", "man", "non_binary"] } },
    ]);
  });

  it("The welcome step asks for the terms and the privacy summary when they are missing after the sign-in", async () => {
    // The answers before the bank did not become rows (lost with the process, or a failed post).
    const { server, calls } = fakeApi();
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
    expect(screen.getByText(/One round a day/)).toBeTruthy();
    expect(screen.getByText("Terms of use")).toBeTruthy();
    expect(screen.getByText("Privacy")).toBeTruthy();
    // English is a translation: the Finnish text is the binding one.
    expect(screen.getByText(/The Finnish text is the one that counts/)).toBeTruthy();
    // Each summary's version links to the full text on the website (#208).
    for (const version of new Set([TERMS, PRIVACY])) {
      expect(
        screen.getAllByRole("link", {
          name: `Read the full text on kuutti.app (version ${version})`,
        }),
      ).toHaveLength([TERMS, PRIVACY].filter((v) => v === version).length);
    }
    // A step outside the count: nothing personal is numbered before the name.
    expect(screen.queryByText(/^Step \d+ of \d+$/)).toBeNull();
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    checkA11y();
    await press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(server.consents.map((c) => [c.kind, c.version, c.locale])).toEqual([
      ["terms", TERMS, "en"],
      ["privacy", PRIVACY, "en"],
    ]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([
      "/consents",
      "/consents",
    ]);
    // This phone has them now: its next sign-in goes straight to the bank.
    expect(JSON.parse(String(store.get(AGREED)))).toEqual({
      terms: CONSENT_VERSIONS.terms,
      privacy: CONSENT_VERSIONS.privacy,
    });
  });

  it("gives the welcome step's consents in Finnish on a Finnish phone, with no line about a binding text", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    try {
      const { server } = fakeApi();
      await show(<OnboardingScreen />);
      await waitFor(() => expect(screen.getByText("Näin täällä toimitaan")).toBeTruthy());
      expect(screen.queryByText(/Suomenkielinen teksti on sitova/)).toBeNull();
      await press(screen.getByRole("button", { name: "Olen mukana ja hyväksyn molemmat" }));
      await flush();
      expect(server.consents.map((c) => [c.kind, c.locale])).toEqual([
        ["terms", "fi"],
        ["privacy", "fi"],
      ]);
      expect(store.has(AGREED)).toBe(true);
    } finally {
      (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
    }
  });

  it("stays at the welcome step, remembering nothing, when a consent there is refused", async () => {
    const { server } = fakeApi();
    const api = failingUntilOk("/consents");
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
    await press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    await flush();
    await waitFor(() =>
      expect(screen.getByText("Something did not load. Try again.")).toBeTruthy(),
    );
    expect(screen.getByText("How we do things here")).toBeTruthy();
    expect(server.consents).toEqual([]);
    expect(store.has(AGREED)).toBe(false);
    // Pressed again once the API takes it: both land, and only then is the phone remembered.
    api.ok();
    await press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(store.has(AGREED)).toBe(true);
  });

  it("asks for an app update instead of recording a consent for a wording it did not show", async () => {
    const { server, calls } = fakeApi({ version: "2026-11-final-1" });
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
    expect(screen.getByText(/Update the app to continue/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I'm in, and I accept both" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(server.consents).toEqual([]);
    expect(store.has(AGREED)).toBe(false);
  });

  /** Everything answered: nothing is missing, and research is no step of onboarding (#418). */
  function allAnswered(server: ReturnType<typeof fakeApi>["server"]) {
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.gender = "woman";
    server.seeks = ["man"];
    server.ageWindow = { min: 30, max: 40 };
    server.profile = {
      displayName: "Aino",
      bio: "x".repeat(50),
      bioPreset: null,
      fields: { intent: "casual" },
      prompts: [],
    };
    server.photos = 3;
  }

  /** The API answers one path with a refusal until `ok()` is called. */
  function failingUntilOk(path: string, status = 500, code = "internal_error") {
    const answers = globalThis.fetch;
    let failing = true;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (failing && new URL(request.url).pathname === path) {
        return json({ error: { code, message: "x", requestId: "r" } }, status);
      }
      return answers(input, init);
    }) as unknown as typeof fetch;
    return {
      ok: () => {
        failing = false;
      },
    };
  }

  it("leaves once whom one seeks is answered anew after a withdrawal, asking nothing else (#146)", async () => {
    // Onboarding walked once; then the sensitive-answers consent was withdrawn in
    // Settings, and whom one seeks with it. The withdrawn row stays (ADR-010 §4).
    const { server } = fakeApi();
    allAnswered(server);
    server.consents = server.consents.map((c) =>
      c.kind === "special_category" ? { ...c, withdrawnAt: "2026-10-01T10:00:00.000Z" } : c,
    );
    server.seeks = null;
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Men" }));
    await press(screen.getByLabelText("I consent to Kuutti storing whom I seek"));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    expect(server.seeks).toEqual(["man"]);
  });

  it("Onboarding leaves after the last profile step without asking about research", async () => {
    // A first walk with no research answer at all: the status says none was given.
    const { server, calls } = fakeApi();
    atWords(server);
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    expect(screen.getByText("Step 8 of 8")).toBeTruthy();
    await type(screen.getByLabelText("About you"), "x".repeat(50));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes, I take part" })).toBeNull();
    expect(screen.getByText("All set. Your place in line is on the home screen.")).toBeTruthy();
    // The words are the last thing saved; research is the screens before the bank's, and Settings'.
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual(["/profile"]);
    expect(server.consents.some((c) => c.kind === "research")).toBe(false);
  });

  it("is not held up by a research wording newer than the app's, since it asks none", async () => {
    const { server, calls } = fakeApi();
    allAnswered(server);
    const answers = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const response = await answers(input, init);
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/onboarding") return response;
      const body = await response.json();
      return json({ ...body, currentVersions: { ...body.currentVersions, research: "2027-01" } });
    }) as unknown as typeof fetch;
    await show(<OnboardingScreen />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText(/Update the app to continue/)).toBeNull();
    expect(screen.queryByText("Help us learn how matching works")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("says the status could not be read, and reads it again on request", async () => {
    fakeApi();
    const api = failingUntilOk("/onboarding");
    await show(<OnboardingScreen />);
    await waitFor(() =>
      expect(
        screen.getByText("Where you are in getting started could not be loaded."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Kuutti's server had a problem. Try again in a moment.")).toBeTruthy();
    api.ok();
    await press(screen.getByRole("button", { name: "Try again" }));
    await flush();
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
  });

  it("says the areas could not be read, and reads them again on request", async () => {
    const { server } = fakeApi();
    allAnswered(server);
    server.pond = null;
    const api = failingUntilOk("/ponds");
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Where do you live?")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText("Something did not load. Try again.")).toBeTruthy(),
    );
    api.ok();
    await press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Finland" })).toBeTruthy());
  });

  it("says a step did not go through when the API refuses it for another reason than its cadence", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    failingUntilOk("/account/gender");
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Woman" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() =>
      expect(screen.getByText("Something did not load. Try again.")).toBeTruthy(),
    );
    expect(screen.queryByText(/You changed this recently/)).toBeNull();
    expect(screen.getByText("How do you describe yourself?")).toBeTruthy();
  });

  it("takes back a label, and a gender sought, pressed a second time", async () => {
    const { server } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    await press(screen.getByRole("button", { name: "Non-binary" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("A word for it, if you like")).toBeTruthy());
    const continueDisabled = () =>
      screen.getByRole("button", { name: "Continue" }).props.accessibilityState?.disabled;
    await press(screen.getByRole("button", { name: "Genderfluid" }));
    expect(continueDisabled()).toBe(false);
    await press(screen.getByRole("button", { name: "Genderfluid" }));
    expect(continueDisabled()).toBe(true);
    await press(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    const women = () => screen.getByRole("button", { name: "Women" });
    await press(women());
    expect(women().props.accessibilityState?.selected).toBe(true);
    await press(women());
    expect(women().props.accessibilityState?.selected).toBe(false);
  });

  it("keeps no bio when the one typed is cleared again", async () => {
    const { server } = fakeApi();
    allAnswered(server);
    server.profile = {
      displayName: "Aino",
      bio: null,
      bioPreset: null,
      fields: { intent: "casual" },
      prompts: [],
    };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    await type(screen.getByLabelText("About you"), "Long walks.");
    await type(screen.getByLabelText("About you"), "");
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    expect(server.profile?.bio).toBeNull();
  });

  it("finishes the step for words of one's own with a ready line alone (#239)", async () => {
    const { server } = fakeApi();
    allAnswered(server);
    server.profile = {
      displayName: "Aino",
      bio: null,
      bioPreset: null,
      fields: { intent: "casual" },
      prompts: [],
    };
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    expect(screen.getByText(/characters, or pick a ready line\. Your card/)).toBeTruthy();
    checkA11y();
    await press(screen.getByRole("button", { name: "The photos say it. The rest over coffee." }));
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    expect(server.profile).toMatchObject({ bio: null, bioPreset: "photos_speak", prompts: [] });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("asks for an app update instead of recording the sensitive-answers consent for a newer wording", async () => {
    const { server, calls } = fakeApi();
    server.consents.push(consented("terms"), consented("privacy"));
    server.profile = { displayName: "Noa", bio: null, bioPreset: null, fields: {}, prompts: [] };
    server.gender = "woman";
    const answers = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const response = await answers(input, init);
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname !== "/onboarding") return response;
      const body = await response.json();
      return json({
        ...body,
        currentVersions: { ...body.currentVersions, special_category: "2027-01" },
      });
    }) as unknown as typeof fetch;
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    expect(screen.getByText(/Update the app to continue/)).toBeTruthy();
    expect(screen.queryByLabelText("I consent to Kuutti storing whom I seek")).toBeNull();
    await press(screen.getByRole("button", { name: "Women" }));
    expect(
      screen.getByRole("button", { name: "Continue" }).props.accessibilityState?.disabled,
    ).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
  /** Everything before the words (#146): the step for them is next. */
  function atWords(server: ReturnType<typeof fakeApi>["server"]) {
    server.consents.push(consented("terms"), consented("privacy"), consented("special_category"));
    server.profile = {
      displayName: "Onni",
      bio: null,
      bioPreset: null,
      fields: { intent: "long_term" },
      prompts: [],
    };
    server.gender = "man";
    server.seeks = ["woman"];
    server.ageWindow = { min: 30, max: 42 };
    server.photos = 3;
  }

  it("waits at the words for a bio that counts, and takes a ready line as one (#223)", async () => {
    const { server, calls } = fakeApi();
    atWords(server);
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    const saveDisabled = () =>
      screen.getByRole("button", { name: "Save and continue" }).props.accessibilityState?.disabled;
    expect(saveDisabled()).toBe(true);
    await type(screen.getByLabelText("About you"), "x".repeat(49));
    expect(saveDisabled()).toBe(true);
    await type(screen.getByLabelText("About you"), "x".repeat(50));
    expect(saveDisabled()).toBe(false);
    await type(screen.getByLabelText("About you"), "");
    expect(saveDisabled()).toBe(true);
    await press(
      screen.getByRole("button", {
        name: "I was too lazy to write anything here, so this placeholder says I am a nice fellow.",
      }),
    );
    expect(saveDisabled()).toBe(false);
    checkA11y();
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/profile")).toEqual([]);
  });

  it("says why a bio was refused, in the profile's words, and stays at the step (#223)", async () => {
    const { server } = fakeApi();
    atWords(server);
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    // Installed once the profile is read, so only the save meets it.
    failingUntilOk("/profile", 400, "text_contact_details");
    await type(screen.getByLabelText("About you"), `Call me on 040 123 4567 ${"x".repeat(40)}`);
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    await waitFor(() =>
      expect(
        screen.getByText(
          "Your text has an e-mail address, a link, a phone number or a social media handle. Those come after a match.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Something did not load. Try again.")).toBeNull();
    expect(screen.getByText("A few words")).toBeTruthy();
  });
});
