import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
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
const VERSION = "2026-09-draft-1";
const SPECIAL = "2026-10-draft-2";
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

/** A tiny server: the status is computed from what the steps wrote, as the API does (#146). */
function fakeApi(options: { version?: string; age?: number } = {}) {
  const current = options.version ?? VERSION;
  const server: {
    gender: string | null;
    seeks: string[] | null;
    ageWindow: { min: number; max: number } | null;
    consents: { kind: string; version: string; locale: string }[];
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
    server.consents.some((c) => c.kind === kind && c.version === version);
  const status = () => {
    const bio = server.profile?.bio ?? "";
    const prompts = server.profile?.prompts.filter((p) => p.answer.length > 0).length ?? 0;
    const missing = [
      ...(has("terms", VERSION) ? [] : ["terms"]),
      ...(has("privacy", VERSION) ? [] : ["privacy"]),
      ...(server.profile?.displayName ? [] : ["name"]),
      ...(server.gender ? [] : ["gender"]),
      ...(server.seeks && has("special_category", SPECIAL) ? [] : ["seeks"]),
      ...(server.profile?.fields.intent ? [] : ["intent"]),
      ...(server.ageWindow ? [] : ["age_window"]),
      ...(server.pond ? [] : ["pond"]),
      ...(server.photos >= 3 ? [] : ["photos"]),
      ...(bio.length >= 50 || prompts >= 2 ? [] : ["prompts_or_bio"]),
    ];
    const research = server.consents.find((c) => c.kind === "research");
    return {
      state: missing.some((step) => ACTIVATION.includes(step)) ? "registered" : "active",
      age: options.age ?? 36,
      gender: server.gender,
      pond: server.pond,
      preferences: { seeks: server.seeks, ageWindow: server.ageWindow },
      consents: {
        terms: has("terms", VERSION) ? VERSION : null,
        privacy: has("privacy", VERSION) ? VERSION : null,
        specialCategory: has("special_category", SPECIAL) ? SPECIAL : null,
        research: research ? { version: VERSION, givenAt: "2026-09-26T10:00:00.000Z" } : null,
      },
      currentVersions: {
        terms: current,
        privacy: current,
        research: current,
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
      const b = body as { seeks: string[]; ageWindow: { min: number; max: number } };
      server.seeks = b.seeks;
      server.ageWindow = b.ageWindow;
      return json({ seeks: b.seeks, ageWindow: b.ageWindow });
    }
    if (path === "/consents") {
      server.consents.push(body as { kind: string; version: string; locale: string });
      return json({
        consents: server.consents.map((c) => ({
          ...c,
          givenAt: "2026-09-26T10:00:00.000Z",
          withdrawnAt: null,
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
  version: kind === "special_category" ? SPECIAL : VERSION,
  locale: "en",
});

beforeEach(async () => {
  router.replace.mockReset();
  router.push.mockReset();
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
    const { server, calls } = fakeApi();
    await show(<OnboardingScreen />);
    // The welcome screen first: the norms and both consents, before anything personal is asked.
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
    expect(screen.getByText(/One round a day/)).toBeTruthy();
    expect(screen.getByText("Terms of use")).toBeTruthy();
    expect(screen.getAllByText(`Version ${VERSION}`)).toHaveLength(2);
    checkA11y();
    await press(screen.getByRole("button", { name: "I'm in, and I accept both" }));
    await flush();
    await waitFor(() => expect(screen.getByText("What should we call you?")).toBeTruthy());
    expect(server.consents.map((c) => [c.kind, c.version, c.locale])).toEqual([
      ["terms", VERSION, "en"],
      ["privacy", VERSION, "en"],
    ]);
    checkA11y();
    await type(screen.getByLabelText("Name on your card"), "Aino");
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("How do you describe yourself?")).toBeTruthy());
    expect(server.profile?.displayName).toBe("Aino");
    checkA11y();
    await press(screen.getByRole("button", { name: "Woman" }));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Whom are you looking for?")).toBeTruthy());
    expect(server.gender).toBe("woman");
    checkA11y();
    await press(screen.getByRole("button", { name: "Men" }));
    await press(screen.getByRole("button", { name: "Non-binary people" }));
    // Nothing moves on without the article 9 consent, given on this screen.
    expect(
      screen.getByRole("button", { name: "Continue" }).props.accessibilityState?.disabled,
    ).toBe(true);
    expect(screen.getByText(/special categories of personal data/)).toBeTruthy();
    await press(screen.getByLabelText("I consent to Kuutti storing whom I seek"));
    await flush();
    expect(server.consents.at(-1)).toEqual(consented("special_category"));
    await press(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("What are you here for?")).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText("Three photos of you")).toBeTruthy());
    expect(server.seeks).toEqual(["man", "non_binary"]);
    expect(server.ageWindow).toEqual({ min: 30, max: 42 });
    checkA11y();
    await press(screen.getByRole("button", { name: "Add photos" }));
    expect(router.push).toHaveBeenCalledWith("/photos");
    // Back from the photos screen with three photos: the focus reads the status again.
    server.photos = 3;
    await act(async () => {
      focus();
      await settle(120);
    });
    await waitFor(() => expect(screen.getByText("A few words")).toBeTruthy());
    checkA11y();
    await type(
      screen.getByLabelText("About you"),
      "A bio long enough to count for completeness, which is fifty characters.",
    );
    await press(screen.getByRole("button", { name: "Save and continue" }));
    await flush();
    await waitFor(() => expect(screen.getByText("Help us learn how matching works")).toBeTruthy());
    checkA11y();
    await press(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(server.consents.map((c) => c.kind)).toEqual(["terms", "privacy", "special_category"]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([
      "/consents",
      "/consents",
      "/profile",
      "/account/gender",
      "/consents",
      "/profile",
      "/preferences",
      "/profile",
    ]);
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

  it("shows the stored age window again when whom one seeks is asked anew", async () => {
    // A withdrawal of the sensitive-answers consent asks whom one seeks again, and the ages
    // with it (#204): the window the person had, not the default around their age.
    const { server } = fakeApi({ age: 43 });
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
    await waitFor(() => expect(screen.getByText("What ages?")).toBeTruthy());
    expect(screen.getByText("35")).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Continue" }));
    await flush();
    expect(server.ageWindow).toEqual({ min: 35, max: 50 });
  });

  it("asks for an app update instead of recording a consent for a wording it did not show", async () => {
    const { server, calls } = fakeApi({ version: "2026-11-final-1" });
    await show(<OnboardingScreen />);
    await waitFor(() => expect(screen.getByText("How we do things here")).toBeTruthy());
    expect(screen.getByText(/Update the app to continue/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I'm in, and I accept both" })).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(server.consents).toEqual([]);
  });
});
