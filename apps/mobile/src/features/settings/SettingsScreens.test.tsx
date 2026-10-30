import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
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
import { LICENCES, type LicenceList } from "./licences";
import { rememberOpenRow } from "./open-rows";
import { PackageLicenseScreen } from "./PackageLicenseScreen";
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
  it("lists the packages in families under headings, the rest last, each a row with its version and licence", async () => {
    await renderWithTheme(<LicensesScreen />);
    expectPinnedHeader("Licences of the packages", "Back");
    const expo = screen.getByRole("button", { name: "expo" });
    expect(expo.props.accessibilityValue).toEqual({
      text: expect.stringMatching(/^Version \d+\.\d+\.\d+, MIT$/),
    });
    // The version and licence are heard once, as the value, not again as a hint.
    expect(expo.props.accessibilityHint).toBeUndefined();
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
    expect(screen.getAllByRole("button").length).toBe(LICENCES.packages.length + 1);
    noProblems();
  });

  it("opens a package's licence by its place in the list (#416)", async () => {
    const { __router: navigation } = jest.requireMock("expo-router") as {
      __router: { push: jest.Mock };
    };
    navigation.push.mockReset();
    await renderWithTheme(<LicensesScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "zod" }));
    const at = LICENCES.packages.findIndex((p) => p.name === "zod");
    expect(navigation.push).toHaveBeenCalledWith(`/settings/licenses/${at}`);
  });

  it("names the last family and the versions in the person's language", async () => {
    store.set("kuutti.preference.locale", "fi");
    await renderWithTheme(<LicensesScreen />);
    expect(screen.getByRole("heading", { name: "Muut paketit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Expo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "zod" }).props.accessibilityValue.text).toMatch(
      /^Versio /,
    );
  });
});

describe("a package's licence screen (#416)", () => {
  const placeOf = (name: string) => LICENCES.packages.findIndex((p) => p.name === name);
  const selectable = () =>
    screen
      .getAllByText(/./)
      .filter((node) => node.props.selectable)
      .map((node) => node.props.children);

  it("shows the copyright lines over the licence text, a paragraph each, every one selectable", async () => {
    await renderWithTheme(<PackageLicenseScreen index={placeOf("intl-messageformat")} />);
    expectPinnedHeader("intl-messageformat", "Back");
    expect(screen.getByText(/^Version \d.*, BSD-3-Clause$/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Licence" })).toBeTruthy();
    const texts = selectable();
    expect(texts.slice(1, 3)).toEqual([
      "Copyright (c) 2023, Oath Inc.",
      "Licensed under the terms of the New BSD license. See below for terms.",
    ]);
    expect(texts).toContain(
      "- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.",
    );
    expect(screen.queryByText(/carries no licence file/)).toBeNull();
    noProblems();
  });

  it("gives each of several licences a heading of its own, a whole text as its file has it", async () => {
    await renderWithTheme(
      <PackageLicenseScreen index={placeOf("@expo-google-fonts/material-symbols")} />,
    );
    expect(screen.getAllByRole("heading").map((node) => node.props.children)).toEqual([
      "@expo-google-fonts/material-symbols",
      "Licence 1",
      "Licence 2",
    ]);
    expect(screen.getByText("Copyright (c) 2020 Expo")).toBeTruthy();
    expect(
      screen.getByText(
        "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/",
      ),
    ).toBeTruthy();
  });

  it("says where upstream has the lines and the text of a package that ships none", async () => {
    await renderWithTheme(<PackageLicenseScreen index={placeOf("expo-router")} />);
    expect(screen.getByText("Copyright (c) 2017 React Navigation Contributors")).toBeTruthy();
    expect(screen.getAllByText(/^The package carries no licence file of its own/)).toHaveLength(2);
    expect(
      screen.getByText(
        /Address: https:\/\/github\.com\/expo\/expo\/blob\/[0-9a-f]{40}\/packages\/expo-router\/src\/react-navigation\/LICENCE$/,
      ),
    ).toBeTruthy();
  });

  it("shows a NOTICE under its own heading, and nothing for a text the list lacks", async () => {
    const list: LicenceList = {
      packages: [
        {
          name: "noticed",
          version: "1.0.0",
          license: "Apache-2.0",
          licences: [{ file: "LICENSE", copyright: [], text: "gone" }],
          notices: ["n1"],
        },
      ],
      texts: { n1: ["Noticed", "---", "Copyright 2026 Someone", "---"] },
    };
    await renderWithTheme(<PackageLicenseScreen index={0} list={list} />);
    expect(screen.getAllByRole("heading").map((node) => node.props.children)).toEqual([
      "noticed",
      "Licence",
      "Notice",
    ]);
    // A repeated paragraph is shown each time, under a key of its own.
    expect(selectable()).toEqual([
      "Version 1.0.0, Apache-2.0",
      "Noticed",
      "---",
      "Copyright 2026 Someone",
      "---",
    ]);
  });

  it.each([-1, LICENCES.packages.length])(
    "says so for a place %i that has no package",
    async (index) => {
      await renderWithTheme(<PackageLicenseScreen index={index} />);
      expectPinnedHeader("Licences of the packages", "Back");
      expect(screen.getByText("This build's list has no such package.")).toBeTruthy();
    },
  );

  it("names its headings in the person's language, the texts as written", async () => {
    store.set("kuutti.preference.locale", "fi");
    await renderWithTheme(<PackageLicenseScreen index={placeOf("zod")} />);
    expect(screen.getByRole("heading", { name: "Lisenssi" })).toBeTruthy();
    expect(screen.getByText(/^Permission is hereby granted/)).toBeTruthy();
  });
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
