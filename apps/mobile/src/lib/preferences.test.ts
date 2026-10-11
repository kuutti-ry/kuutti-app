import * as Sentry from "@sentry/react-native";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { readPreference, writePreference } from "./preferences";

// The three small settings that survive a restart (#13, #143): the secure
// store on the phone, localStorage on the web preview, and a store that fails
// is a setting that was never made, reported with the error only.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const captured = Sentry.captureException as jest.Mock;

beforeEach(() => {
  store.clear();
  captured.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("on the phone", () => {
  it("writes a choice to the secure store under its own key and reads it back", async () => {
    await writePreference("scheme", "dark");
    expect(store.get("kuutti.preference.scheme")).toBe("dark");
    expect(await readPreference("scheme")).toBe("dark");
    expect(await readPreference("locale")).toBeNull();
  });

  it("forgets a choice set back to null", async () => {
    await writePreference("highContrast", "on");
    await writePreference("highContrast", null);
    expect(store.has("kuutti.preference.highContrast")).toBe(false);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("kuutti.preference.highContrast");
    expect(await readPreference("highContrast")).toBeNull();
  });

  it("reads a store that fails as nothing set, and reports the error without the value", async () => {
    const failure = new Error("keychain locked");
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(failure);
    expect(await readPreference("locale")).toBeNull();
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith(failure);
  });

  it("keeps going when a write fails, and reports it", async () => {
    const failure = new Error("disk full");
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(failure);
    await expect(writePreference("locale", "fi")).resolves.toBeUndefined();
    expect(captured).toHaveBeenCalledWith(failure);
    expect(store.has("kuutti.preference.locale")).toBe(false);
  });
});

describe("on the web preview", () => {
  const local = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
    removeItem: (key: string) => void local.delete(key),
  };
  const globals = globalThis as { localStorage?: typeof localStorage };

  beforeEach(() => {
    local.clear();
    jest.replaceProperty(Platform, "OS", "web");
    globals.localStorage = localStorage;
  });
  afterEach(() => {
    delete globals.localStorage;
  });

  it("keeps the choice in localStorage and never touches the secure store", async () => {
    (SecureStore.setItemAsync as jest.Mock).mockClear();
    await writePreference("locale", "sv");
    expect(local.get("kuutti.preference.locale")).toBe("sv");
    expect(await readPreference("locale")).toBe("sv");
    await writePreference("locale", null);
    expect(local.has("kuutti.preference.locale")).toBe(false);
    expect(await readPreference("locale")).toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("reads nothing and writes nowhere where the browser has no localStorage", async () => {
    delete globals.localStorage;
    expect(await readPreference("scheme")).toBeNull();
    await expect(writePreference("scheme", "dark")).resolves.toBeUndefined();
    await expect(writePreference("scheme", null)).resolves.toBeUndefined();
    expect(captured).not.toHaveBeenCalled();
  });
});
