import { AppAttestation, AuthExchangeRequest, SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { apiBaseUrl } from "./api-url";
import { assert } from "./app-attest";

/**
 * The device's session (#35, rules/mobile.md Auth): the access token, the
 * refresh token and the session id from /auth/exchange, in expo-secure-store,
 * never AsyncStorage. The web preview keeps them in memory only: no product
 * surface on the web (rule 8). Refreshing is single-flight, so ten requests
 * that meet an expired access token cause one refresh, and a refresh the API
 * refuses signs the device out (the refresh token was retired, revoked or is
 * past its end, ninety days unused or a year after the bank login, ADR-058:
 * the person logs in through their bank again).
 *
 * A session that began with an attestation (ADR-069) keeps the identifier of
 * its App Attest key beside the tokens, and each refresh carries that key's
 * assertion over the refresh token. The key itself never leaves the Secure
 * Enclave, and the identifier is no secret.
 */
const Stored = SessionTokens.extend({ attestKeyId: AppAttestation.shape.keyId.optional() });
export type StoredSession = SessionTokens & { attestKeyId?: string };

const KEY = "kuutti.session";

let memory: StoredSession | null = null;
let generation = 0;
let revision = 0;
let writes: Promise<void> = Promise.resolve();
let pendingWrites = 0;

/** Changes on sign-out or replacement, but not on token rotation within a session. */
export const sessionGeneration = (): number => generation;
export const isCurrentSession = (expected: number): boolean => generation === expected;

/**
 * A session belongs to the device that signed in through the bank (#35, TD-1):
 * an iOS keychain item with the default accessibility is restored onto a new
 * iPhone from an encrypted backup or a device transfer, and the new phone would
 * resume the session without the bank. THIS_DEVICE_ONLY keeps the item out of
 * backups and transfers; Android's Keystore never backs its keys up, so this
 * changes nothing there. The security review of 10/10/2026.
 *
 * The item is deleted before every write: the keychain keeps an existing
 * item's accessibility on an update (SecItemUpdate rewrites the value only),
 * so a pair stored before this rule would stay migratable for as long as its
 * session lived. A delete on a missing item is not an error; a crash between
 * the two calls costs the local pair, which a bank login replaces.
 */
const THIS_DEVICE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function persist(session: StoredSession | null): Promise<void> {
  memory = session;
  const change = ++revision;
  if (Platform.OS !== "web") {
    pendingWrites += 1;
    const write = writes.then(async () => {
      if (revision !== change) return;
      await SecureStore.deleteItemAsync(KEY);
      if (session !== null && revision === change) {
        await SecureStore.setItemAsync(KEY, JSON.stringify(session), THIS_DEVICE);
      }
    });
    // Each caller still receives its own error; a failed native write must
    // not prevent a later sign-out or replacement from reaching storage.
    writes = write.catch(() => undefined);
    try {
      await write;
    } finally {
      pendingWrites -= 1;
    }
  }
  if (revision === change) notify();
}

/** Loaded once at start; a value that does not parse is treated as no session. */
export async function loadSession(): Promise<StoredSession | null> {
  if (Platform.OS === "web") return memory;
  const read = revision;
  let loaded: StoredSession | null;
  try {
    if (pendingWrites > 0) {
      await writes;
      if (revision !== read) return memory;
    }
    const raw = await SecureStore.getItemAsync(KEY);
    loaded = raw ? Stored.parse(JSON.parse(raw)) : null;
  } catch {
    loaded = null;
  }
  if (revision !== read) return memory;
  if (memory?.sessionId !== loaded?.sessionId) generation += 1;
  revision += 1;
  memory = loaded;
  return memory;
}

export const currentSession = (): StoredSession | null => memory;

export async function saveSession(session: StoredSession): Promise<void> {
  if (memory?.sessionId !== session.sessionId) {
    generation += 1;
    assertFailingSince = null;
  }
  await persist(session);
}

export async function clearSession(): Promise<void> {
  generation += 1;
  await persist(null);
}

type Listener = (session: StoredSession | null) => void;
const listeners = new Set<Listener>();
const notify = () => {
  for (const listener of listeners) listener(memory);
};

/** Called whenever the stored session changes, including when a refresh fails and the device is signed out. */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * How long a key that does not sign, for a reason that may pass, is waited for
 * (ADR-069 §3). The API refuses a refresh that owes an assertion and leaves
 * the session as it is, so that the next good one gets through; sending such
 * a refresh without would end here in a sign-out and a bank login, for a
 * hiccup. So the session is kept and the next request tries again, for this
 * long; after it the refresh goes without, and the API decides.
 */
const ASSERT_PATIENCE_MS = 60 * 1000;
let assertFailingSince: number | null = null;

/** Refresh when the access token has under this long left, rather than after a 401. */
const REFRESH_AHEAD_MS = 30 * 1000;

export function accessTokenIsStale(session: StoredSession, now = Date.now()): boolean {
  return new Date(session.accessExpiresAt).getTime() - now < REFRESH_AHEAD_MS;
}

type Refresh = {
  generation: number;
  refreshToken: string;
  promise: Promise<StoredSession | null>;
};
let inFlight: Refresh | null = null;

/**
 * One refresh at a time: callers that arrive while one runs get its result.
 * Null means the device is signed out. Uses fetch directly rather than the
 * typed client, whose middleware would call back into here.
 */
export function refreshSession(): Promise<StoredSession | null> {
  const session = memory;
  if (!session) return Promise.resolve(null);
  if (inFlight?.generation === generation && inFlight.refreshToken === session.refreshToken) {
    return inFlight.promise;
  }
  const owner = generation;
  const ownsInput = () => isCurrentSession(owner) && memory?.refreshToken === session.refreshToken;
  const flight: Refresh = {
    generation: owner,
    refreshToken: session.refreshToken,
    promise: Promise.resolve(null),
  };
  inFlight = flight;
  flight.promise = (async () => {
    try {
      // What a session with a key owes (ADR-069 §3). Without one, or where the
      // key is gone, the refresh goes as it always did and the API decides.
      let assertion: string | null = null;
      if (session.attestKeyId) {
        const signed = await assert(session.attestKeyId, session.refreshToken);
        if (!ownsInput()) return null;
        if (signed.assertion === null && signed.retry) {
          assertFailingSince ??= Date.now();
          if (Date.now() - assertFailingSince < ASSERT_PATIENCE_MS) return session;
        }
        assertion = signed.assertion;
      }
      assertFailingSince = null;
      const response = await fetch(`${apiBaseUrl()}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refreshToken: session.refreshToken,
          ...(assertion ? { assertion } : {}),
        }),
      });
      if (!ownsInput()) return null;
      if (response.status === 401) {
        await clearSession();
        return null;
      }
      if (!response.ok) return session; // the API is unwell; keep what we have and try again later
      const next = SessionTokens.parse(await response.json());
      if (!ownsInput()) return null;
      if (next.sessionId !== session.sessionId) throw new Error("refresh changed session");
      // The key is the session's for its life: a rotation keeps it.
      await persist(session.attestKeyId ? { ...next, attestKeyId: session.attestKeyId } : next);
      return isCurrentSession(owner) ? memory : null;
    } catch (error) {
      if (!isCurrentSession(owner)) return null;
      throw error;
    } finally {
      if (inFlight === flight) inFlight = null;
    }
  })();
  return flight.promise;
}

/**
 * Only a login this device started may end in a session here: the browser's
 * return carries a one-time code, and a code an attacker minted with their
 * own bank login and sent as a link would otherwise sign this phone into
 * their account. The mark keeps the attempt's verifier too, which the
 * exchange sends and without which the API refuses the code, so a code that
 * another app on the phone reads off the deep link is worth nothing to it
 * (RFC 8252 §8.1, ADR-027). A new start replaces the mark: only the latest
 * attempt's code can sign in. The mark outlives the app process (Android may
 * end it while the browser is open) and a login attempt's ten minutes.
 */
const PENDING_KEY = "kuutti.session.pending";
const PENDING_TTL_MS = 10 * 60 * 1000;
let pendingInMemory: string | null = null;

export async function markLoginStarted(verifier: string, now = Date.now()): Promise<void> {
  const value = JSON.stringify({ at: now, verifier });
  pendingInMemory = value;
  if (Platform.OS !== "web") {
    await SecureStore.deleteItemAsync(PENDING_KEY);
    await SecureStore.setItemAsync(PENDING_KEY, value, THIS_DEVICE);
  }
}

/** The started login's verifier, once: reading the mark clears it. Null when there is none to take. */
export async function takeLoginStarted(now = Date.now()): Promise<string | null> {
  let value = pendingInMemory;
  if (Platform.OS !== "web") {
    try {
      value = (await SecureStore.getItemAsync(PENDING_KEY)) ?? value;
      await SecureStore.deleteItemAsync(PENDING_KEY);
    } catch {
      // Unreadable is the same as absent: the link is refused, the person taps the button again.
    }
  }
  pendingInMemory = null;
  return freshVerifier(value, now);
}

/** The verifier in the shape the exchange takes it. */
const Verifier = AuthExchangeRequest.shape.verifier;

/**
 * The mark's verifier while the mark is within its ten minutes. A mark that
 * does not parse, or holds the time alone as one from before ADR-027 did,
 * counts as none, like a missing one.
 */
function freshVerifier(value: string | null, now: number): string | null {
  let mark: { at?: unknown; verifier?: unknown } | null;
  try {
    mark = JSON.parse(value ?? "null");
  } catch {
    return null;
  }
  const at = mark?.at;
  const age = typeof at === "number" ? now - at : Number.NaN;
  const verifier = Verifier.safeParse(mark?.verifier);
  return age >= 0 && age <= PENDING_TTL_MS && verifier.success ? verifier.data : null;
}
