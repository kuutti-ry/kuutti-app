import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { assert, attest } from "./app-attest";

// App Attest from the phone's side (ADR-069): Expo's native module, looked up
// by its name, makes a key, has Apple attest it and signs with it. Where a
// build holds no such module, on Android and on the web nothing is made, and
// every failure reads as nothing made: the sign-in and the refresh go on.

jest.mock("expo", () => ({ requireOptionalNativeModule: jest.fn() }));
const lookup = requireOptionalNativeModule as jest.Mock;

// What iOS answers with: a key identifier of 32 bytes and objects, in base64.
const KEY_ID = `${"k".repeat(43)}=`;
const ATTESTATION = "o2NmbXRv+/8=";
const ASSERTION = "omlzaWduYXR1cmU=";

function module(over: Record<string, unknown> = {}) {
  return {
    isSupported: true,
    generateKeyAsync: jest.fn(async () => KEY_ID),
    attestKeyAsync: jest.fn(async () => ATTESTATION),
    generateAssertionAsync: jest.fn(async () => ASSERTION),
    ...over,
  };
}

beforeEach(() => {
  lookup.mockReset();
  jest.replaceProperty(Platform, "OS", "ios");
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("attest", () => {
  it("makes a key and has Apple attest it over the challenge", async () => {
    const native = module();
    lookup.mockReturnValue(native);
    expect(await attest("the one-time code")).toEqual({ keyId: KEY_ID, attestation: ATTESTATION });
    expect(lookup).toHaveBeenCalledWith("ExpoAppIntegrity");
    expect(native.attestKeyAsync).toHaveBeenCalledWith(KEY_ID, "the one-time code");
  });

  it.each(["android", "web"] as const)(
    "makes nothing on %s, and asks for no module",
    async (os) => {
      jest.replaceProperty(Platform, "OS", os);
      lookup.mockReturnValue(module());
      expect(await attest("code")).toBeNull();
      expect(await assert(KEY_ID, "token")).toEqual({ assertion: null, retry: false });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("makes nothing in a build that holds no such module", async () => {
    lookup.mockReturnValue(null);
    expect(await attest("code")).toBeNull();
    expect(await assert(KEY_ID, "token")).toEqual({ assertion: null, retry: false });
  });

  it("makes nothing where Apple says the device has no App Attest, such as a simulator", async () => {
    const native = module({ isSupported: false });
    lookup.mockReturnValue(native);
    expect(await attest("code")).toBeNull();
    expect(await assert(KEY_ID, "token")).toEqual({ assertion: null, retry: false });
    expect(native.generateKeyAsync).not.toHaveBeenCalled();
    expect(native.generateAssertionAsync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no key can be made",
      { generateKeyAsync: jest.fn().mockRejectedValue(new Error("unsupported")) },
    ],
    [
      "Apple refuses or cannot be reached",
      { attestKeyAsync: jest.fn().mockRejectedValue(new Error("serverUnavailable")) },
    ],
  ])("answers nothing when %s, and throws nothing", async (_, over) => {
    lookup.mockReturnValue(module(over));
    await expect(attest("code")).resolves.toBeNull();
  });

  it.each([
    ["a key identifier of another length", { generateKeyAsync: jest.fn(async () => "AAAA") }],
    ["an attestation that is no base64", { attestKeyAsync: jest.fn(async () => "not base64!") }],
    ["an empty attestation", { attestKeyAsync: jest.fn(async () => "") }],
    [
      "an attestation longer than the exchange takes",
      { attestKeyAsync: jest.fn(async () => "A".repeat(16_385)) },
    ],
    ["something that is no text", { attestKeyAsync: jest.fn(async () => ({ data: ATTESTATION })) }],
  ])("answers nothing for %s, which the exchange would turn down as malformed", async (_, over) => {
    lookup.mockReturnValue(module(over));
    expect(await attest("code")).toBeNull();
  });

  it("takes an attestation of the longest length the exchange takes", async () => {
    const longest = "A".repeat(16_384);
    lookup.mockReturnValue(module({ attestKeyAsync: jest.fn(async () => longest) }));
    expect(await attest("code")).toEqual({ keyId: KEY_ID, attestation: longest });
  });

  it("waits ten seconds for Apple and then goes on without, the code being good for sixty", async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    lookup.mockReturnValue(module({ attestKeyAsync: jest.fn(() => never) }));
    let answer: unknown = "pending";
    void attest("code").then((made) => {
      answer = made;
    });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(answer).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    expect(answer).toBeNull();
  });

  it("waits no longer when it is the phone's own key that never comes", async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const native = module({ generateKeyAsync: jest.fn(() => never) });
    lookup.mockReturnValue(native);
    let answer: unknown = "pending";
    void attest("code").then((made) => {
      answer = made;
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(answer).toBeNull();
    expect(native.attestKeyAsync).not.toHaveBeenCalled();
  });

  it("leaves no timer behind once Apple has answered", async () => {
    jest.useFakeTimers();
    lookup.mockReturnValue(module());
    await attest("code");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("assert", () => {
  const GONE = { assertion: null, retry: false };
  const LATER = { assertion: null, retry: true };
  /** A rejection as Expo's module makes one: an error with the module's code. */
  const coded = (code: string) => Object.assign(new Error("[ExpoAppIntegrity]"), { code });

  it("has the key sign the challenge", async () => {
    const native = module();
    lookup.mockReturnValue(native);
    expect(await assert(KEY_ID, "family.rotating")).toEqual({ assertion: ASSERTION });
    expect(native.generateAssertionAsync).toHaveBeenCalledWith(KEY_ID, "family.rotating");
  });

  it.each([
    ["the key is gone, as after a reinstall", "ERR_APP_INTEGRITY_INVALID_KEY"],
    ["the phone has no App Attest after all", "ERR_APP_INTEGRITY_FEATURE_UNSUPPORTED"],
  ])("says there is none to wait for when %s", async (_, code) => {
    lookup.mockReturnValue(
      module({ generateAssertionAsync: jest.fn().mockRejectedValue(coded(code)) }),
    );
    await expect(assert(KEY_ID, "token")).resolves.toEqual(GONE);
  });

  it.each([
    ["the system failed this once", coded("ERR_APP_INTEGRITY_SYSTEM_FAILURE")],
    ["the module does not know why", coded("ERR_APP_INTEGRITY_UNKNOWN")],
    ["the failure has no code", new Error("anything")],
    ["what was thrown is no error", null],
  ])("says the key may yet sign when %s", async (_, thrown) => {
    lookup.mockReturnValue(module({ generateAssertionAsync: jest.fn().mockRejectedValue(thrown) }));
    await expect(assert(KEY_ID, "token")).resolves.toEqual(LATER);
  });

  it("waits five seconds for the key and then says it may yet sign, so that no refresh hangs on it", async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    lookup.mockReturnValue(module({ generateAssertionAsync: jest.fn(() => never) }));
    let answer: unknown = "pending";
    void assert(KEY_ID, "token").then((made) => {
      answer = made;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(answer).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    expect(answer).toEqual(LATER);
  });

  it.each([
    ["no base64", "not base64!"],
    ["empty", ""],
    ["longer than the refresh takes", "A".repeat(2049)],
    ["no text", 7],
  ])("says there is none to wait for when the assertion is %s", async (_, made) => {
    lookup.mockReturnValue(module({ generateAssertionAsync: jest.fn(async () => made) }));
    expect(await assert(KEY_ID, "token")).toEqual(GONE);
  });

  it("takes an assertion of the longest length the refresh takes", async () => {
    const longest = "A".repeat(2048);
    lookup.mockReturnValue(module({ generateAssertionAsync: jest.fn(async () => longest) }));
    expect(await assert(KEY_ID, "token")).toEqual({ assertion: longest });
  });
});

describe("a lookup that throws", () => {
  it("costs the attestation and no more, and leaves the key to be tried again", async () => {
    lookup.mockImplementation(() => {
      throw new Error("no such module");
    });
    await expect(attest("code")).resolves.toBeNull();
    await expect(assert(KEY_ID, "token")).resolves.toEqual({ assertion: null, retry: true });
  });
});
