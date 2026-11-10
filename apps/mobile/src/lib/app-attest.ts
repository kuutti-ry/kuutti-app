import { AppAttestation, AuthRefreshRequest } from "@kuutti/schema";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Apple's App Attest from the phone's side (ADR-069): at sign-in a key made in
 * the Secure Enclave with Apple's attestation of it, and at each refresh that
 * key's assertion. The native half is Expo's `@expo/app-integrity`, reached
 * here by its module's name and not imported, so that this code moves no
 * fingerprint: a build that does not hold the module (every build until the
 * native batch adds it, #184), an Android phone and the web preview make
 * nothing, and the API says whether nothing will do.
 */
type AppIntegrity = {
  /** Apple's own word on this device: not a simulator, for one. */
  isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  /** Both hand Apple the SHA-256 of the challenge's characters as the client data hash. */
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
};

function appIntegrity(): AppIntegrity | null {
  if (Platform.OS !== "ios") return null;
  const native = requireOptionalNativeModule<AppIntegrity>("ExpoAppIntegrity");
  return native?.isSupported ? native : null;
}

/**
 * As long as Apple may take over an attestation. The one-time code it is made
 * over lives sixty seconds, and the exchange is still to come.
 */
const ATTEST_WAIT_MS = 10_000;

function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * A new key and Apple's attestation of it over `challenge`, the one-time code
 * of a sign-in. Null where nothing can be made, where the phone or Apple does
 * not answer in time or refuses, and where what came back is not what the
 * exchange takes: the exchange then goes without, and only an API that
 * requires one refuses it.
 */
export async function attest(challenge: string): Promise<AppAttestation | null> {
  try {
    const native = appIntegrity();
    if (!native) return null;
    const making = (async () => {
      const keyId = await native.generateKeyAsync();
      return { keyId, attestation: await native.attestKeyAsync(keyId, challenge) };
    })();
    // Held to the exchange's contract here: a value it would turn down as
    // malformed costs the attestation, not the sign-in.
    const made = AppAttestation.safeParse(await within(ATTEST_WAIT_MS, making));
    return made.success ? made.data : null;
  } catch {
    return null;
  }
}

const Assertion = AuthRefreshRequest.shape.assertion.unwrap();

/**
 * What became of an assertion. With none made, `retry` says whether the same
 * key may yet sign: not where the key is gone or this phone signs nothing.
 */
export type Asserted = { assertion: string } | { assertion: null; retry: boolean };

/**
 * The module's codes for a failure that will not pass: the key is no longer
 * in this phone (it does not outlive a reinstall or a move to another phone),
 * or the phone has no App Attest. Any other failure may pass.
 */
const LASTING: ReadonlySet<unknown> = new Set([
  "ERR_APP_INTEGRITY_INVALID_KEY",
  "ERR_APP_INTEGRITY_FEATURE_UNSUPPORTED",
]);

/** As long as the phone's own key may take to sign: a refresh, and every request behind it, waits on this. */
const ASSERT_WAIT_MS = 5_000;

/**
 * The key's assertion over `challenge`, the refresh token being presented.
 * The caller tells the two ways of having none apart: a key that is gone is
 * refreshed without, and the API ends the session that owed an assertion; a
 * key that did not sign this once is tried again, since the API keeps such a
 * session for exactly that (ADR-069 §3).
 */
export async function assert(keyId: string, challenge: string): Promise<Asserted> {
  try {
    const native = appIntegrity();
    if (!native) return { assertion: null, retry: false };
    const signed = await within(ASSERT_WAIT_MS, native.generateAssertionAsync(keyId, challenge));
    if (signed === null) return { assertion: null, retry: true };
    const made = Assertion.safeParse(signed);
    return made.success ? { assertion: made.data } : { assertion: null, retry: false };
  } catch (error) {
    return { assertion: null, retry: !LASTING.has((error as { code?: unknown } | null)?.code) };
  }
}
