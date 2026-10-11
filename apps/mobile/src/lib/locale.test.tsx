import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import { Pressable, Text } from "react-native";
import { LocaleProvider, OFFERED_LOCALES, useLocaleSettings, useT } from "./locale";

// The app's language (#13): the stored in-app choice, else the phone's first
// language with a catalogue, else English; en-XA only in a dev build.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

function deviceLanguage(...tags: string[]) {
  (useLocales as jest.Mock).mockReturnValue(tags.map((languageTag) => ({ languageTag })));
}

function Probe() {
  const { t } = useT();
  const settings = useLocaleSettings();
  return (
    <>
      <Text testID="title">{t("settings.title")}</Text>
      <Text testID="preference">{settings.preference}</Text>
      <Text testID="device">{settings.deviceLocale}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="follow the phone"
        onPress={() => settings.setPreference("system")}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="choose Swedish"
        onPress={() => settings.setPreference("sv")}
      />
    </>
  );
}

const show = () =>
  render(
    <LocaleProvider>
      <Probe />
    </LocaleProvider>,
  );
const textOf = (id: string) => screen.getByTestId(id).props.children as string;

beforeEach(() => {
  store.clear();
  deviceLanguage("en-US");
});
afterEach(() => jest.restoreAllMocks());

describe("LocaleProvider", () => {
  it("speaks the phone's first language that has a catalogue", async () => {
    deviceLanguage("de-DE", "fi-FI", "en-US");
    await show();
    expect(textOf("title")).toBe("Asetukset");
    expect(textOf("device")).toBe("fi");
    expect(textOf("preference")).toBe("system");
  });

  it("falls back to English for a phone without any language it has", async () => {
    deviceLanguage("de-DE");
    await show();
    expect(textOf("title")).toBe("Settings");
    expect(textOf("device")).toBe("en");
  });

  it("starts in the language chosen last time, over the phone's", async () => {
    store.set("kuutti.preference.locale", "sv");
    await show();
    await waitFor(() => expect(textOf("title")).toBe("Inställningar"));
    expect(textOf("preference")).toBe("sv");
    expect(textOf("device")).toBe("en");
  });

  it("ignores a stored value that names no language it offers", async () => {
    store.set("kuutti.preference.locale", "de");
    await show();
    await act(async () => undefined);
    expect(textOf("preference")).toBe("system");
    expect(textOf("title")).toBe("Settings");
  });

  it("stores a choice, and forgets it when the person goes back to the phone's language", async () => {
    await show();
    await fireEvent.press(screen.getByLabelText("choose Swedish"));
    await waitFor(() => expect(textOf("title")).toBe("Inställningar"));
    await waitFor(() => expect(store.get("kuutti.preference.locale")).toBe("sv"));
    await fireEvent.press(screen.getByLabelText("follow the phone"));
    await waitFor(() => expect(textOf("title")).toBe("Settings"));
    await waitFor(() => expect(store.has("kuutti.preference.locale")).toBe(false));
  });

  it("refuses to be read outside its provider", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(render(<Probe />)).rejects.toThrow(
      "useLocaleSettings needs a LocaleProvider above it",
    );
  });
});

describe("the languages offered", () => {
  it("include the pseudo-locale in a dev build", () => {
    expect(OFFERED_LOCALES).toContain("en-XA");
  });

  it("leave the pseudo-locale out of a release build", () => {
    const globals = globalThis as unknown as { __DEV__: boolean };
    const dev = globals.__DEV__;
    globals.__DEV__ = false;
    try {
      jest.isolateModules(() => {
        const release = require("./locale") as typeof import("./locale");
        expect(release.OFFERED_LOCALES).not.toContain("en-XA");
        expect(release.OFFERED_LOCALES).toEqual(release.SERVED_LOCALES);
      });
    } finally {
      globals.__DEV__ = dev;
    }
  });
});
