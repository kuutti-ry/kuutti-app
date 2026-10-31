import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { DeviceEventEmitter, Linking, Platform, StyleSheet } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { DeviceActions } from "./DeviceActions";
import { LanguageChoices } from "./LanguageChoices";
import { LegalSummary } from "./LegalSummary";
import { LicensesScreen } from "./LicensesScreen";
import { LicenseTextsScreen } from "./LicenseTextsScreen";
import { LICENCES, type LicenceList } from "./licences";
import { rememberOpenRow } from "./open-rows";
import { SettingsScreen } from "./SettingsScreen";
import { SourcePanel } from "./SourcePanel";
import { ThemeChoices } from "./ThemeChoices";

// The screens behind the settings rows (#287), each with the pinned way back
// to the list, and what the rows that open in place hold (#511).

// NativeWind's colour-scheme setter needs its compiled stylesheet, which the
// test runner has none of: the provider's call is seen, not applied.
const mockSetColorScheme = jest.fn();
jest.mock("nativewind", () => ({
  ...jest.requireActual("nativewind"),
  useColorScheme: () => ({ colorScheme: "light", setColorScheme: mockSetColorScheme }),
}));

const ok = {
  status: "ok",
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-13T00:00:00.000Z",
  source: "https://github.com/kuutti-ry/kuutti-app",
  db: "ok",
  migrations: "current",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const { __router: router } = jest.requireMock("expo-router") as { __router: { back: jest.Mock } };

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
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);
/** Settings with the row named open, as the app left it in the session given (#511); signed out by default. */
const settingsWith = async (open: string, session: string | null = null) => {
  rememberOpenRow(open, session);
  await renderWithTheme(<SettingsScreen />);
};

beforeEach(async () => {
  rememberOpenRow(null, null);
  store.clear();
  deviceLanguage("en-US");
  router.back.mockReset();
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/health") return json(ok);
    if (url.pathname === "/account/email") {
      return json({ email: null, confirmed: false, codeExpiresAt: null });
    }
    if (url.pathname === "/contacts") return json({ contacts: [] });
    if (url.pathname === "/invitations") {
      return json({
        canInvite: true,
        redeemable: false,
        reward: { fish: 1, likes: 0 },
        open: [],
        counted: 0,
        earned: { fish: 0, likes: 0 },
      });
    }
    if (url.pathname === "/consents") {
      return json({
        consents: [],
        currentVersions: { terms: "t", privacy: "p", research: "r", special_category: "s" },
      });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof fetch;
  await clearSession();
});

describe("the theme's choices", () => {
  it("keeps the theme and the contrast across restarts, the OS being the default", async () => {
    await renderWithTheme(<ThemeChoices />);
    expect(screen.getByLabelText("Theme").props.accessibilityRole).toBe("radiogroup");
    noProblems();
    expect(screen.getByRole("radio", { name: "✓ Same as the phone" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(store.get("kuutti.preference.scheme")).toBe("dark"));
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("dark");
    await fireEvent.press(screen.getByRole("switch", { name: "High contrast" }));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
  });

  it("applies a stored theme at the next start", async () => {
    store.set("kuutti.preference.scheme", "light");
    await renderWithTheme(<ThemeChoices />);
    expect(await screen.findByRole("radio", { name: "✓ Light" })).toBeTruthy();
  });

  it("turns high contrast on and off from its label too", async () => {
    await renderWithTheme(<ThemeChoices />);
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
    expect(
      screen.getByRole("switch", { name: "High contrast" }).props.accessibilityState,
    ).toMatchObject({ checked: true });
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("false"));
  });
});

describe("the language's choices", () => {
  it("follows the phone's language, and the in-app choice beats it and is stored", async () => {
    deviceLanguage("fi-FI", "en-US");
    await renderWithTheme(<LanguageChoices />);
    expect(screen.getByLabelText("Kieli").props.accessibilityRole).toBe("radiogroup");
    noProblems();
    // Languages are listed under their own names, whatever the app's language is.
    await fireEvent.press(screen.getByRole("radio", { name: "Svenska" }));
    expect(await screen.findByLabelText("Språk")).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBe("sv"));
    // Back to the phone's language clears the choice.
    await fireEvent.press(screen.getByRole("radio", { name: "Samma som telefonen" }));
    expect(await screen.findByLabelText("Kieli")).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBeUndefined());
  });

  it("lists Stadi under its own name, with no flag, and keeps the choice (#521)", async () => {
    deviceLanguage("fi-FI", "en-US");
    await renderWithTheme(<LanguageChoices />);
    noProblems();
    await fireEvent.press(screen.getByRole("radio", { name: "Stadi" }));
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBe("fi-x-stadi"));
    // Settings' own words here have no slang, so they stay Finnish.
    expect(await screen.findByLabelText("Kieli")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "✓ Stadi" })).toBeTruthy();
  });

  it("shows a flag in front of each language, but not in its accessible name", async () => {
    await renderWithTheme(<LanguageChoices />);
    const swedish = screen.getByRole("radio", { name: "Svenska" });
    expect(swedish.props.accessibilityLabel).toBe("Svenska");
    expect(screen.getByText("🇦🇽 Svenska")).toBeTruthy();
  });
});

describe("the legal texts under their rows", () => {
  it("show the terms with their version, to anybody", async () => {
    await renderWithTheme(<LegalSummary kind="terms" />);
    expect(screen.getByText(/^DRAFT: Kuutti is a free dating service/)).toBeTruthy();
    // The version, as the link to the full text on the website (#208).
    expect(
      screen.getByRole("link", { name: /^Read the full text on kuutti\.app \(version \S+\)$/ }),
    ).toBeTruthy();
    noProblems();
  });

  it("show the privacy text, and lead to the full policy at its version", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<LegalSummary kind="privacy" />);
    expect(screen.getByText(/^DRAFT: Kuutti stores your year and month of birth/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("link", { name: /^Read the full text/ }));
    expect(open).toHaveBeenCalledWith(
      `https://kuutti.app/legal/privacy/#privacy-${CONSENT_VERSIONS.privacy}`,
    );
    open.mockRestore();
  });

  it("open under their rows for a signed-out device too", async () => {
    await settingsWith("terms");
    expect(screen.getByText(/^DRAFT: Kuutti is a free dating service/)).toBeTruthy();
    await settingsWith("privacy");
    expect(screen.getByText(/^DRAFT: Kuutti stores your year and month of birth/)).toBeTruthy();
  });
});

describe("the consents' rows", () => {
  it("hold the research consent's switch with its words for a person", async () => {
    await saveSession(tokens);
    await settingsWith("research", tokens.sessionId);
    expect(await screen.findByRole("switch", { name: "Take part in research" })).toBeTruthy();
    expect(screen.queryByText("Store my sensitive answers")).toBeNull();
    noProblems();
  });

  it("hold the sensitive answers' switch alone", async () => {
    await saveSession(tokens);
    await settingsWith("special_category", tokens.sessionId);
    expect(await screen.findByRole("switch", { name: "Store my sensitive answers" })).toBeTruthy();
    expect(screen.queryByText("Take part in research")).toBeNull();
  });
});

describe("the source code under its row", () => {
  it("offers the source at the address the API names, to anybody, set to the left", async () => {
    await renderWithTheme(<SourcePanel />);
    const address = await screen.findByText("https://github.com/kuutti-ry/kuutti-app");
    expect(address).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://github.com/kuutti-ry/kuutti-app" }).props.className,
    ).toMatch(/\bself-start\b/);
    expect(
      screen.getByText(/free software under the AGPL-3.0 licence/).props.className,
    ).not.toMatch(/text-center/);
    noProblems();
  });

  it("keeps the words of the offer while the API cannot say where the source is", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await renderWithTheme(<SourcePanel />);
    await settle();
    expect(screen.getByText(/free software under the AGPL-3.0 licence/)).toBeTruthy();
    expect(screen.queryByText("https://github.com/kuutti-ry/kuutti-app")).toBeNull();
  });
});

describe("the licences screen", () => {
  it("lists the packages in families under headings, the rest last", async () => {
    await renderWithTheme(<LicensesScreen />);
    expectPinnedHeader("Licences of the packages", "Back");
    const headings = screen
      .getAllByRole("heading")
      .map((node) => node.props.children)
      .filter((name) => name !== "Licences of the packages");
    expect(headings).toEqual([
      "Expo",
      "React Native",
      "React",
      "Sentry",
      "FormatJS",
      "Other packages",
    ]);
    // A package sits under its family's heading, before the next one.
    const flat = JSON.stringify(screen.toJSON());
    const at = (text: string) => flat.indexOf(text);
    expect(at('"Expo"')).toBeLessThan(at('"expo-router"'));
    expect(at('"expo-router"')).toBeLessThan(at('"React Native"'));
    expect(at('"Other packages"')).toBeLessThan(at('"zod"'));
    noProblems();
  });

  it("reads each package as one row: its name, then who provides it, its version and licence (#512)", async () => {
    await renderWithTheme(<LicensesScreen />);
    const row = screen.getByLabelText("expo-router");
    expect(row.props.accessible).toBe(true);
    const sentence = /^650 Industries, Inc\., version \d+\.\d+\.\d+, MIT$/;
    expect(row.props.accessibilityValue).toEqual({ text: expect.stringMatching(sentence) });
    // Drawn as it is heard, under the name.
    expect(within(row).getByText(sentence)).toBeTruthy();
    expect(screen.getByLabelText("@expo/ui").props.accessibilityValue.text).toMatch(/^expo, /);
    expect(LICENCES.packages.map((p) => screen.getAllByLabelText(p.name).length)).toEqual(
      LICENCES.packages.map((p) => LICENCES.packages.filter((q) => q.name === p.name).length),
    );
  });

  it("gives a package that names nobody no provider (#512)", async () => {
    expect(LICENCES.packages.find((p) => p.name === "react")?.provider).toBeNull();
    await renderWithTheme(<LicensesScreen />);
    expect(screen.getByLabelText("react").props.accessibilityValue).toEqual({
      text: expect.stringMatching(/^Version \d+\.\d+\.\d+, MIT$/),
    });
  });

  it("opens nothing from a package and shows no licence text in the list (#512)", async () => {
    await renderWithTheme(<LicensesScreen />);
    // The way back and the one row to the texts are the only presses on the screen.
    expect(screen.getAllByRole("button").map((node) => node.props.accessibilityLabel)).toEqual([
      "Back",
      "Licence texts",
    ]);
    expect(screen.queryByText(/hereby granted/)).toBeNull();
    expect(screen.queryByText(/^Copyright/)).toBeNull();
    expect(screen.queryByText(/^Licence \d/)).toBeNull();
  });

  it("opens the licence texts from one row, at the end of the list (#512)", async () => {
    const { __router: navigation } = jest.requireMock("expo-router") as {
      __router: { push: jest.Mock };
    };
    navigation.push.mockReset();
    await renderWithTheme(<LicensesScreen />);
    const flat = JSON.stringify(screen.toJSON());
    const last = LICENCES.packages.at(-1)?.name;
    expect(flat.indexOf(`"${last}"`)).toBeLessThan(flat.indexOf('"Licence texts"'));
    noProblems();
    await fireEvent.press(screen.getByRole("button", { name: "Licence texts" }));
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledWith("/settings/licenses/texts");
  });

  it.each([
    ["fi", "Muut paketit", "Lisenssitekstit", /^Colin McDonnell, versio \d/, /^Versio \d/],
    ["sv", "Övriga paket", "Licenstexter", /^Colin McDonnell, version \d/, /^Version \d/],
  ])(
    "speaks %s, the names and the licences as they are",
    async (locale, other, texts, zod, react) => {
      store.set("kuutti.preference.locale", locale);
      await renderWithTheme(<LicensesScreen />);
      expect(screen.getByRole("heading", { name: other })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Expo" })).toBeTruthy();
      expect(screen.getByRole("button", { name: texts })).toBeTruthy();
      expect(screen.getByLabelText("zod").props.accessibilityValue.text).toMatch(zod);
      expect(screen.getByLabelText("react").props.accessibilityValue.text).toMatch(react);
    },
  );
});

describe("the licence texts (#512)", () => {
  const headings = () => screen.getAllByRole("heading").map((node) => node.props.children);
  const selectable = () =>
    screen
      .getAllByText(/./)
      .filter((node) => node.props.selectable)
      .map((node) => node.props.children);
  const pkg = {
    license: "MIT",
    provider: null,
    notices: [],
  };
  const list: LicenceList = {
    packages: [
      {
        ...pkg,
        name: "alpha",
        version: "1.0.0",
        licences: [
          { file: "LICENSE", copyright: ["Copyright Alpha", "Copyright Friends"], text: "mit" },
        ],
      },
      {
        ...pkg,
        name: "beta",
        version: "2.0.0",
        license: "MIT AND Apache-2.0",
        licences: [
          { file: "LICENSE", copyright: ["Copyright Beta"], text: "mit" },
          { file: "LICENSE_FONT", copyright: [], text: "apache" },
        ],
      },
      {
        ...pkg,
        name: "gamma",
        version: "3.0.0",
        licences: [
          { file: "LICENSE", copyright: ["Copyright Gamma"], text: "mit" },
          { file: "LICENSE-VENDORED", copyright: ["Copyright Vendor"], text: "mit" },
        ],
      },
    ],
    texts: { mit: ["Permission.", "As is."], apache: ["Apache License"] },
  };

  it("shows each text once, in the order the packages first name it, the packages under it", async () => {
    await renderWithTheme(<LicenseTextsScreen list={list} />);
    expectPinnedHeader("Licence texts", "Back");
    expect(headings()).toEqual(["Licence texts", "Licence 1", "Packages", "Licence 2", "Packages"]);
    expect(selectable()).toEqual([
      "Permission.",
      "As is.",
      "alpha 1.0.0",
      "Copyright Alpha",
      "Copyright Friends",
      "beta 2.0.0",
      "Copyright Beta",
      // Twice under the one text: each of its licences has its own lines.
      "gamma 3.0.0",
      "Copyright Gamma",
      "gamma 3.0.0",
      "Copyright Vendor",
      "Apache License",
      "beta 2.0.0",
    ]);
    noProblems();
  });

  it("shows each NOTICE once with the packages that ship it, last, and nothing for a text the list lacks", async () => {
    const noticed: LicenceList = {
      packages: [
        {
          ...pkg,
          name: "first",
          version: "1.0.0",
          licences: [{ file: "LICENSE", copyright: [], text: "gone" }],
          notices: ["n1"],
        },
        {
          ...pkg,
          name: "second",
          version: "2.0.0",
          licences: [{ file: "LICENSE", copyright: [], text: "gone" }],
          notices: ["n1", "n2"],
        },
      ],
      texts: { n1: ["Noticed", "---", "Copyright 2026 Someone", "---"], n2: ["Also noticed"] },
    };
    await renderWithTheme(<LicenseTextsScreen list={noticed} />);
    expect(headings()).toEqual([
      "Licence texts",
      "Licence 1",
      "Packages",
      "Notice",
      "Packages",
      "Notice",
      "Packages",
    ]);
    // A repeated paragraph is shown each time, under a key of its own.
    expect(selectable()).toEqual([
      "first 1.0.0",
      "second 2.0.0",
      "Noticed",
      "---",
      "Copyright 2026 Someone",
      "---",
      "first 1.0.0",
      "second 2.0.0",
      "Also noticed",
      "second 2.0.0",
    ]);
  });

  it("carries every text of this build once, a paragraph each, and every package's copyright lines", async () => {
    await renderWithTheme(<LicenseTextsScreen />);
    const distinct = Object.keys(LICENCES.texts);
    expect(headings().filter((name) => /^Licence \d/.test(name))).toHaveLength(distinct.length);
    const shown = selectable();
    const expected = [
      ...Object.values(LICENCES.texts).flat(),
      ...LICENCES.packages.flatMap((p) => [
        ...p.licences.map(() => `${p.name} ${p.version}`),
        ...p.licences.flatMap((l) => l.copyright),
        ...p.licences.flatMap((l) =>
          l.from
            ? `The package carries no licence file of its own; the lines and the text above are from its upstream repository. Address: ${l.from}`
            : [],
        ),
      ]),
    ];
    expect([...shown].sort()).toEqual(expected.sort());
    expect(shown).toContain(
      "- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.",
    );
    expect(shown).toContain(
      "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/",
    );
    noProblems();
  });

  it("says where upstream has the lines and the text of a package that ships none", async () => {
    const upstream: LicenceList = {
      packages: [
        {
          ...pkg,
          name: "bare",
          version: "1.0.0",
          licences: [
            { file: "LICENSE", copyright: ["Copyright Bare"], text: "mit" },
            {
              file: null,
              copyright: ["Copyright Upstream"],
              text: "mit",
              from: "https://example.invalid/LICENSE",
            },
          ],
        },
      ],
      texts: list.texts,
    };
    await renderWithTheme(<LicenseTextsScreen list={upstream} />);
    expect(screen.getAllByText(/^The package carries no licence file of its own/)).toHaveLength(1);
    const texts = screen.getAllByText(/./).map((node) => node.props.children);
    expect(texts.slice(texts.indexOf("Copyright Upstream"))).toEqual([
      "Copyright Upstream",
      "The package carries no licence file of its own; the lines and the text above are from its upstream repository. Address: https://example.invalid/LICENSE",
    ]);
  });

  it("says it of this build's expo-router, one note for each of its two licences", async () => {
    await renderWithTheme(<LicenseTextsScreen />);
    expect(screen.getByText("Copyright (c) 2017 React Navigation Contributors")).toBeTruthy();
    expect(
      screen.getByText(
        /Address: https:\/\/github\.com\/expo\/expo\/blob\/[0-9a-f]{40}\/packages\/expo-router\/src\/react-navigation\/LICENCE$/,
      ),
    ).toBeTruthy();
  });

  it.each([
    ["fi", "Lisenssitekstit", "Lisenssi 1", "Paketit", "Huomautukset"],
    ["sv", "Licenstexter", "Licens 1", "Paket", "Meddelanden"],
  ])(
    "names its headings in %s, the texts as written",
    async (locale, title, first, packages, notice) => {
      store.set("kuutti.preference.locale", locale);
      const licence = { file: "LICENSE", copyright: [], text: "mit" };
      const one = { ...pkg, name: "n", version: "1.0.0", licences: [licence], notices: ["apache"] };
      await renderWithTheme(<LicenseTextsScreen list={{ ...list, packages: [one] }} />);
      expect(headings()).toEqual([title, first, packages, notice, packages]);
      expect(screen.getByText("Permission.")).toBeTruthy();
      expect(screen.getByText("Apache License")).toBeTruthy();
    },
  );
});

describe("this device, under its row", () => {
  it("logs this device out", async () => {
    await saveSession(tokens);
    await renderWithTheme(<DeviceActions />);
    noProblems();
    await fireEvent.press(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
  });

  it("asks before logging out everywhere, says a logout the API did not take, and then logs out", async () => {
    await saveSession(tokens);
    const answers = globalThis.fetch;
    let failing = true;
    let answer = () => undefined as void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const path = (input: Request | string) =>
      new URL(input instanceof Request ? input.url : input).pathname;
    const sent = jest.fn(async (input: Request | string, init?: RequestInit) => {
      if (path(input) === "/auth/logout-all") {
        if (failing) {
          return json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500);
        }
        await answered;
        return new Response(null, { status: 204 });
      }
      return answers(input, init);
    });
    globalThis.fetch = sent as unknown as typeof fetch;
    const logoutsSent = () =>
      sent.mock.calls.filter(([input]) => path(input) === "/auth/logout-all");
    await renderWithTheme(<DeviceActions />);
    expect(screen.getByText("This phone only. You log in again with your bank.")).toBeTruthy();
    expect(
      screen.getByText("Every phone logged in as you, this one too: for a lost or lent phone."),
    ).toBeTruthy();
    // Both outlined: red is the deletion's alone.
    for (const name of ["Log out", "Log out everywhere"]) {
      expect(screen.getByRole("button", { name }).props.className).not.toMatch(/destructive/);
    }
    const ask = async () => {
      await fireEvent.press(screen.getByRole("button", { name: "Log out everywhere" }));
      expect(await screen.findByText("Log out on every phone?")).toBeTruthy();
    };
    await ask();
    await fireEvent.press(screen.getByRole("button", { name: "Stay logged in" }));
    await settle();
    expect(screen.queryByText("Log out on every phone?")).toBeNull();
    // Its close control, Android's back key too, changes nothing either.
    await ask();
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await settle();
    expect(screen.queryByText("Log out on every phone?")).toBeNull();
    expect(logoutsSent()).toHaveLength(0);
    await ask();
    await fireEvent.press(screen.getByRole("button", { name: "Log out on every phone" }));
    await settle();
    const refused = "Not logged out everywhere. Check your connection and try again.";
    expect(screen.getByText(refused).props.accessibilityLiveRegion).toBe("assertive");
    failing = false;
    await ask();
    await fireEvent.press(screen.getByRole("button", { name: "Log out on every phone" }));
    await settle();
    // On its way: the last failure hidden, both buttons held, so it goes once.
    expect(screen.queryByText(refused)).toBeNull();
    expect(screen.getByRole("button", { name: "Log out" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Log out everywhere" })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: "Log out everywhere" }));
    expect(screen.queryByText("Log out on every phone?")).toBeNull();
    expect(logoutsSent()).toHaveLength(2);
    await act(async () => answer());
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
  });

  it("says there is no session on a signed-out device, whose list has the row all the same", async () => {
    await settingsWith("device");
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });
});

describe("the account's rows", () => {
  it("hold the e-mail for a person, the row's title standing for the card's", async () => {
    await saveSession(tokens);
    await settingsWith("email", tokens.sessionId);
    expect(await screen.findByRole("button", { name: "Send a confirmation code" })).toBeTruthy();
    expect(screen.queryByText("A way to stay in touch")).toBeNull();
    expect(screen.getByText(/^Optional\. A way for Kuutti to reach you/)).toBeTruthy();
    // The field's name is in sight, not only for a screen reader.
    expect(screen.getByText("E-mail address")).toBeTruthy();
    noProblems();
  });

  it("hold I found someone, the break and the deletion, for a person", async () => {
    await saveSession(tokens);
    await settingsWith("account", tokens.sessionId);
    for (const name of ["I found someone", "Take a break", "Delete my account"]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Download my data" })).toBeNull();
    noProblems();
  });

  it("hold the copy of one's data under a row of its own (#511)", async () => {
    await saveSession(tokens);
    await settingsWith("export", tokens.sessionId);
    expect(await screen.findByRole("button", { name: "Download my data" })).toBeTruthy();
    noProblems();
  });

  it("hold the contacts for a person (#103)", async () => {
    await saveSession(tokens);
    await settingsWith("contacts", tokens.sessionId);
    expect(await screen.findByText("Phone number")).toBeTruthy();
    expect(screen.getByLabelText("Your Instagram username")).toBeTruthy();
    noProblems();
  });

  it("hold the notification choices and the phone's own permission for a person (#176, #102)", async () => {
    await saveSession(tokens);
    await settingsWith("notifications", tokens.sessionId);
    expect(
      screen.getByText(
        "What you choose here decides what Kuutti tells your phones. A notification says only that there is something, never what or from whom. Each kind is on until you switch it off.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText("This phone has not been asked yet whether Kuutti may notify it."),
    ).toBeTruthy();
    noProblems();
  });

  it("hold the invitations for a person (#107)", async () => {
    await saveSession(tokens);
    await settingsWith("invitations", tokens.sessionId);
    expect(await screen.findByRole("button", { name: "Make an invitation" })).toBeTruthy();
    noProblems();
  });

  describe("keep a field low on the page above the keyboard (#103)", () => {
    // The page's scroll view, and the view around it that gives way to the keyboard.
    const page = () => {
      const scroll = screen.container.queryAll((node) => node.type === "RCTScrollView")[0];
      let around = scroll?.parent ?? null;
      while (around && typeof around.type !== "string") around = around.parent;
      if (!scroll || !around) throw new Error("no scroll view on the page");
      return { scroll, around, padding: StyleSheet.flatten(around.props.style).paddingBottom };
    };
    // The page from y 100 to 800; the keyboard's top at 500.
    const keyboard = (event: string) =>
      act(async () => {
        DeviceEventEmitter.emit(event, {
          endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
        });
      });
    const open = async () => {
      await saveSession(tokens);
      // The contacts' last card, low in the long list of Settings (#511).
      await settingsWith("contacts", tokens.sessionId);
      expect(await screen.findByLabelText("Your Instagram username")).toBeTruthy();
      // The view reads its place from the layout event, which it keeps (persist).
      await act(async () => {
        fireEvent(page().around, "layout", {
          persist: () => undefined,
          nativeEvent: { layout: { x: 0, y: 100, width: 400, height: 700 } },
        });
      });
    };

    it("on Android, by ending the scroll view at the keyboard's top, and no longer once it goes", async () => {
      const os = jest.replaceProperty(Platform, "OS", "android");
      try {
        await open();
        expect(page().padding).toBe(0);
        await keyboard("keyboardDidShow");
        expect(page().padding).toBe(300);
        await keyboard("keyboardDidHide");
        expect(page().padding).toBe(0);
      } finally {
        os.restore();
      }
    });

    it("on iOS, by the scroll view's own inset, without the padding too", async () => {
      const os = jest.replaceProperty(Platform, "OS", "ios");
      try {
        await open();
        expect(page().scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
        await keyboard("keyboardWillShow");
        expect(page().padding).toBe(0);
        await keyboard("keyboardWillHide");
      } finally {
        os.restore();
      }
    });
  });
});
