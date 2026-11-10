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
 * of a sign-in. Null where nothing can be made, where Apple does not answer in
 * time or refuses, and where what came back is not what the exchange takes: the
 * exchange then goes without, and only an API that requires one refuses it.
 */
export async function attest(challenge: string): Promise<AppAttestation | null> {
  const native = appIntegrity();
  if (!native) return null;
  try {
    const keyId = await native.generateKeyAsync();
    const attestation = await within(ATTEST_WAIT_MS, native.attestKeyAsync(keyId, challenge));
    // Held to the exchange's contract here: a value it would turn down as
    // malformed costs the attestation, not the sign-in.
    const made = AppAttestation.safeParse({ keyId, attestation });
    return made.success ? made.data : null;
  } catch {
    return null;
  }
}

const Assertion = AuthRefreshRequest.shape.assertion.unwrap();

/**
 * The key's assertion over `challenge`, the refresh token being presented.
 * Null where the key is gone (it does not outlive a reinstall or a move to
 * another phone) or nothing can be made: the refresh then goes without, and
 * the API ends the wait of a session that owed one by refusing it.
 */
export async function assert(keyId: string, challenge: string): Promise<string | null> {
  const native = appIntegrity();
  if (!native) return null;
  try {
    const made = Assertion.safeParse(await native.generateAssertionAsync(keyId, challenge));
    return made.success ? made.data : null;
  } catch {
    return null;
  }
}
