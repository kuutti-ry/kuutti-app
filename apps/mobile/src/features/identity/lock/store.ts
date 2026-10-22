import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { PasscodeHash } from "./passcode";

/** How long the app may be in the background before it locks again: the person's choice (#418, the maintainer's of 22/10/2026). */
export const GRACE_MINUTES = [0, 1, 5, 15] as const;
export type GraceMinutes = (typeof GRACE_MINUTES)[number];
export const DEFAULT_GRACE: GraceMinutes = 1;

/**
 * The lock as this phone keeps it (#418, ADR-045 §2): whether the phone's
 * face or fingerprint opens it, the passcode's hash if one is set, and the
 * time in the background before it locks again. Nothing of it reaches the
 * API: no route, no column, no line of the export.
 */
export type LockSettings = {
  biometrics: boolean;
  passcode: PasscodeHash | null;
  graceMinutes: GraceMinutes;
};

const KEY = "kuutti.lock";
const TRIES_KEY = "kuutti.lock.tries";

// In this phone's keychain or keystore only, readable while it is unlocked,
// never in a backup or on another phone: as the session it guards. Written
// in place, not deleted first as the session is (src/lib/session.ts, for
// items older than that class): only this code ever wrote these, with this
// class, and a write that fails then leaves the lock as it was, never off.
const THIS_DEVICE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const persist = (key: string, value: string): Promise<void> =>
  SecureStore.setItemAsync(key, value, THIS_DEVICE);

export const lockIsOn = (settings: LockSettings | null): boolean =>
  settings !== null && (settings.biometrics || settings.passcode !== null);

const isGrace = (value: unknown): value is GraceMinutes =>
  (GRACE_MINUTES as readonly unknown[]).includes(value);

/** A stored lock in the shape this app writes; anything else is no lock it can open with. */
function parse(raw: string): LockSettings {
  const value = JSON.parse(raw) as Record<string, unknown> | null;
  const passcode = value?.passcode as Record<string, unknown> | null | undefined;
  if (
    typeof value?.biometrics !== "boolean" ||
    !isGrace(value.graceMinutes) ||
    (passcode !== null && (typeof passcode?.salt !== "string" || typeof passcode.hash !== "string"))
  ) {
    throw new Error("the stored lock has another shape");
  }
  return {
    biometrics: value.biometrics,
    passcode:
      passcode === null ? null : { salt: passcode.salt as string, hash: passcode.hash as string },
    graceMinutes: value.graceMinutes,
  };
}

/**
 * The stored lock, or null when there is none. A store that cannot be read,
 * or an item in a shape this app never wrote, throws: the caller keeps the
 * app locked with the bank as the way out rather than open it (ADR-045 §4).
 * The web preview has no lock.
 */
export async function readLock(): Promise<LockSettings | null> {
  if (Platform.OS === "web") return null;
  const raw = await SecureStore.getItemAsync(KEY, THIS_DEVICE);
  return raw === null ? null : parse(raw);
}

/** Saved as the person set it; a lock with neither way in is no lock and is removed. */
export async function writeLock(settings: LockSettings): Promise<void> {
  if (!lockIsOn(settings)) {
    await clearLock();
    return;
  }
  await persist(KEY, JSON.stringify(settings));
}

/** Gone with the session: logging out, by any path, turns the lock off (ADR-045 §2). */
export async function clearLock(): Promise<void> {
  if (Platform.OS === "web") return;
  await SecureStore.deleteItemAsync(KEY, THIS_DEVICE);
  await SecureStore.deleteItemAsync(TRIES_KEY, THIS_DEVICE);
}

/** Wrong passcodes in a row, kept across restarts: closing the app gives no try back. */
export async function readTries(): Promise<number> {
  const raw = await SecureStore.getItemAsync(TRIES_KEY, THIS_DEVICE);
  const tries = raw === null ? 0 : Number(raw);
  return Number.isInteger(tries) && tries >= 0 ? tries : 0;
}

export async function writeTries(tries: number): Promise<void> {
  if (tries === 0) await SecureStore.deleteItemAsync(TRIES_KEY, THIS_DEVICE);
  else await persist(TRIES_KEY, String(tries));
}
