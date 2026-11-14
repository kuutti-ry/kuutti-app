import type { SessionTokens } from "@kuutti/schema";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { attack } from "@/test/attack";
import { deferred } from "@/test/deferred";
import {
  clearSession,
  currentSession,
  loadSession,
  markLoginStarted,
  refreshSession,
  saveSession,
  takeLoginStarted,
} from "./session";

// Rules/mobile.md Auth and ADR-027: a bank return belongs to one attempt;
// asynchronous work belongs to the session that started it, not a later one.
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const VERIFIER = "a".repeat(64);
const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const session = (n: number): SessionTokens => ({
  sessionId: `6f1c1c4e-9a8e-4a0b-9c3a-${String(n).padStart(12, "0")}`,
  accessToken: token(`access${n}`),
  accessExpiresAt: new Date(NOW + 900_000).toISOString(),
  refreshToken: `${token(`family${n}`)}.${token(`refresh${n}`)}`,
  refreshExpiresAt: new Date(NOW + 86400_000).toISOString(),
});
const { __store: store } = jest.requireMock("expo-secure-store") as {
  __store: Map<string, string>;
};
const get = jest.mocked(SecureStore.getItemAsync);

beforeEach(async () => {
  jest.replaceProperty(Platform, "OS", "ios");
  jest.spyOn(Date, "now").mockReturnValue(NOW);
  store.clear();
  await clearSession();
  await takeLoginStarted(NOW);
});
afterEach(() => jest.restoreAllMocks());

async function returnedAt(start: number | null, returned: number) {
  if (start !== null) await markLoginStarted(VERIFIER, start);
  return takeLoginStarted(returned);
}

attack("mobile session: a bank return that this phone never started obtains a verifier", {
  attempt: () => returnedAt(null, NOW),
  control: () => returnedAt(NOW, NOW),
  succeeds: (verifier) => expect(verifier).toBe(VERIFIER),
});
attack(
  "mobile session: an expired bank attempt obtains a verifier one millisecond past ten minutes",
  {
    attempt: () => returnedAt(NOW, NOW + 600_001),
    control: () => returnedAt(NOW, NOW + 600_000),
    succeeds: (verifier) => expect(verifier).toBe(VERIFIER),
  },
);
attack("mobile session: a bank attempt dated in the future obtains a verifier", {
  attempt: () => returnedAt(NOW + 1, NOW),
  control: () => returnedAt(NOW, NOW),
  succeeds: (verifier) => expect(verifier).toBe(VERIFIER),
});

async function reused(startAgain: boolean) {
  await markLoginStarted(VERIFIER, NOW);
  expect(await takeLoginStarted(NOW)).toBe(VERIFIER);
  if (startAgain) await markLoginStarted(VERIFIER, NOW);
  return takeLoginStarted(NOW);
}
attack("mobile session: the same bank attempt's verifier can be consumed twice", {
  attempt: () => reused(false),
  control: () => reused(true),
  succeeds: (verifier) => expect(verifier).toBe(VERIFIER),
});

async function superseded(replace: boolean) {
  await markLoginStarted(VERIFIER, NOW);
  if (replace) await markLoginStarted("b".repeat(64), NOW + 1);
  return takeLoginStarted(NOW + 2);
}
attack("mobile session: starting another bank login leaves the earlier attempt's verifier usable", {
  attempt: () => superseded(true),
  control: () => superseded(false),
  succeeds: (verifier) => expect(verifier).toBe(VERIFIER),
});

async function refreshedLate(status: 200 | 401, replace: boolean) {
  await saveSession(session(1));
  const started = deferred<void>();
  const answer = deferred<Response>();
  globalThis.fetch = jest.fn(async () => {
    started.resolve();
    return answer.promise;
  }) as typeof fetch;
  const refresh = refreshSession();
  await started.promise;
  if (replace) await saveSession(session(2));
  answer.resolve(
    new Response(JSON.stringify(status === 200 ? session(1) : { error: {} }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  await refresh;
  return currentSession();
}
attack(
  "mobile session: an earlier refresh response restores the previous account after a new sign-in",
  {
    attempt: () => refreshedLate(200, true),
    control: () => refreshedLate(200, false),
    succeeds: (seen) => expect(seen?.sessionId).toBe(session(1).sessionId),
  },
);
attack("mobile session: an earlier refresh refusal signs out the replacement account", {
  attempt: () => refreshedLate(401, true),
  control: () => refreshedLate(401, false),
  succeeds: (seen) => expect(seen).toBeNull(),
});

async function readLate(replace: boolean) {
  const read = deferred<string | null>();
  get.mockReturnValueOnce(read.promise);
  const loading = loadSession();
  if (replace) await saveSession(session(2));
  read.resolve(JSON.stringify(session(1)));
  await loading;
  return currentSession();
}
attack(
  "mobile session: a delayed keychain read replaces the account that signed in while it waited",
  {
    attempt: () => readLate(true),
    control: () => readLate(false),
    succeeds: (seen) => expect(seen?.sessionId).toBe(session(1).sessionId),
  },
);
