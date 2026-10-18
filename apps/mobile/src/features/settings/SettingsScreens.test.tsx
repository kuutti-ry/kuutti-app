import { CONSENT_VERSIONS } from "@kuutti/i18n";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { DeviceEventEmitter, Linking, Platform, StyleSheet } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { expectPinnedHeader } from "@/test/layout";
import { renderWithTheme } from "@/test/render";
import { AccountScreen } from "./AccountScreen";
import { ConsentScreen, consentKindOf } from "./ConsentScreen";
import { ContactsSettingsScreen } from "./ContactsSettingsScreen";
import { DeviceScreen } from "./DeviceScreen";
import { EmailSettingsScreen } from "./EmailSettingsScreen";
import { LanguageScreen } from "./LanguageScreen";
import { LegalScreen, legalKindOf } from "./LegalScreen";
import { LicensesScreen } from "./LicensesScreen";
import { SourceScreen } from "./SourceScreen";
import { ThemeScreen } from "./ThemeScreen";

// The screens behind the settings rows (#287): each holds one setting, with
// the pinned way back to the list.

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
  refreshToken: token("refresh"),
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

beforeEach(async () => {
  store.clear();
  deviceLanguage("en-US");
  router.back.mockReset();
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/health") return json(ok);
    if (url.pathname === "/account/email") return json({ email: null });
    if (url.pathname === "/contacts") return json({ contacts: [] });
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

describe("the theme screen", () => {
  it("keeps the theme and the contrast across restarts, the OS being the default", async () => {
    await renderWithTheme(<ThemeScreen />);
    // The radio group carries the title's words too, so the pinned-header check reads them inside the scroll.
    expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    noProblems();
    expect(screen.getByRole("radio", { name: "✓ System" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(store.get("kuutti.preference.scheme")).toBe("dark"));
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("dark");
    await fireEvent.press(screen.getByRole("switch", { name: "High contrast" }));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
  });

  it("applies a stored theme at the next start", async () => {
    store.set("kuutti.preference.scheme", "light");
    await renderWithTheme(<ThemeScreen />);
    expect(await screen.findByRole("radio", { name: "✓ Light" })).toBeTruthy();
  });

  it("turns high contrast on and off from its label too", async () => {
    await renderWithTheme(<ThemeScreen />);
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
    expect(
      screen.getByRole("switch", { name: "High contrast" }).props.accessibilityState,
    ).toMatchObject({ checked: true });
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("false"));
  });
});

describe("the language screen", () => {
  it("follows the phone's language, and the in-app choice beats it and is stored", async () => {
    deviceLanguage("fi-FI", "en-US");
    await renderWithTheme(<LanguageScreen />);
    expect(screen.getByRole("heading", { name: "Kieli" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Takaisin" })).toBeTruthy();
    noProblems();
    // Languages are listed under their own names, whatever the app's language is.
    await fireEvent.press(screen.getByRole("radio", { name: "Svenska" }));
    expect(await screen.findByRole("heading", { name: "Språk" })).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBe("sv"));
    // Back to the phone's language clears the choice.
    await fireEvent.press(screen.getByRole("radio", { name: "Telefonens språk" }));
    expect(await screen.findByRole("heading", { name: "Kieli" })).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBeUndefined());
  });

  it("shows a flag in front of each language, but not in its accessible name", async () => {
    await renderWithTheme(<LanguageScreen />);
    const swedish = screen.getByRole("radio", { name: "Svenska" });
    expect(swedish.props.accessibilityLabel).toBe("Svenska");
    expect(screen.getByText("🇦🇽 Svenska")).toBeTruthy();
  });
});

describe("the legal screens", () => {
  it("show the terms with their version, to anybody, and the way back leads back", async () => {
    await renderWithTheme(<LegalScreen kind="terms" />);
    expectPinnedHeader("Terms of use", "Back");
    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^DRAFT: Kuutti is a free dating service/)).toBeTruthy();
    // The version, as the link to the full text on the website (#208).
    expect(
      screen.getByRole("link", { name: /^Read the full text on kuutti\.app \(version \S+\)$/ }),
    ).toBeTruthy();
  });

  it("show the privacy text, and lead to the full policy at its version", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await renderWithTheme(<LegalScreen kind="privacy" />);
    expectPinnedHeader("Privacy", "Back");
    expect(screen.getByText(/^DRAFT: Kuutti stores your year and month of birth/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("link", { name: /^Read the full text/ }));
    expect(open).toHaveBeenCalledWith(
      `https://kuutti.app/legal/privacy/#privacy-${CONSENT_VERSIONS.privacy}`,
    );
    open.mockRestore();
  });

  it("read a link's kind, and take anything else as the terms", () => {
    expect(legalKindOf("privacy")).toBe("privacy");
    expect(legalKindOf("terms")).toBe("terms");
    expect(legalKindOf("cookies")).toBe("terms");
    expect(legalKindOf(undefined)).toBe("terms");
  });
});

describe("the consent screens", () => {
  it("hold the research consent's switch with its words for a person", async () => {
    await saveSession(tokens);
    await renderWithTheme(<ConsentScreen kind="research" />);
    expectPinnedHeader("Research", "Back");
    expect(await screen.findByRole("switch", { name: "Take part in research" })).toBeTruthy();
    expect(screen.queryByText("Store my sensitive answers")).toBeNull();
    noProblems();
  });

  it("hold the sensitive answers' switch alone", async () => {
    await saveSession(tokens);
    await renderWithTheme(<ConsentScreen kind="special_category" />);
    expectPinnedHeader("Sensitive answers", "Back");
    expect(await screen.findByRole("switch", { name: "Store my sensitive answers" })).toBeTruthy();
    expect(screen.queryByText("Take part in research")).toBeNull();
  });

  it("hold nothing for a signed-out device", async () => {
    await renderWithTheme(<ConsentScreen kind="research" />);
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("read a link's kind, and take anything else as the research one", () => {
    expect(consentKindOf("special_category")).toBe("special_category");
    expect(consentKindOf("research")).toBe("research");
    expect(consentKindOf("marketing")).toBe("research");
    expect(consentKindOf(undefined)).toBe("research");
  });
});

describe("the source screen", () => {
  it("offers the source at the address the API names, to anybody", async () => {
    await renderWithTheme(<SourceScreen />);
    expectPinnedHeader("Source code", "Back");
    expect(await screen.findByText("https://github.com/kuutti-ry/kuutti-app")).toBeTruthy();
    noProblems();
  });

  it("keeps the words of the offer while the API cannot say where the source is", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await renderWithTheme(<SourceScreen />);
    await settle();
    expect(screen.getByText(/free software under the AGPL-3.0 licence/)).toBeTruthy();
    expect(screen.queryByText("https://github.com/kuutti-ry/kuutti-app")).toBeNull();
  });
});

describe("the licences screen", () => {
  it("lists the packages with their licences", async () => {
    await renderWithTheme(<LicensesScreen />);
    expectPinnedHeader("Licences of the packages", "Back");
    expect(screen.getByText(/^expo \d.* · MIT$/)).toBeTruthy();
  });
});

describe("this device's screen", () => {
  it("logs this device out", async () => {
    await saveSession(tokens);
    await renderWithTheme(<DeviceScreen />);
    expectPinnedHeader("This device", "Back");
    noProblems();
    await fireEvent.press(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
  });

  it("logs out everywhere, and keeps the device signed in without a word when that fails", async () => {
    await saveSession(tokens);
    const answers = globalThis.fetch;
    let failing = true;
    globalThis.fetch = jest.fn(async (input: Request | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/auth/logout-all") {
        return failing
          ? json({ error: { code: "internal_error", message: "x", requestId: "r" } }, 500)
          : new Response(null, { status: 204 });
      }
      return answers(input, init);
    }) as unknown as typeof fetch;
    await renderWithTheme(<DeviceScreen />);
    await fireEvent.press(await screen.findByRole("button", { name: "Log out everywhere" }));
    await settle();
    expect(screen.getByRole("button", { name: "Log out everywhere" })).toBeTruthy();
    failing = false;
    await fireEvent.press(screen.getByRole("button", { name: "Log out everywhere" }));
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
  });
});

describe("the e-mail and the account screens", () => {
  it("hold the e-mail card for a person", async () => {
    await saveSession(tokens);
    await renderWithTheme(<EmailSettingsScreen />);
    expect(await screen.findByText("A way back in")).toBeTruthy();
    expectPinnedHeader("E-mail", "Back");
    expect(screen.getByRole("button", { name: "Save the address" })).toBeTruthy();
  });

  it("hold the export, the break and the deletion, for a person", async () => {
    await saveSession(tokens);
    await renderWithTheme(<AccountScreen />);
    expect(await screen.findByRole("button", { name: "Download my data" })).toBeTruthy();
    expectPinnedHeader("Your account", "Back");
    for (const name of ["Download my data", "Take a break", "Delete my account"]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }
    noProblems();
  });

  it("hold the contacts for a person (#103)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<ContactsSettingsScreen />);
    expect(await screen.findByText("Phone number")).toBeTruthy();
    expectPinnedHeader("Your contacts", "Back");
    expect(screen.getByLabelText("Your Instagram username")).toBeTruthy();
    noProblems();
  });

  it("say there is no session on the contacts screen of a signed-out device (#103)", async () => {
    await renderWithTheme(<ContactsSettingsScreen />);
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByText("Phone number")).toBeNull();
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
      await renderWithTheme(<ContactsSettingsScreen />);
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

  it("say there is no session on a signed-out device, the e-mail screen and the account screen alike", async () => {
    await renderWithTheme(<EmailSettingsScreen />);
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByText("A way back in")).toBeNull();
  });

  it("say there is no session on the account screen of a signed-out device", async () => {
    await renderWithTheme(<AccountScreen />);
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete my account" })).toBeNull();
  });
});
