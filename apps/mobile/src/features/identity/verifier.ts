import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * What binds a bank login's one-time code to this phone (RFC 8252 §8.1,
 * ADR-027): every start makes a verifier, kept with the pending mark, and
 * /auth/start carries its SHA-256; /auth/exchange takes the code only with
 * the verifier. Another app that reads the code off the deep link has no
 * verifier to send. Both are 64 lowercase hex characters, the challenge as
 * the API hashes the verifier.
 */

// shortcut: two native v4 UUIDs (SecureRandom on Android, arc4random on iOS), 244 random bits,
// because no CSPRNG reaches JavaScript without a native module; expo-crypto's
// getRandomBytes(32) in the native batch (#184) lifts it (ADR-027).
export const newVerifier = (): string =>
  `${globalThis.expo.uuidv4()}${globalThis.expo.uuidv4()}`.replace(/-/g, "").toLowerCase();

export const challengeOf = (verifier: string): string => bytesToHex(sha256(utf8ToBytes(verifier)));
