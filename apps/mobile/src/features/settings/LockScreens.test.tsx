import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as Sentry from "@sentry/react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { useLocales } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import type * as React from "react";
import { AccessibilityInfo, AppState, Linking, Platform, View } from "react-native";
import { clearSession, saveSession } from "@/lib/session";
import { a11yProblems, type HostNode, pressables } from "@/test/a11y";
import { renderWithTheme, underProviders } from "@/test/render";
import { LockOfferScreen } from "./LockOfferScreen";
import { rememberOpenRow } from "./open-rows";
import { SettingsScreen } from "./SettingsScreen";

// The app's lock as the person sets it (#418, ADR-045): in Settings, under
// its row (#511), and in its one offer after the e-mail. The phone's face or fingerprint, asked once
// to be turned on; Kuutti's own passcode, typed twice; and, while either is
// on, the time in the background before it locks again. All of it stays in
// this phone's keychain: nothing reaches the API.

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const auth = jest.requireMock("expo-local-authentication") as Record<
  | "hasHardwareAsync"
  | "isEnrolledAsync"
  | "supportedAuthenticationTypesAsync"
  | "authenticateAsync",
  jest.Mock
>;
const { __router: router } = jest.requireMock("expo-router") as {
  __router: { replace: jest.Mock; back: jest.Mock };
};

type StoredLock = {
  biometrics: boolean;
  passcode: { salt: string; hash: string } | null;
  graceMinutes: number;
};
/** The lock as the keychain holds it; null when it is off. */
const stored = () => JSON.parse(store.get("kuutti.lock") ?? "null") as StoredLock | null;

const TEXT = {
  explain: /^Lock Kuutti on this phone, so that somebody else holding it/,
  missing:
    "This phone has no face or fingerprint unlock that Kuutti can use. A passcode works without one.",
  denied:
    "This iPhone does not let Kuutti use Face ID. You can allow it in the phone's settings. A passcode works without it.",
  openSettings: "Open the phone's settings",
  biometrics: "Face or fingerprint",
  failed: "Your face or fingerprint was not confirmed, so it was not turned on.",
  paused:
    "The phone has paused face or fingerprint unlock after too many tries, so it was not turned on. Lock the phone and open it with its own code, then try again.",
  setPasscode: "Set a passcode",
  choose: "Choose a passcode of six digits",
  repeat: "Type the same six digits again",
  mismatch: "The two did not match. Choose the passcode again.",
  cancel: "Cancel",
  passcodeSet: "A passcode is set.",
  change: "Change the passcode",
  remove: "Remove the passcode",
  grace: "Lock again after Kuutti has been in the background",
  always: "Kuutti always locks when it starts.",
  choices: ["Straight away", "1 minute", "5 minutes", "15 minutes"],
};

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const tokens = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2030-01-01T00:15:00.000Z",
  refreshToken: `${token("family")}.${token("refresh")}`,
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const show = async (ui: React.ReactElement) => {
  await renderWithTheme(ui);
  await settle();
};
/** Settings with the lock's row open, as the phone keeps it (#511). */
const showLock = async () => {
  rememberOpenRow("lock", tokens.sessionId);
  await show(<SettingsScreen />);
};
const press = async (element: ReturnType<typeof screen.getByRole>) => {
  await fireEvent.press(element);
  await settle();
};
/** Six digits into the field the label names, as the phone's keypad sends them. */
const type = async (label: string, digits: string) => {
  await fireEvent.changeText(screen.getByLabelText(label), digits);
  await settle();
};
/** A new passcode, typed twice as the screen asks. */
const setPasscode = async (code: string) => {
  await type(TEXT.choose, code);
  await type(TEXT.repeat, code);
};
const button = (name: string) => screen.getByRole("button", { name });
/** The choices of the time before it locks again, a radio group named by its line. */
const graceGroup = () => screen.queryByLabelText(TEXT.grace);
const biometricsSwitch = () => screen.getByRole("switch", { name: TEXT.biometrics });
const checked = (element: ReturnType<typeof screen.getByRole>) =>
  element.props.accessibilityState?.checked as boolean;
const announced = () =>
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map(([words]) => words);
const noProblems = () =>
  expect(pressables(screen.toJSON() as HostNode).flatMap((node) => a11yProblems(node))).toEqual([]);

/** A phone with a face enrolled, whose prompt answers as `answer` says. */
function phoneWithFace(answer: { success: true } | { success: false; error: string }) {
  auth.hasHardwareAsync.mockResolvedValue(true);
  auth.isEnrolledAsync.mockResolvedValue(true);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
  auth.authenticateAsync.mockResolvedValue(answer);
}

beforeEach(async () => {
  rememberOpenRow(null, null);
  store.clear();
  (useLocales as jest.Mock).mockReturnValue([{ languageTag: "en-US" }]);
  router.replace.mockReset();
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  (Sentry.captureException as jest.Mock).mockClear();
  // The phone of jest.setup.js: neither face nor fingerprint.
  auth.hasHardwareAsync.mockResolvedValue(true);
  auth.isEnrolledAsync.mockResolvedValue(false);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue([]);
  auth.authenticateAsync.mockReset();
  auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
  globalThis.fetch = jest.fn(
    async () => new Response(null, { status: 404 }),
  ) as unknown as typeof fetch;
  await saveSession(tokens);
});

afterEach(() => jest.restoreAllMocks());

describe("the lock's settings", () => {
  it("offers no lock on a phone signed out, even with its row kept open", async () => {
    await clearSession();
    await showLock();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();
    expect(screen.queryByText(TEXT.explain)).toBeNull();
    expect(screen.queryByRole("button", { name: TEXT.setPasscode })).toBeNull();
  });

  it("explains the lock, says a phone without face or fingerprint has none, and offers a passcode, with no accessibility problems", async () => {
    await showLock();
    expect(screen.getByText(TEXT.explain)).toBeTruthy();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(button(TEXT.setPasscode)).toBeTruthy();
    // Off: no time to choose before it locks again.
    expect(graceGroup()).toBeNull();
    expect(screen.queryByText(TEXT.always)).toBeNull();
    noProblems();
  });

  it("offers a switch for the face or fingerprint where the phone has one, off until turned on", async () => {
    phoneWithFace({ success: true });
    await showLock();
    expect(checked(biometricsSwitch())).toBe(false);
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
    noProblems();
  });

  it("shows neither the switch nor the words for a phone without one while the phone is still asked", async () => {
    auth.hasHardwareAsync.mockReturnValue(new Promise(() => undefined));
    await showLock();
    expect(screen.getByText(TEXT.explain)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(button(TEXT.setPasscode)).toBeTruthy();
  });

  it("speaks the person's language", async () => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag: "fi-FI" }]);
    phoneWithFace({ success: true });
    await showLock();
    expect(screen.getByRole("button", { name: "Lukitus" })).toBeTruthy();
    await press(screen.getByRole("switch", { name: "Kasvot tai sormenjälki" }));
    for (const name of ["Heti", "✓ 1 minuutti", "5 minuuttia", "15 minuuttia"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });
});

describe("the face or fingerprint", () => {
  it("turning it on asks for the face or finger once, with no fallback to the phone's code, and keeps it on", async () => {
    phoneWithFace({ success: true });
    await showLock();
    await press(biometricsSwitch());
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(auth.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMessage: "Unlock Kuutti",
        cancelLabel: "Cancel",
        disableDeviceFallback: true,
      }),
    );
    expect(checked(biometricsSwitch())).toBe(true);
    expect(stored()).toEqual({ biometrics: true, passcode: null, graceMinutes: 1 });
    expect(screen.queryByText(TEXT.failed)).toBeNull();
    // Turned on here, the app stays open: the lock comes at the next start or return.
    expect(screen.queryByText("Kuutti is locked")).toBeNull();
    noProblems();
  });

  it("the words beside the switch turn it on and off too", async () => {
    phoneWithFace({ success: true });
    await showLock();
    await press(screen.getByText(TEXT.biometrics));
    expect(checked(biometricsSwitch())).toBe(true);
    expect(stored()?.biometrics).toBe(true);
    await press(screen.getByText(TEXT.biometrics));
    expect(checked(biometricsSwitch())).toBe(false);
    expect(stored()).toBeNull();
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it("turning it off asks nothing and, with nothing else holding the lock, turns the lock off", async () => {
    phoneWithFace({ success: true });
    await showLock();
    await press(biometricsSwitch());
    expect(graceGroup()?.props.accessibilityRole).toBe("radiogroup");
    await press(biometricsSwitch());
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(checked(biometricsSwitch())).toBe(false);
    expect(stored()).toBeNull();
    expect(store.has("kuutti.lock")).toBe(false);
    expect(graceGroup()).toBeNull();
  });

  describe.each([
    ["a face that does not match", { success: false, error: "authentication_failed" }, "failed"],
    [
      "a phone that has paused its biometrics after too many tries",
      { success: false, error: "lockout" },
      "paused",
    ],
    ["the person putting the prompt away", { success: false, error: "user_cancel" }, "failed"],
  ] as const)("%s", (_what, answer, said) => {
    it("leaves it off and says why in an assertive live region, aloud on iOS", async () => {
      jest.replaceProperty(Platform, "OS", "ios");
      phoneWithFace(answer);
      await showLock();
      await press(biometricsSwitch());
      expect(checked(biometricsSwitch())).toBe(false);
      expect(stored()).toBeNull();
      expect(screen.getByText(TEXT[said]).props.accessibilityLiveRegion).toBe("assertive");
      expect(announced()).toEqual([TEXT[said]]);
      // Only its own reason.
      expect(screen.queryByText(TEXT[said === "failed" ? "paused" : "failed"])).toBeNull();
      expect(graceGroup()).toBeNull();
    });
  });

  it("trades the pause's words for the failure's when the next try fails, and takes them away on a yes", async () => {
    phoneWithFace({ success: false, error: "lockout" });
    await showLock();
    await press(biometricsSwitch());
    expect(screen.getByText(TEXT.paused)).toBeTruthy();
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "authentication_failed" });
    await press(biometricsSwitch());
    expect(screen.queryByText(TEXT.paused)).toBeNull();
    expect(screen.getByText(TEXT.failed)).toBeTruthy();
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await press(biometricsSwitch());
    expect(screen.queryByText(TEXT.failed)).toBeNull();
    expect(checked(biometricsSwitch())).toBe(true);
  });

  it("leaves the saying of a refusal to the live region on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    phoneWithFace({ success: false, error: "authentication_failed" });
    await showLock();
    await press(biometricsSwitch());
    expect(screen.getByText(TEXT.failed).props.accessibilityLiveRegion).toBe("assertive");
    expect(announced()).toEqual([]);
  });

  it("a prompt that throws leaves it off and says so", async () => {
    phoneWithFace({ success: true });
    auth.authenticateAsync.mockRejectedValue(new Error("no activity"));
    await showLock();
    await press(biometricsSwitch());
    expect(checked(biometricsSwitch())).toBe(false);
    expect(screen.getByText(TEXT.failed)).toBeTruthy();
  });

  it("a second try that answers takes the refusal's words away and turns it on", async () => {
    phoneWithFace({ success: false, error: "authentication_failed" });
    await showLock();
    await press(biometricsSwitch());
    expect(screen.getByText(TEXT.failed)).toBeTruthy();
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await press(biometricsSwitch());
    expect(screen.queryByText(TEXT.failed)).toBeNull();
    expect(checked(biometricsSwitch())).toBe(true);
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(2);
  });

  it("while the phone's prompt is up, the switch waits for it", async () => {
    phoneWithFace({ success: true });
    let answer: (value: { success: true }) => void = () => undefined;
    auth.authenticateAsync.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await showLock();
    await press(biometricsSwitch());
    expect(biometricsSwitch().props.accessibilityState.disabled).toBe(true);
    // A second press on the words while it waits asks nothing more.
    await press(screen.getByText(TEXT.biometrics));
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    await act(async () => answer({ success: true }));
    await settle();
    expect(biometricsSwitch().props.accessibilityState.disabled).toBe(false);
    expect(checked(biometricsSwitch())).toBe(true);
  });
});

describe("coming back to the app", () => {
  // Android's settings, where a finger is set up, put Kuutti in the
  // background; the lock asks the phone on return only while it is on (#464).
  let listeners: Array<{ event: string; listener: (state: string) => void; remove: jest.Mock }>;
  beforeEach(() => {
    listeners = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      const entry = { event, listener: listener as (state: string) => void, remove: jest.fn() };
      listeners.push(entry);
      return { remove: entry.remove } as never;
    });
  });
  const toApp = async (state: string) => {
    await act(async () => {
      for (const entry of listeners) if (entry.event === "change") entry.listener(state);
    });
    await settle();
  };
  /** Away to the phone's own settings and back, as iOS and Android report it. */
  const awayAndBack = async () => {
    await toApp("inactive");
    await toApp("background");
    await toApp("active");
  };
  const enrolFinger = () => {
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(true);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([1]);
  };

  it("The lock's settings ask the phone again when the app comes back", async () => {
    await showLock();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    enrolFinger();
    await awayAndBack();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(checked(biometricsSwitch())).toBe(false);
    noProblems();
  });

  it("asks the phone nothing as the app goes away, only as it comes back", async () => {
    await showLock();
    const asked = auth.hasHardwareAsync.mock.calls.length;
    await toApp("inactive");
    await toApp("background");
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(asked);
    await toApp("active");
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(asked + 1);
  });

  it("says the phone has none once its face or finger was removed meanwhile", async () => {
    phoneWithFace({ success: true });
    await showLock();
    expect(biometricsSwitch()).toBeTruthy();
    auth.isEnrolledAsync.mockResolvedValue(false);
    await awayAndBack();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("keeps the switch through Android 16's pause, which the module reads as none (#499)", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    phoneWithFace({ success: false, error: "lockout" });
    await showLock();
    await press(biometricsSwitch());
    expect(screen.getByText(TEXT.paused)).toBeTruthy();
    auth.isEnrolledAsync.mockResolvedValue(false);
    await awayAndBack();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(checked(biometricsSwitch())).toBe(false);
    // The pause over, the switch turns it on.
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await press(biometricsSwitch());
    expect(checked(biometricsSwitch())).toBe(true);
    expect(screen.queryByText(TEXT.paused)).toBeNull();
  });

  it("asks again on the lock's offer too, which has the same controls", async () => {
    await show(<LockOfferScreen />);
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    enrolFinger();
    await awayAndBack();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(biometricsSwitch()).toBeTruthy();
  });

  it("asks nothing after a trip through inactive alone, so what iOS's prompt answered stays said", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    phoneWithFace({ success: false, error: "authentication_failed" });
    await showLock();
    const asked = auth.hasHardwareAsync.mock.calls.length;
    await press(biometricsSwitch());
    await toApp("inactive");
    await toApp("active");
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(asked);
    expect(screen.getByText(TEXT.failed)).toBeTruthy();
    expect(checked(biometricsSwitch())).toBe(false);
    // A later trip away asks again, and the phone's answer stands.
    auth.isEnrolledAsync.mockResolvedValue(false);
    await awayAndBack();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
  });

  it("offers the switch once the phone's settings let Kuutti use Face ID again (#505)", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    auth.hasHardwareAsync.mockResolvedValue(false);
    await showLock();
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
    phoneWithFace({ success: true });
    await awayAndBack();
    expect(screen.queryByText(TEXT.denied)).toBeNull();
    expect(screen.queryByRole("button", { name: TEXT.openSettings })).toBeNull();
    expect(checked(biometricsSwitch())).toBe(false);
  });

  it("asks once for each trip away, however often it comes back active", async () => {
    await showLock();
    const asked = auth.hasHardwareAsync.mock.calls.length;
    await awayAndBack();
    await toApp("inactive");
    await toApp("active");
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(asked + 1);
  });

  it("stops listening once the screen is left", async () => {
    rememberOpenRow("lock", tokens.sessionId);
    const view = await renderWithTheme(<SettingsScreen />);
    await settle();
    // The lock's, and the notifications row's look at the phone's permission beside it.
    const own = listeners.filter((entry) => entry.event === "change");
    expect(own.length).toBeGreaterThan(0);
    await view.rerender(underProviders(<View />));
    await settle();
    for (const entry of own) expect(entry.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps its panel while its row is closed, so a passcode half typed waits for it (#511)", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await type(TEXT.choose, "135792");
    await press(button("Lock"));
    expect(screen.queryByLabelText(TEXT.repeat)).toBeNull();
    await press(button("Lock"));
    expect(screen.getByLabelText(TEXT.repeat)).toBeTruthy();
  });
});

describe("a lock set with the face or finger the phone no longer has", () => {
  it("still shows the switch, on, beside the line that the phone has none, so it can be turned off", async () => {
    store.set("kuutti.lock", JSON.stringify({ biometrics: true, passcode: null, graceMinutes: 1 }));
    await showLock();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    expect(checked(biometricsSwitch())).toBe(true);
    await press(biometricsSwitch());
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    // Off, and the phone has none: nothing to turn on again from here but the passcode.
    expect(screen.queryByRole("switch", { name: TEXT.biometrics })).toBeNull();
    expect(graceGroup()).toBeNull();
  });
});

describe("an iPhone not letting Kuutti use Face ID (#505)", () => {
  // iOS's biometryNotAvailable, which the module reads as no hardware.
  const denied = () => auth.hasHardwareAsync.mockResolvedValue(false);
  beforeEach(() => jest.replaceProperty(Platform, "OS", "ios"));

  it("Face ID kept from Kuutti is said as that, with the way to turn it on", async () => {
    denied();
    const open = jest.spyOn(Linking, "openSettings").mockResolvedValue();
    await showLock();
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(button(TEXT.setPasscode)).toBeTruthy();
    noProblems();
    await press(button(TEXT.openSettings));
    expect(open).toHaveBeenCalledTimes(1);
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
  });

  it("reports settings that would not open, the error alone", async () => {
    denied();
    const error = new Error("no settings");
    jest.spyOn(Linking, "openSettings").mockRejectedValue(error);
    await showLock();
    await press(button(TEXT.openSettings));
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });

  it("Don't Allow at iOS's question is said as that at once", async () => {
    phoneWithFace({ success: false, error: "not_available" });
    await showLock();
    await press(biometricsSwitch());
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
    expect(announced()).toEqual([TEXT.denied]);
    expect(screen.queryByText(TEXT.failed)).toBeNull();
    expect(screen.queryByText(TEXT.missing)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(button(TEXT.openSettings)).toBeTruthy();
    expect(stored()).toBeNull();
  });

  it("keeps the switch of a lock set with the face, so it can be turned off", async () => {
    denied();
    store.set("kuutti.lock", JSON.stringify({ biometrics: true, passcode: null, graceMinutes: 1 }));
    await showLock();
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
    expect(checked(biometricsSwitch())).toBe(true);
    await press(biometricsSwitch());
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(screen.queryByRole("switch", { name: TEXT.biometrics })).toBeNull();
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
  });

  it("says it on the lock's offer too, which has the same controls", async () => {
    denied();
    await show(<LockOfferScreen />);
    expect(screen.getByText(TEXT.denied)).toBeTruthy();
    expect(button(TEXT.openSettings)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it.each([
    [
      "fi-FI",
      "Tämä iPhone ei anna Kuutin käyttää Face ID:tä. Voit sallia sen puhelimen asetuksista. Pääsykoodi toimii ilman sitä.",
      "Avaa puhelimen asetukset",
    ],
    [
      "sv-FI",
      "Den här iPhonen låter inte Kuutti använda Face ID. Du kan tillåta det i telefonens inställningar. En lösenkod fungerar utan.",
      "Öppna telefonens inställningar",
    ],
  ])("speaks %s", async (languageTag, words, settings) => {
    (useLocales as jest.Mock).mockReturnValue([{ languageTag }]);
    denied();
    await showLock();
    expect(screen.getByText(words)).toBeTruthy();
    expect(button(settings)).toBeTruthy();
  });

  it("says the phone has none on Android, which has no such refusal", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    denied();
    await showLock();
    expect(screen.getByText(TEXT.missing)).toBeTruthy();
    expect(screen.queryByText(TEXT.denied)).toBeNull();
    expect(screen.queryByRole("button", { name: TEXT.openSettings })).toBeNull();
  });
});

describe("the passcode", () => {
  it("typed twice the same, is set, kept only as a salted hash, and said aloud on iOS", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await showLock();
    await press(button(TEXT.setPasscode));
    expect(screen.getByLabelText(TEXT.choose).props.secureTextEntry).toBe(true);
    noProblems();
    await type(TEXT.choose, "123456");
    // The second entry is a field of its own, empty, under its own label.
    expect(screen.queryByLabelText(TEXT.choose)).toBeNull();
    expect(screen.getByLabelText(TEXT.repeat).props.value).toBe("");
    expect(stored()).toBeNull();
    await type(TEXT.repeat, "123456");
    expect(screen.getByText(TEXT.passcodeSet).props.accessibilityLiveRegion).toBe("polite");
    expect(announced()).toEqual([TEXT.passcodeSet]);
    expect(screen.queryByLabelText(TEXT.repeat)).toBeNull();
    const lock = stored();
    expect(lock).toMatchObject({ biometrics: false, graceMinutes: 1 });
    expect(lock?.passcode?.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(lock?.passcode?.hash).toBe(
      bytesToHex(sha256(utf8ToBytes(`${lock?.passcode?.salt}:123456`))),
    );
    expect(store.get("kuutti.lock")).not.toContain("123456");
    expect(button(TEXT.change)).toBeTruthy();
    expect(button(TEXT.remove)).toBeTruthy();
    expect(screen.queryByRole("button", { name: TEXT.setPasscode })).toBeNull();
    noProblems();
  });

  it("is said by the live region alone on Android", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await showLock();
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    expect(screen.getByText(TEXT.passcodeSet)).toBeTruthy();
    expect(announced()).toEqual([]);
  });

  it("drops anything but digits and waits for the sixth", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await type(TEXT.choose, "12a3-45");
    expect(screen.getByLabelText(TEXT.choose).props.value).toBe("12345");
    await type(TEXT.choose, "123456");
    expect(screen.getByLabelText(TEXT.repeat)).toBeTruthy();
  });

  it("two that differ start again from the first, said assertively and aloud on iOS, and set nothing", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await showLock();
    await press(button(TEXT.setPasscode));
    await type(TEXT.choose, "123456");
    await type(TEXT.repeat, "654321");
    expect(screen.getByLabelText(TEXT.choose).props.value).toBe("");
    expect(screen.getByText(TEXT.mismatch).props.accessibilityLiveRegion).toBe("assertive");
    expect(announced()).toEqual([TEXT.mismatch]);
    expect(stored()).toBeNull();
    // The first digits of the new try take the words away.
    await type(TEXT.choose, "111111");
    expect(screen.queryByText(TEXT.mismatch)).toBeNull();
    await type(TEXT.repeat, "111111");
    expect(screen.getByText(TEXT.passcodeSet)).toBeTruthy();
    expect(stored()?.passcode).not.toBeNull();
  });

  it("Cancel leaves it as it was, with no passcode and with one", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await type(TEXT.choose, "123456");
    await press(button(TEXT.cancel));
    expect(screen.queryByLabelText(TEXT.repeat)).toBeNull();
    expect(button(TEXT.setPasscode)).toBeTruthy();
    expect(stored()).toBeNull();

    await press(button(TEXT.setPasscode));
    // Begun again from the first entry.
    await setPasscode("123456");
    const before = store.get("kuutti.lock");
    await press(button(TEXT.change));
    await type(TEXT.choose, "999999");
    await press(button(TEXT.cancel));
    expect(screen.getByText(TEXT.passcodeSet)).toBeTruthy();
    expect(store.get("kuutti.lock")).toBe(before);
  });

  it("changing it replaces the hash and its salt", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    const before = stored()?.passcode;
    await press(button(TEXT.change));
    expect(screen.getByLabelText(TEXT.choose)).toBeTruthy();
    await setPasscode("654321");
    const after = stored()?.passcode;
    expect(after?.salt).not.toBe(before?.salt);
    expect(after?.hash).toBe(bytesToHex(sha256(utf8ToBytes(`${after?.salt}:654321`))));
    expect(screen.getByText(TEXT.passcodeSet)).toBeTruthy();
  });

  it("removing it turns the lock off when nothing else holds it", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    await press(button(TEXT.remove));
    expect(stored()).toBeNull();
    expect(button(TEXT.setPasscode)).toBeTruthy();
    expect(screen.queryByText(TEXT.passcodeSet)).toBeNull();
    expect(graceGroup()).toBeNull();
  });

  it("removing it keeps the lock on while the face or fingerprint holds it", async () => {
    phoneWithFace({ success: true });
    await showLock();
    await press(biometricsSwitch());
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    expect(stored()).toMatchObject({ biometrics: true, passcode: expect.any(Object) });
    await press(button(TEXT.remove));
    expect(stored()).toEqual({ biometrics: true, passcode: null, graceMinutes: 1 });
    expect(graceGroup()?.props.accessibilityRole).toBe("radiogroup");
  });
});

describe("the time in the background before it locks again", () => {
  it("is offered only while the lock is on, one minute chosen and marked in words, and a choice is kept", async () => {
    await showLock();
    expect(graceGroup()).toBeNull();
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    expect(graceGroup()?.props.accessibilityRole).toBe("radiogroup");
    expect(screen.getByText(TEXT.always)).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.props.accessibilityLabel)).toEqual([
      "Straight away",
      "✓ 1 minute",
      "5 minutes",
      "15 minutes",
    ]);
    expect(radios.map(checked)).toEqual([false, true, false, false]);
    noProblems();

    await press(screen.getByRole("radio", { name: "5 minutes" }));
    expect(stored()?.graceMinutes).toBe(5);
    expect(checked(screen.getByRole("radio", { name: "✓ 5 minutes" }))).toBe(true);
    expect(checked(screen.getByRole("radio", { name: "1 minute" }))).toBe(false);

    await press(screen.getByRole("radio", { name: "Straight away" }));
    expect(stored()?.graceMinutes).toBe(0);
    expect(checked(screen.getByRole("radio", { name: "✓ Straight away" }))).toBe(true);
    // The passcode is kept as it was.
    expect(stored()?.passcode).not.toBeNull();
  });

  it("keeps the time chosen when the passcode changes", async () => {
    await showLock();
    await press(button(TEXT.setPasscode));
    await setPasscode("123456");
    await press(screen.getByRole("radio", { name: "15 minutes" }));
    await press(button(TEXT.change));
    await setPasscode("654321");
    expect(stored()?.graceMinutes).toBe(15);
  });
});

it("nothing of the lock reaches the API", async () => {
  phoneWithFace({ success: true });
  await showLock();
  (globalThis.fetch as jest.Mock).mockClear();
  await press(biometricsSwitch());
  await press(button(TEXT.setPasscode));
  await setPasscode("123456");
  await press(screen.getByRole("radio", { name: "5 minutes" }));
  await press(button(TEXT.remove));
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

describe("the lock's one offer, after the e-mail", () => {
  it("is marked offered as it shows, under the later screens' title, with the question and the controls", async () => {
    expect(store.has("kuutti.preference.lockOffered")).toBe(false);
    await show(<LockOfferScreen />);
    expect(store.get("kuutti.preference.lockOffered")).toBe("true");
    expect(screen.getByRole("heading", { name: "While you wait" })).toBeTruthy();
    expect(screen.getByText("Lock Kuutti on this phone?")).toBeTruthy();
    expect(screen.getByText(TEXT.explain)).toBeTruthy();
    expect(button(TEXT.setPasscode)).toBeTruthy();
    noProblems();
  });

  it("Not now leads home and leaves the lock off", async () => {
    await show(<LockOfferScreen />);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    await press(button("Not now"));
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(stored()).toBeNull();
  });

  it("says Done once the lock is on, Not now again once it is off, and either leads home", async () => {
    phoneWithFace({ success: true });
    await show(<LockOfferScreen />);
    await press(biometricsSwitch());
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    await press(button("Done"));
    expect(router.replace).toHaveBeenLastCalledWith("/");
    expect(stored()?.biometrics).toBe(true);
    await press(biometricsSwitch());
    expect(button("Not now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("sets a passcode as Settings does, its fields in reach above the keyboard", async () => {
    await show(<LockOfferScreen />);
    await press(button(TEXT.setPasscode));
    const scroll = screen.container.queryAll((node) => node.type === "RCTScrollView")[0];
    expect(scroll?.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll?.props.automaticallyAdjustKeyboardInsets).toBe(true);
    await setPasscode("123456");
    expect(screen.getByText(TEXT.passcodeSet)).toBeTruthy();
    expect(button("Done")).toBeTruthy();
    noProblems();
  });
});
