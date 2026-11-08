import { Platform } from "react-native";
import { askBiometrics, biometricsOnThisPhone } from "./biometrics";

// The phone's own face or fingerprint (#418, ADR-045 §5): what this phone
// offers, for the button's words, or an iPhone keeping Face ID from Kuutti, and
// the prompt, which never falls back to the phone's own code and tells a cancel,
// the phone's pause and that iPhone apart from a failure.

const auth = jest.requireMock("expo-local-authentication") as {
  AuthenticationType: { FINGERPRINT: number; FACIAL_RECOGNITION: number; IRIS: number };
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  supportedAuthenticationTypesAsync: jest.Mock;
  authenticateAsync: jest.Mock;
};
const { FINGERPRINT, FACIAL_RECOGNITION, IRIS } = auth.AuthenticationType;
const NATIVE = [
  "hasHardwareAsync",
  "isEnrolledAsync",
  "supportedAuthenticationTypesAsync",
  "authenticateAsync",
] as const;
// The setup's answers (a phone with nothing enrolled), put back after each test.
const defaults = Object.fromEntries(
  NATIVE.map((name) => [name, auth[name].getMockImplementation()]),
);

const WORDS = { prompt: "Unlock Kuutti", cancel: "Cancel" };

/** A phone with the hardware, something enrolled, and these kinds. */
function phoneWith(types: number[]) {
  auth.hasHardwareAsync.mockResolvedValue(true);
  auth.isEnrolledAsync.mockResolvedValue(true);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue(types);
}

beforeEach(() => {
  for (const name of NATIVE) auth[name].mockClear();
});
afterEach(() => {
  for (const name of NATIVE) auth[name].mockImplementation(defaults[name]);
  jest.restoreAllMocks();
});

describe("biometricsOnThisPhone", () => {
  it.each([
    ["the face alone", [FACIAL_RECOGNITION], "face"],
    ["the fingerprint alone", [FINGERPRINT], "fingerprint"],
    ["both", [FINGERPRINT, FACIAL_RECOGNITION], "either"],
    ["both, in the other order", [FACIAL_RECOGNITION, FINGERPRINT], "either"],
    ["the iris alone, which is neither", [IRIS], "either"],
    ["the face and the iris", [FACIAL_RECOGNITION, IRIS], "face"],
    ["no kind it names", [], "either"],
  ])("names %s as %p", async (_, types, kind) => {
    phoneWith(types);
    await expect(biometricsOnThisPhone()).resolves.toBe(kind);
  });

  it("is null on an Android phone without the hardware, and asks no further", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    auth.hasHardwareAsync.mockResolvedValue(false);
    await expect(biometricsOnThisPhone()).resolves.toBeNull();
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(1);
    expect(auth.isEnrolledAsync).not.toHaveBeenCalled();
    expect(auth.supportedAuthenticationTypesAsync).not.toHaveBeenCalled();
  });

  // Every iPhone that runs Kuutti has the hardware, so the module's "none" is
  // iOS's biometryNotAvailable, whatever kind is then reported (#505).
  it.each([
    ["Face ID", [FACIAL_RECOGNITION]],
    ["no kind", []],
  ])("is denied on an iPhone that answers no hardware and reports %s", async (_, types) => {
    jest.replaceProperty(Platform, "OS", "ios");
    auth.hasHardwareAsync.mockResolvedValue(false);
    auth.isEnrolledAsync.mockResolvedValue(false);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue(types);
    await expect(biometricsOnThisPhone()).resolves.toBe("denied");
  });

  it.each(["ios", "android"] as const)(
    "is null on %s when the hardware is there and nothing is enrolled",
    async (os) => {
      jest.replaceProperty(Platform, "OS", os);
      auth.hasHardwareAsync.mockResolvedValue(true);
      auth.isEnrolledAsync.mockResolvedValue(false);
      await expect(biometricsOnThisPhone()).resolves.toBeNull();
      expect(auth.supportedAuthenticationTypesAsync).not.toHaveBeenCalled();
    },
  );

  it.each(["hasHardwareAsync", "isEnrolledAsync", "supportedAuthenticationTypesAsync"] as const)(
    "is null when %s throws",
    async (name) => {
      phoneWith([FACIAL_RECOGNITION]);
      auth[name].mockRejectedValue(new Error("native module gone"));
      await expect(biometricsOnThisPhone()).resolves.toBeNull();
    },
  );

  it("is null on the web preview, and never asks the phone", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    phoneWith([FACIAL_RECOGNITION]);
    await expect(biometricsOnThisPhone()).resolves.toBeNull();
    expect(auth.hasHardwareAsync).not.toHaveBeenCalled();
  });
});

describe("askBiometrics", () => {
  it("Biometrics never fall back to the phone's own code", async () => {
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await askBiometrics(WORDS);
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: "Unlock Kuutti",
      cancelLabel: "Cancel",
      // No "Enter Password" on iOS, no device credential on Android.
      disableDeviceFallback: true,
      fallbackLabel: "",
      biometricsSecurityLevel: "weak",
    });
  });

  it("asks in the words it is given", async () => {
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await askBiometrics({ prompt: "Avaa Kuutti", cancel: "Peruuta" });
    expect(auth.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: "Avaa Kuutti", cancelLabel: "Peruuta" }),
    );
  });

  it("answers ok when the face or finger is confirmed", async () => {
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await expect(askBiometrics(WORDS)).resolves.toBe("ok");
  });

  it.each(["user_cancel", "system_cancel", "app_cancel"])(
    "answers cancelled when the prompt ends with %s",
    async (error) => {
      auth.authenticateAsync.mockResolvedValue({ success: false, error });
      await expect(askBiometrics(WORDS)).resolves.toBe("cancelled");
    },
  );

  // Android's 30 seconds, its pause until the phone's own code, and iOS's
  // biometry lockout all come as this one code, with no prompt shown (#464).
  it("answers lockout when the phone has paused its face or fingerprint after too many tries", async () => {
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "lockout" });
    await expect(askBiometrics(WORDS)).resolves.toBe("lockout");
  });

  // Don't Allow at iOS's question, and every ask after it (#505).
  it("answers denied when iOS says Face ID is not available to Kuutti", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
    await expect(askBiometrics(WORDS)).resolves.toBe("denied");
  });

  it("answers failed, not denied, when Android's sensor cannot run", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
    await expect(askBiometrics(WORDS)).resolves.toBe("failed");
  });

  it.each(["lockout ", "Lockout", "unknown: -8, Biometry is locked out."])(
    "answers failed, not lockout, for the near miss %p",
    async (error) => {
      auth.authenticateAsync.mockResolvedValue({ success: false, error });
      await expect(askBiometrics(WORDS)).resolves.toBe("failed");
    },
  );

  it.each([
    "authentication_failed",
    "not_enrolled",
    // The module's answer on a Face ID phone in a build with no purpose string.
    "missing_usage_description",
    "passcode_not_set",
    "user_fallback",
    "timeout",
    "unknown",
    "",
  ])("answers failed when the prompt ends with %p", async (error) => {
    auth.authenticateAsync.mockResolvedValue({ success: false, error });
    await expect(askBiometrics(WORDS)).resolves.toBe("failed");
  });

  it("answers failed when the native call throws", async () => {
    auth.authenticateAsync.mockRejectedValue(new Error("activity gone"));
    await expect(askBiometrics(WORDS)).resolves.toBe("failed");
  });
});
