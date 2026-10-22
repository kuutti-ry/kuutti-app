import { Platform } from "react-native";
import { askBiometrics, biometricsOnThisPhone } from "./biometrics";

// The phone's own face or fingerprint (#418, ADR-045 §5): what this phone
// offers, for the button's words, and the prompt, which never falls back to
// the phone's own code and tells a cancel apart from a failure.

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

  it("is null on a phone without the hardware, and asks no further", async () => {
    await expect(biometricsOnThisPhone()).resolves.toBeNull();
    expect(auth.hasHardwareAsync).toHaveBeenCalledTimes(1);
    expect(auth.isEnrolledAsync).not.toHaveBeenCalled();
    expect(auth.supportedAuthenticationTypesAsync).not.toHaveBeenCalled();
  });

  it("is null when the hardware is there and nothing is enrolled", async () => {
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(false);
    await expect(biometricsOnThisPhone()).resolves.toBeNull();
    expect(auth.supportedAuthenticationTypesAsync).not.toHaveBeenCalled();
  });

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

  it.each([
    "authentication_failed",
    "lockout",
    "not_enrolled",
    "not_available",
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
