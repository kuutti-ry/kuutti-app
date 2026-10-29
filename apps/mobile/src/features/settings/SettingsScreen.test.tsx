import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { AccessibilityInfo, Platform } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { rememberOpenRow } from "./open-rows";
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
// Heard as expanded on Android and the web; on iOS, the tests' platform, the
// state is said in words after the value (#511).
const expanded = (name: string) =>
  /(^|, )open$/.test(row(name).props.accessibilityValue?.text ?? "");
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

const notifications = jest.requireMock("expo-notifications") as {
  getPermissionsAsync: jest.Mock;
};
/** This phone's answer to whether Kuutti may notify it, as iOS gives it. */
const phoneAnswer = (status: "granted" | "denied" | "undetermined") => ({
  status,
  granted: status === "granted",
  canAskAgain: status !== "denied",
  expires: "never",
  ios: { status: status === "granted" ? 2 : status === "denied" ? 1 : 0 },
});

beforeEach(async () => {
  // Every row closed, as at a cold start (#511).
  rememberOpenRow(null);
  notifications.getPermissionsAsync.mockResolvedValue(phoneAnswer("granted"));
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

  it("lists the sections for a signed-out device, logging out among them, with no accessibility problems", async () => {
    await renderWithTheme(<SettingsScreen />);
    const headings = ["Appearance and language", "About Kuutti", "Account"];
    for (const name of headings) expect(screen.getByRole("heading", { name })).toBeTruthy();
    // A section with no row for a device without a person is not drawn (#511).
    for (const name of ["Notifications and contacts", "Privacy and security", "Community"]) {
      expect(screen.queryByRole("heading", { name })).toBeNull();
    }
    // Logging out says there is no session; the rest of the account needs a person.
    expect(row("Logging out")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "A copy of your data" })).toBeNull();
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

  it("lists the six sections for a person in the order of #511, the account last", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByRole("button", { name: "Your account" })).toBeTruthy();
    const flat = JSON.stringify(screen.toJSON());
    const order = [
      "Appearance and language",
      "Language",
      "Theme",
      "Photo descriptions",
      "Decision buttons",
      "Notifications and contacts",
      "Notifications",
      "E-mail",
      "Ways to reach you",
      "Privacy and security",
      "Lock",
      "Research",
      "Sensitive answers",
      "A copy of your data",
      "Community",
      "Invitations",
      "Give feedback",
      "About Kuutti",
      "Version",
      "Terms of use",
      "Privacy",
      "Source code",
      "Licences",
      "Account",
      "Logging out",
      "Your account",
    ].map((label) => flat.indexOf(`"${label}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gives a row a second line only for its value, never to describe what its title names (#376)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    for (const name of [
      "Logging out",
      "Give feedback",
      "Your account",
      "Source code",
      "A copy of your data",
    ]) {
      expect([name, row(name).props.accessibilityHint]).toEqual([name, undefined]);
      // A row with no value is heard with its state alone.
      expect([name, row(name).props.accessibilityValue?.text]).toEqual([name, "closed"]);
    }
    // The rows with a value keep it under the title: the theme, the language, a version, the count.
    expect(row("Theme").props.accessibilityValue?.text).toBe("Same as the phone, closed");
    expect(row("Language").props.accessibilityValue?.text).toBe("Same as the phone, closed");
    // The lock's state is its value, heard once: not again as a hint.
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "Off, closed" });
    expect(row("Lock").props.accessibilityHint).toBeUndefined();
    expect(row("Terms of use").props.accessibilityHint).toMatch(/^Version /);
    expect(row("Licences").props.accessibilityHint).toMatch(/packages this build is made of$/);
  });

  it("says the defaults under the theme and the language rows", async () => {
    await renderWithTheme(<SettingsScreen />);
    // The theme and the language say it in the same words (#511).
    expect(screen.getAllByText("Same as the phone")).toHaveLength(2);
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
    // A row that opens a screen is heard with no state: neither open nor closed.
    expect(row("Licences").props.accessibilityValue?.text).toBeUndefined();
    await press(row("Licences"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/settings/licenses");
  });

  it("opens each setting in place under its row, one at a time, said as open, and closes it again (#511)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    // Each row, and something only its open panel shows.
    const panels: Array<[string, () => unknown]> = [
      ["Language", () => screen.queryByRole("radio", { name: "Svenska" })],
      ["Theme", () => screen.queryByRole("switch", { name: "High contrast" })],
      ["Photo descriptions", () => screen.queryByRole("switch", { name: "Show under photos" })],
      ["Decision buttons", () => screen.queryByRole("radio", { name: "Left hand" })],
      ["Notifications", () => screen.queryByText(/^What you choose here decides/)],
      ["E-mail", () => screen.queryByRole("button", { name: "Send a confirmation code" })],
      ["Ways to reach you", () => screen.queryByLabelText("Your Instagram username")],
      ["Lock", () => screen.queryByRole("button", { name: "Set a passcode" })],
      ["Research", () => screen.queryByRole("switch", { name: "Take part in research" })],
      [
        "Sensitive answers",
        () => screen.queryByRole("switch", { name: "Store my sensitive answers" }),
      ],
      ["A copy of your data", () => screen.queryByRole("button", { name: "Download my data" })],
      ["Invitations", () => screen.queryByRole("button", { name: "Make an invitation" })],
      ["Give feedback", () => screen.queryByRole("radio", { name: "A bug" })],
      ["Terms of use", () => screen.queryByText(/^DRAFT: Kuutti is a free dating service/)],
      ["Privacy", () => screen.queryByText(/^DRAFT: Kuutti stores your year and month/)],
      ["Source code", () => screen.queryByText("https://github.com/kuutti-ry/kuutti-app")],
      ["Logging out", () => screen.queryByRole("button", { name: "Log out everywhere" })],
      ["Your account", () => screen.queryByRole("button", { name: "Delete my account" })],
    ];
    let before: [string, () => unknown] | null = null;
    for (const [name, inside] of panels) {
      expect([name, expanded(name), inside()]).toEqual([name, false, null]);
      await press(row(name));
      expect([name, expanded(name)]).toEqual([name, true]);
      expect(await waitFor(inside)).toBeTruthy();
      // Opening it closed the one open before, whose panel is out of sight now.
      if (before)
        expect([before[0], expanded(before[0]), before[1]()]).toEqual([before[0], false, null]);
      before = [name, inside];
    }
    // Opening a row opens no screen.
    expect(router.push).not.toHaveBeenCalled();
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
    await press(row("Your account"));
    expect(expanded("Your account")).toBe(false);
    expect(screen.queryByRole("button", { name: "Delete my account" })).toBeNull();
  });

  it("keeps what was typed under a row that closed, for when it opens again (#511)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await press(row("Give feedback"));
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Your feedback"), "The round loads slowly.");
    });
    await press(row("Theme"));
    expect(screen.queryByLabelText("Your feedback")).toBeNull();
    await press(row("Give feedback"));
    expect(screen.getByLabelText("Your feedback").props.value).toBe("The round loads slowly.");
  });

  it("marks a row whose panel holds something not saved, and asks before the list is left (#511)", async () => {
    const navigation = (
      jest.requireMock("expo-router") as {
        __navigation: { emit: (name: string, event: unknown) => void; dispatch: jest.Mock };
      }
    ).__navigation;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    await press(row("Ways to reach you"));
    await act(async () => {
      fireEvent.changeText(await screen.findByLabelText("Your Telegram username"), "aino");
    });
    await act(async () => {
      fireEvent(screen.getByLabelText("Your Telegram username"), "blur");
    });
    await press(row("Theme"));
    // Closed, the row says it, marked, and what was typed waits under it.
    expect(row("Ways to reach you").props.accessibilityValue).toEqual({
      text: "Not saved, closed",
    });
    expect(
      within(row("Ways to reach you")).queryAllByTestId("row-alert", {
        includeHiddenElements: true,
      }),
    ).not.toHaveLength(0);
    // The arrow, the back key or a swipe: held, and asked.
    const event = { preventDefault: jest.fn(), data: { action: { type: "GO_BACK" } } };
    await act(async () => {
      navigation.emit("beforeRemove", event);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText("Leave without saving?")).toBeTruthy();
    // Keep editing goes back to where it was not saved.
    await press(screen.getByRole("button", { name: "Keep editing" }));
    expect(expanded("Ways to reach you")).toBe(true);
    expect(screen.getByLabelText("Your Telegram username").props.value).toBe("aino");
  });

  it("opens with the row left open while the app runs, and keeps nothing on the phone (#511)", async () => {
    const view = await renderWithTheme(<SettingsScreen />);
    await press(row("Language"));
    await view.unmount();
    await renderWithTheme(<SettingsScreen />);
    expect(expanded("Language")).toBe(true);
    expect([...store.keys()].filter((key) => key.includes("settingsOpen"))).toEqual([]);
    // A cold start forgets it.
    rememberOpenRow(null);
    await renderWithTheme(<SettingsScreen />);
    expect(expanded("Language")).toBe(false);
  });

  it("brings the screen reader to the row a link opened, once its panel is laid out", async () => {
    const focus = jest
      .spyOn(AccessibilityInfo, "sendAccessibilityEvent")
      .mockImplementation(() => undefined);
    const params = jest
      .spyOn(expoRouter, "useLocalSearchParams")
      .mockReturnValue({ open: "photoDescriptions" });
    try {
      await renderWithTheme(<SettingsScreen />);
      let panel = screen.getByRole("switch", { name: "Show under photos" }).parent;
      while (panel && panel.props.onLayout === undefined) panel = panel.parent;
      await act(async () => {
        fireEvent(panel as never, "layout", {
          nativeEvent: { layout: { x: 0, y: 0, width: 1, height: 1 } },
        });
      });
      expect(focus).toHaveBeenCalledWith(expect.anything(), "focus");
      // A row the person opens takes no focus away from them.
      focus.mockClear();
      await press(row("Theme"));
      let other = screen.getByRole("switch", { name: "High contrast" }).parent;
      while (other && other.props.onLayout === undefined) other = other.parent;
      await act(async () => {
        fireEvent(other as never, "layout", {
          nativeEvent: { layout: { x: 0, y: 0, width: 1, height: 1 } },
        });
      });
      expect(focus).not.toHaveBeenCalled();
    } finally {
      params.mockRestore();
      focus.mockRestore();
    }
  });

  it("opens the row a link names, in place of the one left open", async () => {
    rememberOpenRow("theme");
    const params = jest
      .spyOn(expoRouter, "useLocalSearchParams")
      .mockReturnValue({ open: "photoDescriptions" });
    try {
      await renderWithTheme(<SettingsScreen />);
      expect(expanded("Photo descriptions")).toBe(true);
      expect(expanded("Theme")).toBe(false);
    } finally {
      params.mockRestore();
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
    expect(row("Research").props.accessibilityValue).toEqual({ text: "On, closed" });
    expect(row("Research").props.accessibilityHint).toBeUndefined();
    expect(row("Sensitive answers").props.accessibilityValue).toEqual({
      text: "Update the app to change it, closed",
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
    await waitFor(() =>
      expect(row("Research").props.accessibilityValue).toEqual({ text: "Off, open" }),
    );
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
        text: "aino@example.fi, not confirmed yet, closed",
      }),
    );
    expect(row("Ways to reach you").props.accessibilityValue).toEqual({
      text: "None kept, closed",
    });
    expect(row("Notifications").props.accessibilityValue).toEqual({ text: "All on, closed" });
    expect(row("Invitations").props.accessibilityValue).toEqual({
      text: "One waiting to be used, closed",
    });
    // The value is the second line, heard once: not again as a hint.
    const lines: Array<[string, string]> = [
      ["E-mail", "aino@example.fi, not confirmed yet"],
      ["Ways to reach you", "None kept"],
      ["Notifications", "All on"],
      ["Invitations", "One waiting to be used"],
    ];
    for (const [name, line] of lines) {
      expect([name, row(name).props.accessibilityHint]).toEqual([name, undefined]);
      expect(within(row(name)).getByText(line)).toBeTruthy();
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
      expect(row("Notifications").props.accessibilityValue).toEqual({ text: "3 on, 1 off, open" }),
    );
    await press(row("Ways to reach you"));
    await act(async () => {
      fireEvent.changeText(await screen.findByLabelText("Your Instagram username"), "aino.reads");
    });
    // Leaving the field keeps it (#511).
    await act(async () => {
      fireEvent(screen.getByLabelText("Your Instagram username"), "blur");
    });
    await waitFor(() =>
      expect(row("Ways to reach you").props.accessibilityValue).toEqual({
        text: "Instagram, open",
      }),
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
      expect([name, row(name).props.accessibilityValue?.text]).toEqual([name, "closed"]);
    }
  });

  it.each([
    ["denied", "Not allowed on this phone, closed", true],
    ["undetermined", "Not asked on this phone yet, closed", false],
  ] as const)(
    "says on the notifications row when this phone is %s (#511, #102), marked only when nothing gets through",
    async (answer, value, marked) => {
      notifications.getPermissionsAsync.mockResolvedValue(phoneAnswer(answer));
      await saveSession(tokens);
      await renderWithTheme(<SettingsScreen />);
      await screen.findByRole("button", { name: "Your account" });
      await waitFor(() =>
        expect(row("Notifications").props.accessibilityValue).toEqual({ text: value }),
      );
      // The mark is decoration beside the words: drawn only for a phone that refuses.
      expect(
        within(row("Notifications")).queryAllByTestId("row-alert", { includeHiddenElements: true })
          .length > 0,
      ).toBe(marked);
    },
  );

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
    expect(row("Research").props.accessibilityValue).toEqual({ text: "Off, closed" });
    expect(row("Sensitive answers").props.accessibilityValue).toEqual({ text: "Off, closed" });
  });

  it("says no state on a consent row while the consents could not be read; its screen says why", async () => {
    globalThis.fetch = jest.fn(async () =>
      json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500),
    ) as unknown as typeof fetch;
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Research").props.accessibilityValue?.text).toBe("closed");
    expect(row("Sensitive answers").props.accessibilityValue?.text).toBe("closed");
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
    expect(row("Theme").props.accessibilityValue?.text).toBe("Same as the phone, closed");
    expect(row("Language").props.accessibilityValue?.text).toBe("Same as the phone, closed");
  });

  it("says whether the photo descriptions are shown under the photos as the row's value (#296)", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Photo descriptions").props.accessibilityValue).toEqual({
      text: "Not shown under the photos, closed",
    });
    expect(screen.getByText("Not shown under the photos")).toBeTruthy();
    store.set("kuutti.preference.photoDescriptions", JSON.stringify({ shown: true }));
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByText("Shown under the photos")).toBeTruthy();
  });

  it("says the hand the decision buttons are placed for, and one-handed, as the row's value (#82)", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(row("Decision buttons").props.accessibilityValue).toEqual({
      text: "Right hand, closed",
    });
    store.set(
      "kuutti.preference.decisionButtons",
      JSON.stringify({ hand: "left", oneHanded: true }),
    );
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByText("Left hand, one-handed")).toBeTruthy();
    expect(row("Decision buttons").props.accessibilityValue).toEqual({
      text: "Left hand, one-handed, closed",
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
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "Off, closed" });
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
    expect(row("Lock").props.accessibilityValue).toEqual({ text: "On, closed" });
    expect(within(row("Lock")).getByText("On")).toBeTruthy();
  });

  it("is not there on the web preview, which has no lock", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await screen.findByRole("button", { name: "Your account" });
    expect(row("Logging out")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
  });
});
