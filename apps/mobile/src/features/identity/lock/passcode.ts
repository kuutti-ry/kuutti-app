import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Six digits (#418, the maintainer's proposal 4). */
export const PASSCODE_LENGTH = 6;
/** Wrong passcodes in a row before this phone's session is dropped (#418, proposal 4). */
export const PASSCODE_TRIES = 5;

/** The passcode as the lock keeps it: never the digits (ADR-045 §3). */
export type PasscodeHash = { salt: string; hash: string };

const digest = (salt: string, code: string): string =>
  bytesToHex(sha256(utf8ToBytes(`${salt}:${code}`)));

/**
 * A salted SHA-256, stretched by nothing (ADR-045 §3): six digits are a
 * million codes, which any stretching a phone can afford at each unlock still
 * lets a machine try in seconds, so what guards the passcode is where the hash
 * lies, this phone's keychain while it is unlocked, and the five tries. The
 * hash keeps the digits themselves out of the store, since people reuse the
 * code of their phone or their bank. The salt has to be unique, not secret: a
 * native version-4 UUID, the random source the sign-in's verifier uses (ADR-027 §5).
 */
export function hashPasscode(code: string): PasscodeHash {
  const salt = globalThis.expo.uuidv4().replace(/-/g, "").toLowerCase();
  return { salt, hash: digest(salt, code) };
}

/** Compared in time that does not depend on where the two first differ. */
export function passcodeMatches(code: string, stored: PasscodeHash): boolean {
  const typed = digest(stored.salt, code);
  if (typed.length !== stored.hash.length) return false;
  let difference = 0;
  for (let i = 0; i < typed.length; i += 1) {
    difference |= typed.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  }
  return difference === 0;
}
