import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme } from "@/test/render";
import { SettingsScreen } from "./SettingsScreen";

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

beforeEach(async () => {
  store.clear();
  deviceLanguage("en-US");
  router.back.mockReset();
  globalThis.fetch = jest.fn(async (input: Request | string) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/health") return json(ok);
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

describe("the settings screen", () => {
  it("renders in English on an English phone, with a way back and no accessibility problems", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual(
      [],
    );
  });

  it("follows the phone's language, and the in-app choice beats it and is stored", async () => {
    deviceLanguage("fi-FI", "en-US");
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByRole("heading", { name: "Asetukset" })).toBeTruthy();
    // Languages are listed under their own names, whatever the app's language is.
    fireEvent.press(screen.getByRole("radio", { name: "Svenska" }));
    expect(await screen.findByRole("heading", { name: "Inställningar" })).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBe("sv"));
    // Back to the phone's language clears the choice.
    fireEvent.press(screen.getByRole("radio", { name: "Telefonens språk" }));
    expect(await screen.findByRole("heading", { name: "Asetukset" })).toBeTruthy();
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBeUndefined());
  });

  it("shows a flag in front of each language, but not in its accessible name", async () => {
    await renderWithTheme(<SettingsScreen />);
    const swedish = screen.getByRole("radio", { name: "Svenska" });
    expect(swedish.props.accessibilityLabel).toBe("Svenska");
    expect(screen.getByText("🇦🇽 Svenska")).toBeTruthy();
  });

  it("keeps the theme and the contrast across restarts, the OS being the default", async () => {
    await renderWithTheme(<SettingsScreen />);
    expect(screen.getByRole("radio", { name: "✓ System" })).toBeTruthy();
    fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(store.get("kuutti.preference.scheme")).toBe("dark"));
    expect(mockSetColorScheme).toHaveBeenLastCalledWith("dark");
    fireEvent.press(screen.getByRole("switch", { name: "High contrast" }));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
  });

  it("applies a stored theme at the next start", async () => {
    store.set("kuutti.preference.scheme", "light");
    await renderWithTheme(<SettingsScreen />);
    expect(await screen.findByRole("radio", { name: "✓ Light" })).toBeTruthy();
  });

  it("offers this device's session and the account only when signed in, and the source offer always", async () => {
    const signedOut = await renderWithTheme(<SettingsScreen />);
    await settle();
    expect(screen.getByText("No session on this device.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log out everywhere" })).toBeNull();
    expect(screen.getByText("About Kuutti")).toBeTruthy();
    expect(screen.getByText("https://github.com/kuutti-ry/kuutti-app")).toBeTruthy();
    // The two groups stand whoever looks (#170); the consents need a person.
    expect(screen.getByRole("heading", { name: "App settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
    expect(screen.queryByText("Your consents")).toBeNull();
    signedOut.unmount();

    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await settle();
    expect(await screen.findByRole("button", { name: "Log out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out everywhere" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download my data" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take a break" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete my account" })).toBeTruthy();
    expect(screen.getByText("Your consents")).toBeTruthy();
    expect(await screen.findByLabelText("Take part in research")).toBeTruthy();
  });

  it("puts the app's settings before the account, the S-Pankki way (#170)", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
    await settle();
    const texts = (screen.toJSON() as HostNode[] | HostNode | null) ?? [];
    const flat = JSON.stringify(texts);
    const order = [
      "App settings",
      "Theme",
      "Language",
      "Your consents",
      "About Kuutti",
      "Account",
      "This device",
      "Your account",
    ].map((label) => flat.indexOf(`"${label}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("turns high contrast on and off from its label too", async () => {
    await renderWithTheme(<SettingsScreen />);
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("true"));
    expect(
      screen.getByRole("switch", { name: "High contrast" }).props.accessibilityState,
    ).toMatchObject({
      checked: true,
    });
    await fireEvent.press(screen.getByText("High contrast"));
    await waitFor(() => expect(store.get("kuutti.preference.highContrast")).toBe("false"));
  });

  it("logs this device out", async () => {
    await saveSession(tokens);
    await renderWithTheme(<SettingsScreen />);
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
    await renderWithTheme(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole("button", { name: "Log out everywhere" }));
    await settle();
    expect(screen.getByRole("button", { name: "Log out everywhere" })).toBeTruthy();
    failing = false;
    await fireEvent.press(screen.getByRole("button", { name: "Log out everywhere" }));
    expect(await screen.findByText("No session on this device.")).toBeTruthy();
  });

  it("leaves the source offer out while the API cannot say where the source is", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await renderWithTheme(<SettingsScreen />);
    await settle();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByText("Source code")).toBeNull();
  });
});
