import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { SettingsScreen } from "./SettingsScreen";

// The settings as one list of sections (#287, #511): each row names a
// setting and says what is chosen in it; a setting chosen in place opens
// under its row and closes again, the rest open their screens; the account's
// rows need a person.

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
const auth = jest.requireMock("expo-local-authentication") as Record<
  | "hasHardwareAsync"
  | "isEnrolledAsync"
  | "supportedAuthenticationTypesAsync"
  | "authenticateAsync",
  jest.Mock
>;
const expoRouter = jest.requireMock("expo-router") as {
  __router: { back: jest.Mock; push: jest.Mock };
  useLocalSearchParams: () => Record<string, string>;
};
const { __router: router } = expoRouter;

function deviceLanguage(...tags: string[]) {
  (useLocales as jest.Mock).mockReturnValue(tags.map((languageTag) => ({ languageTag })));
}
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const row = (name: string) => screen.getByRole("button", { name });
const expanded = (name: string) => row(name).props.accessibilityState?.expanded as boolean;
const openStored = () => JSON.parse(store.get("kuutti.preference.settingsOpen") ?? "null");
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

const CHOICES = [
  { kind: "round", enabled: true },
  { kind: "message", enabled: true },
  { kind: "match", enabled: true },
  { kind: "moderation", enabled: true },
];
const INVITATIONS = {
  canInvite: true,
  redeemable: false,
  reward: { fish: 1, likes: 0 },
  open: [{ id: "8c1e6d2a-6a43-4c55-9d0b-3f1a2b3c4d5e", createdAt: "2026-10-28T10:00:00.000Z" }],
  counted: 0,
  earned: { fish: 0, likes: 0 },
};
const HEALTH = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://github.com/kuutti-ry/kuutti-app",
  db: "ok",
  migrations: "current",
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
    if (url.pathname === "/contacts") return json({ contacts: [] });
    if (url.pathname === "/account/email") {
      return json({ email: "aino@example.fi", confirmed: false, codeExpiresAt: null });
    }
    if (url.pathname === "/account/notifications") return json({ choices: CHOICES });
    if (url.pathname === "/invitations") return json(INVITATIONS);
    if (url.pathname === "/health") return json(HEALTH);
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
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Research" })).toBeNull();
    expect(screen.queryByRole("button", { name: "E-mail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ways to reach you" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invitations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Your account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give feedback" })).toBeNull();
    for (const name of [
      "Theme",
      "Language",
      "Photo descriptions",
      "Decision buttons",
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

  it("lists the sections for a person in the order of #376: appearance, account, legal, about", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByRole("button", { name: "Your account" })).toBeTruthy();
    const flat = JSON.stringify(screen.toJSON());
    const order = [
      "Appearance and language",
      "Theme",
      "Language",
      "Photo descriptions",
      "Decision buttons",
      "Account",
      "This device",
      "Lock",
      "E-mail",
      "Ways to reach you",
      "Notifications",
      "Invitations",
      "Give feedback",
      "Your account",
      "Legal",
      "Research",
      "Sensitive answers",
      "Terms of use",
      "Privacy",
      "About Kuutti",
      "Version",
      "Source code",
      "Licences",
    ].map((label) => flat.indexOf(`"${label}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gives a row a second line only for its value, never to describe what its title names (#376)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    for (const name of ["This device", "Give feedback", "Your account", "Source code"]) {
      expect([name, row(name).props.accessibilityHint]).toEqual([name, undefined]);
      expect([name, row(name).props.accessibilityValue?.text]).toEqual([name, undefined]);
    }
    // The rows with a value keep it under the title: the theme, the language, a version, the count.
    expect(row("Theme").props.accessibilityValue?.text).toBe("System");
    expect(row("Language").props.accessibilityValue?.text).toBe("Phone's language");
    // The lock's state is its value, heard once: not again as a hint.
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "Off" });
    expect(row("Lock").props.accessibilityHint).toBeUndefined();
    expect(row("Terms of use").props.accessibilityHint).toMatch(/^Version /);
    expect(row("Licences").props.accessibilityHint).toMatch(/packages this build is made of$/);
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

  it("opens a screen for the licences alone, a list of every package rather than a setting", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Licences").props.accessibilityState?.expanded).toBeUndefined();
    await press(row("Licences"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/settings/licenses");
  });

  it("opens each setting in place under its row, said as expanded, and closes it again (#511)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    // Each row, and something only its open panel shows.
    const panels: Array<[string, () => unknown]> = [
      ["Theme", () => screen.queryByRole("switch", { name: "High contrast" })],
      ["Language", () => screen.queryByRole("radio", { name: "Svenska" })],
      ["Photo descriptions", () => screen.queryByRole("switch", { name: "Show under photos" })],
      ["Decision buttons", () => screen.queryByRole("radio", { name: "Left hand" })],
      ["Lock", () => screen.queryByRole("button", { name: "Set a passcode" })],
      ["Ways to reach you", () => screen.queryByLabelText("Your Instagram username")],
      ["Notifications", () => screen.queryByText(/^What you choose here decides/)],
      ["Research", () => screen.queryByRole("switch", { name: "Take part in research" })],
      [
        "Sensitive answers",
        () => screen.queryByRole("switch", { name: "Store my sensitive answers" }),
      ],
      ["This device", () => screen.queryByRole("button", { name: "Log out everywhere" })],
      ["E-mail", () => screen.queryByRole("button", { name: "Send a confirmation code" })],
      ["Invitations", () => screen.queryByRole("button", { name: "Make an invitation" })],
      ["Give feedback", () => screen.queryByRole("radio", { name: "A bug" })],
      ["Your account", () => screen.queryByRole("button", { name: "Download my data" })],
      ["Terms of use", () => screen.queryByText(/^DRAFT: Kuutti is a free dating service/)],
      ["Privacy", () => screen.queryByText(/^DRAFT: Kuutti stores your year and month/)],
      ["Source code", () => screen.queryByText("https://github.com/kuutti-ry/kuutti-app")],
    ];
    for (const [name, inside] of panels) {
      expect([name, expanded(name), inside()]).toEqual([name, false, null]);
      await press(row(name));
      expect([name, expanded(name)]).toEqual([name, true]);
      expect(await waitFor(inside)).toBeTruthy();
    }
    // Opening a row opens no screen.
    expect(router.push).not.toHaveBeenCalled();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    for (const [name, inside] of panels) {
      await press(row(name));
      expect([name, expanded(name), inside()]).toEqual([name, false, null]);
    }
  });

  it("keeps on the phone which rows are open, and opens them so the next time (#511)", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(openStored()).toBeNull();
    await press(row("Language"));
    await press(row("Theme"));
    expect(openStored()).toEqual(["language", "theme"]);
    await press(row("Language"));
    expect(openStored()).toEqual(["theme"]);
    await renderWithTheme(<SettingsScreen />);
    await waitFor(() => expect(expanded("Theme")).toBe(true));
    expect(expanded("Language")).toBe(false);
    expect(screen.getByRole("switch", { name: "High contrast" })).toBeTruthy();
  });

  it("opens the row a link names, beside those kept open, and keeps it once a row is pressed", async () => {
    store.set("kuutti.preference.settingsOpen", JSON.stringify(["theme"]));
    const params = jest
      .spyOn(expoRouter, "useLocalSearchParams")
      .mockReturnValue({ open: "photoDescriptions" });
    try {
      await renderWithTheme(<SettingsScreen />);
      expect(expanded("Photo descriptions")).toBe(true);
      await waitFor(() => expect(expanded("Theme")).toBe(true));
      expect(openStored()).toEqual(["theme"]);
      await press(row("Language"));
      expect(openStored()).toEqual(["theme", "photoDescriptions", "language"]);
    } finally {
      params.mockRestore();
    }
  });

  it("opens none when what the phone kept is not a list of rows", async () => {
    for (const kept of ["{", JSON.stringify({ theme: true }), JSON.stringify([1, "theme"])]) {
      store.set("kuutti.preference.settingsOpen", kept);
      await renderWithTheme(<SettingsScreen />);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      // A list's names count, whatever else it holds.
      expect([kept, expanded("Theme")]).toEqual([kept, kept.startsWith("[")]);
      expect(expanded("Language")).toBe(false);
    }
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

  it("says a consent's new state on its row as soon as the switch under it stores it (#511)", async () => {
    let research: unknown[] = consentsAnswer.consents;
    globalThis.fetch = jest.fn(async (input: Request | string) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (request.method === "DELETE" && url.pathname === "/consents/research") {
        research = [{ ...consentsAnswer.consents[0], withdrawnAt: "2026-10-29T10:00:00.000Z" }];
      }
      if (url.pathname.startsWith("/consents"))
        return json({ ...consentsAnswer, consents: research });
      return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await press(row("Research"));
    await press(await screen.findByRole("switch", { name: "Take part in research" }));
    await waitFor(() => expect(row("Research").props.accessibilityValue).toEqual({ text: "Off" }));
    expect(
      screen.getByRole("switch", { name: "Take part in research" }).props.accessibilityState,
    ).toMatchObject({ checked: false });
  });

  it("says what the e-mail, the contacts, the notifications and the invitations hold, as their rows' values (#511)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await waitFor(() =>
      expect(row("E-mail").props.accessibilityValue).toEqual({
        text: "aino@example.fi, not confirmed yet",
      }),
    );
    expect(row("Ways to reach you").props.accessibilityValue).toEqual({ text: "None kept" });
    expect(row("Notifications").props.accessibilityValue).toEqual({ text: "All on" });
    expect(row("Invitations").props.accessibilityValue).toEqual({
      text: "One waiting to be used",
    });
    // The value is the second line, heard once: not again as a hint.
    for (const name of ["E-mail", "Ways to reach you", "Notifications", "Invitations"]) {
      expect([name, row(name).props.accessibilityHint]).toEqual([name, undefined]);
      expect(within(row(name)).getByText(row(name).props.accessibilityValue.text)).toBeTruthy();
    }
  });

  it("follows what a panel stores in its row's value at once (#511)", async () => {
    const answers = globalThis.fetch;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "PUT" && url.pathname === "/account/notifications/message") {
        return json({
          choices: CHOICES.map((c) => (c.kind === "message" ? { ...c, enabled: false } : c)),
        });
      }
      if (request.method === "PUT" && url.pathname === "/contacts/instagram") {
        return json({
          kind: "instagram",
          value: "aino.reads",
          updatedAt: "2026-10-29T10:00:00.000Z",
        });
      }
      return answers(input, init);
    }) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await press(row("Notifications"));
    await press(await screen.findByRole("switch", { name: "Messages" }));
    await waitFor(() =>
      expect(row("Notifications").props.accessibilityValue).toEqual({ text: "3 on, 1 off" }),
    );
    await press(row("Ways to reach you"));
    await act(async () => {
      fireEvent.changeText(await screen.findByLabelText("Your Instagram username"), "aino.reads");
    });
    await press(screen.getByRole("button", { name: "Save your Instagram username" }));
    await waitFor(() =>
      expect(row("Ways to reach you").props.accessibilityValue).toEqual({ text: "One kept" }),
    );
  });

  it("says no value on those rows while what they hold could not be read; their panels say why", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    ) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    for (const name of ["E-mail", "Ways to reach you", "Notifications", "Invitations"]) {
      expect([name, row(name).props.accessibilityValue?.text]).toEqual([name, undefined]);
    }
  });

  it("says Off for a consent not given (#287)", async () => {
    globalThis.fetch = jest.fn(async (input: Request | string) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/consents") {
        return json({
          consents: [],
          currentVersions: {
            ...consentsAnswer.currentVersions,
            special_category: CONSENT_VERSIONS.special_category,
          },
        });
      }
      return json({ error: { code: "not_found", message: "no", requestId: "r" } }, 404);
    }) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Research").props.accessibilityValue).toEqual({ text: "Off" });
    expect(row("Sensitive answers").props.accessibilityValue).toEqual({ text: "Off" });
  });

  it("says no state on a consent row while the consents could not be read; its screen says why", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    ) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Research").props.accessibilityValue?.text).toBeUndefined();
    expect(row("Sensitive answers").props.accessibilityValue?.text).toBeUndefined();
    // Scoped to the consents' rows: the lock's row says its own state beside them.
    for (const name of ["Research", "Sensitive answers"]) {
      expect(within(row(name)).queryByText("On")).toBeNull();
      expect(within(row(name)).queryByText("Off")).toBeNull();
    }
  });

  it("names the version without a build, and a question mark when the build names none", async () => {
    mockBuild.mockReturnValue({ version: null, commit: null });
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByLabelText("Version").props.accessibilityValue).toEqual({ text: "?" });
    expect(screen.queryByText(/^Build /)).toBeNull();
  });

  it("says the chosen theme and language as the rows' values", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Theme").props.accessibilityValue?.text).toBe("System");
    expect(row("Language").props.accessibilityValue?.text).toBe("Phone's language");
  });

  it("says whether the photo descriptions are shown under the photos as the row's value (#296)", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Photo descriptions").props.accessibilityValue).toEqual({
      text: "Not shown under the photos",
    });
    expect(screen.getByText("Not shown under the photos")).toBeTruthy();
    store.set("kuutti.preference.photoDescriptions", JSON.stringify({ shown: true }));
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByText("Shown under the photos")).toBeTruthy();
  });

  it("says the hand the decision buttons are placed for, and one-handed, as the row's value (#82)", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Decision buttons").props.accessibilityValue).toEqual({ text: "Right hand" });
    store.set(
      "kuutti.preference.decisionButtons",
      JSON.stringify({ hand: "left", oneHanded: true }),
    );
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByText("Left hand, one-handed")).toBeTruthy();
    expect(row("Decision buttons").props.accessibilityValue).toEqual({
      text: "Left hand, one-handed",
    });
  });
});

describe("the lock's row (#418)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // Back to the phone of jest.setup.js: neither face nor fingerprint.
    auth.hasHardwareAsync.mockResolvedValue(false);
    auth.isEnrolledAsync.mockResolvedValue(false);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([]);
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
  });

  it("stands after This device for a person on the phone, says Off until the lock is on, and opens in place", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "Off" });
    expect(within(row("Lock")).getByText("Off")).toBeTruthy();
    await press(row("Lock"));
    expect(screen.getByText(/^Lock Kuutti on this phone, so that somebody else/)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says On while the lock is on, read once the face has opened it", async () => {
    auth.authenticateAsync.mockClear();
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(true);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
    auth.authenticateAsync.mockResolvedValue({ success: true });
    store.set("kuutti.lock", JSON.stringify({ biometrics: true, passcode: null, graceMinutes: 1 }));
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Kuutti is locked")).toBeNull();
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "On" });
    expect(within(row("Lock")).getByText("On")).toBeTruthy();
  });

  it("is not there on the web preview, which has no lock", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("This device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });
});
