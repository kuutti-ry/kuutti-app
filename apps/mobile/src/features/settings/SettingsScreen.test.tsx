import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SettingsScreen } from "./SettingsScreen";

// The settings as a list of sections (#287): each row names a screen, says
// what is chosen in it, and opens it; the account's rows need a person.

// NativeWind's colour-scheme setter needs its compiled stylesheet, which the
// test runner has none of: the provider's call is seen, not applied.
jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: jest.fn() }),
}));

// The build's version and commit, the test's to choose (lib/build.ts has its own tests).
const mockBuild = jest.fn((): { version: string | null; commit: string | null } => ({
  version: "0.19.0",
  commit: "abc1234def5678",
}));
jest.mock("@/lib/build", () => ({ buildInfo: () => mockBuild() }));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const { __router: router } = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock; push: jest.Mock };
};

function deviceLanguage(...tags: string[]) {
  (useLocales as jest.Mock).mockReturnValue(tags.map((languageTag) => ({ languageTag })));
}
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const row = (name: string) => screen.getByRole("button", { name });
/** A press, and the screen settled after it, as the other screens' tests press. */
const press = (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Research given for the app's wording; the sensitive answers' wording newer than the app's. */
const consentsAnswer = {
  consents: [
    {
      kind: "research",
      version: CONSENT_VERSIONS.research,
      locale: "en",
      givenAt: "2026-09-26T10:00:00.000Z",
      withdrawnAt: null,
    },
  ],
  currentVersions: {
    terms: CONSENT_VERSIONS.terms,
    privacy: CONSENT_VERSIONS.privacy,
    research: CONSENT_VERSIONS.research,
    special_category: "2099-01-newer-than-this-app",
  },
};

beforeEach(async () => {
  mockBuild.mockReturnValue({ version: "0.19.0", commit: "abc1234def5678" });
  store.clear();
  deviceLanguage("en-US");
  router.back.mockReset();
  router.push.mockReset();
  // The list reads the consents for their rows; the session behind it may read more, and gets a 404.
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/consents") return json(consentsAnswer);
    return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
  }) as unknown as typeof fetch;
  await clearSession();
});

describe("the settings screen", () => {
  it("keeps the title and the way back pinned above the list", async () => {
    await renderWithTheme(<SettingsScreen />);
    expectPinnedHeader("Settings", "Back");
    await press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("lists the sections for a signed-out device, this device's row among them, with no accessibility problems", async () => {
    await renderWithTheme(<SettingsScreen />);
    const headings = ["Appearance and language", "Legal", "About Kuutti", "Account"];
    for (const name of headings) expect(screen.getByRole("heading", { name })).toBeTruthy();
    // This device's screen says there is no session; the rest of the account needs a person.
    expect(row("This device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Research" })).toBeNull();
    expect(screen.queryByRole("button", { name: "E-mail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Your account" })).toBeNull();
    for (const name of [
      "Theme",
      "Language",
      "Terms of use",
      "Privacy",
      "Source code",
      "Licences",
    ]) {
      expect(row(name)).toBeTruthy();
    }
    // The version opens nothing: a fact, read with its number and its build.
    expect(screen.getByLabelText("Version").props.accessibilityValue).toEqual({
      text: "0.19.0, Build abc1234",
    });
    expect(screen.queryByRole("button", { name: "Version" })).toBeNull();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("lists the account's rows for a person, in order after the rest", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByRole("button", { name: "Your account" })).toBeTruthy();
    const flat = JSON.stringify(screen.toJSON());
    const order = [
      "Appearance and language",
      "Theme",
      "Language",
      "Legal",
      "Research",
      "Sensitive answers",
      "Terms of use",
      "Privacy",
      "About Kuutti",
      "Version",
      "Source code",
      "Licences",
      "Account",
      "This device",
      "E-mail",
      "Your account",
    ].map((label) => flat.indexOf(`"${label}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says the defaults under the theme and the language rows", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText("Phone's language")).toBeTruthy();
  });

  it("says what is chosen under the theme and the language rows", async () => {
    store.set("kuutti.preference.scheme", "light");
    store.set("kuutti.preference.highContrast", "true");
    store.set("kuutti.preference.locale", "sv");
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByText("Ljust, hög kontrast")).toBeTruthy();
    expect(screen.getByText("Svenska")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inställningar" })).toBeTruthy();
  });

  it("opens each row's screen", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    const expected: Array<[string, string]> = [
      ["Theme", "/settings/theme"],
      ["Language", "/settings/language"],
      ["Research", "/settings/consent/research"],
      ["Sensitive answers", "/settings/consent/special_category"],
      ["Terms of use", "/settings/legal/terms"],
      ["Privacy", "/settings/legal/privacy"],
      ["Source code", "/settings/source"],
      ["Licences", "/settings/licenses"],
      ["This device", "/settings/device"],
      ["E-mail", "/settings/email"],
      ["Your account", "/settings/account"],
    ];
    for (const [name, path] of expected) {
      await press(row(name));
      expect(router.push).toHaveBeenLastCalledWith(path);
    }
    expect(router.push).toHaveBeenCalledTimes(expected.length);
  });

  it("follows the phone's language", async () => {
    deviceLanguage("fi-FI", "en-US");
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByRole("heading", { name: "Asetukset" })).toBeTruthy();
    expect(row("Kieli")).toBeTruthy();
  });

  it("says whether each consent is on, or that the app needs an update to change it", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Research").props.accessibilityValue).toEqual({ text: "On" });
    expect(row("Research").props.accessibilityHint).toBeUndefined();
    expect(row("Sensitive answers").props.accessibilityValue).toEqual({
      text: "Update the app to change it",
    });
  });

  it("names the version without a build, and a question mark when the build names none", async () => {
    mockBuild.mockReturnValue({ version: null, commit: null });
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByLabelText("Version").props.accessibilityValue).toEqual({ text: "?" });
    expect(screen.queryByText(/^Build /)).toBeNull();
  });

  it("says the chosen theme and language as the rows' values", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Theme").props.accessibilityValue).toEqual({ text: "System" });
    expect(row("Language").props.accessibilityValue).toEqual({ text: "Phone's language" });
  });
});
