import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import type * as React from "react";
import { AppState, Platform, View } from "react-native";
import { LocaleProvider } from "@/lib/locale";
import { readPreference } from "@/lib/preferences";
import { clearSession, saveSession } from "@/lib/session";
import { underProviders } from "@/test/render";
import { SessionProvider, useSession } from "../session";
import {
  type LockApi,
  LockProvider,
  markLockOffered,
  useLock,
  useLockOfferDue,
} from "./LockProvider";
import { hashPasscode } from "./passcode";
import type { LockSettings } from "./store";

// The app's lock (#418, ADR-045): over the screens at a cold start and after
// the chosen time away, a cover over the app switcher's snapshot, the
// passcode's five tries, the bank as the way out, gone with the session, and
// whether it holds the screens, which a push's tap waits for (#102).

const store = jest.requireMock("expo-secure-store").__store as Map<string, string>;
const secureStore = jest.requireMock("expo-secure-store") as {
  getItemAsync: jest.Mock;
};
// The store's own reading, put back after a test that holds or fails a read.
const reading = secureStore.getItemAsync.getMockImplementation();
const auth = jest.requireMock("expo-local-authentication") as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  supportedAuthenticationTypesAsync: jest.Mock;
  authenticateAsync: jest.Mock;
};

const LOCKED = "Kuutti is locked";
const FIELD = "Your Kuutti passcode";
const BANK = "Sign in with the bank instead";
const CODE = "246810";
const MINUTE = 60_000;

const token = (seed: string) => (seed + "x".repeat(43)).slice(0, 43);
const SESSION = {
  sessionId: "6f1c1c4e-9a8e-4a0b-9c3a-0c8d1e2f3a4b",
  accessToken: token("access"),
  accessExpiresAt: "2099-01-01T00:15:00.000Z",
  refreshToken: token("refresh"),
  refreshExpiresAt: "2099-04-01T00:00:00.000Z",
};

let lock: LockApi;
let session: ReturnType<typeof useSession>;
function Probe() {
  lock = useLock();
  session = useSession();
  return <View testID="below" />;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let listeners: Array<{ event: string; listener: (state?: string) => void }>;
const emit = (event: string, state?: string) =>
  act(async () => {
    for (const entry of listeners) if (entry.event === event) entry.listener(state);
  });
const toApp = (state: string) => emit("change", state);
// The preset's AppState mock has a function there, which replaceProperty refuses.
const mocked = AppState.currentState;

let now = 1_000_000;
let fetchMock: jest.Mock;

const stored = (): LockSettings | null => {
  const raw = store.get("kuutti.lock");
  return raw === undefined ? null : (JSON.parse(raw) as LockSettings);
};
const withPasscode = (over: Partial<LockSettings> = {}): LockSettings => ({
  biometrics: false,
  passcode: hashPasscode(CODE),
  graceMinutes: 1,
  ...over,
});

/** The app's providers over a probe, as a cold start: a session or none, a stored lock or none. */
async function start({
  lock: settings,
  signedIn = true,
}: {
  lock?: LockSettings | string;
  signedIn?: boolean;
} = {}) {
  if (settings !== undefined) {
    store.set("kuutti.lock", typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  if (signedIn) await saveSession(SESSION);
  const view = await render(underProviders(<Probe />));
  await act(async () => undefined);
  return view;
}

async function typeCode(code: string) {
  await fireEvent.changeText(screen.getByLabelText(FIELD), code);
  await act(async () => undefined);
}

type Node = { props: Record<string, () => void>; children?: Array<Node | string> | null };
/** The lock's modal as rendered: the one node with a request to close. */
function modalOf(node: unknown): Node | undefined {
  if (node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) return node.map(modalOf).find(Boolean);
  const host = node as Node;
  if (typeof host.props?.onRequestClose === "function") return host;
  return (host.children ?? []).map(modalOf).find(Boolean);
}

const cover = () => screen.queryByText("Kuutti", { includeHiddenElements: true });
const logouts = () =>
  fetchMock.mock.calls.filter(([input]) => String((input as Request).url).endsWith("/auth/logout"));

beforeEach(async () => {
  jest.clearAllMocks();
  await clearSession();
  store.clear();
  listeners = [];
  (AppState as { currentState: unknown }).currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
    listeners.push({ event, listener: listener as (state?: string) => void });
    return { remove: jest.fn() } as never;
  });
  now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  auth.hasHardwareAsync.mockResolvedValue(false);
  auth.isEnrolledAsync.mockResolvedValue(false);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue([]);
  auth.authenticateAsync.mockResolvedValue({ success: false, error: "not_available" });
});
afterEach(() => {
  secureStore.getItemAsync.mockImplementation(reading);
  (AppState as { currentState: unknown }).currentState = mocked;
  jest.restoreAllMocks();
});

describe("the lock's provider", () => {
  it("The lock is off until the person turns it on", async () => {
    await start();
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(lock.settings).toBeNull();
    await toApp("background");
    now += 60 * MINUTE;
    await toApp("active");
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(cover()).toBeNull();
  });

  it("A cold start with the lock on shows the lock screen", async () => {
    await start({ lock: withPasscode() });
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(screen.getByLabelText(FIELD)).toBeTruthy();
    expect(screen.getByRole("button", { name: BANK })).toBeTruthy();
    // The screens below are there, under the lock.
    expect(screen.getByTestId("below")).toBeTruthy();
    // On iOS no modal: a view of the window's own, which nothing presented can refuse.
    expect(modalOf(screen.toJSON())).toBeUndefined();
  });

  it("holds the lock in a modal on Android, whose back key leaves it where it is", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await start({ lock: withPasscode() });
    const modal = modalOf(screen.toJSON());
    expect(modal).toBeDefined();
    await act(async () => modal?.props.onRequestClose?.());
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("signs out at once when the lock shows with its tries already spent", async () => {
    store.set("kuutti.lock.tries", "5");
    await start({ lock: withPasscode() });
    await act(async () => undefined);
    expect(logouts()).toHaveLength(1);
    expect(session).toMatchObject({ status: "signed-out", notice: "lock" });
  });

  it("checks no code once the tries are spent, as when a sign-out never finished", async () => {
    await start({ lock: withPasscode() });
    // The count reached five behind the lock's back, as after a sign-out cut short.
    store.set("kuutti.lock.tries", "5");
    await typeCode(CODE);
    await act(async () => undefined);
    expect(session.status).toBe("signed-out");
    expect(logouts().length).toBeGreaterThanOrEqual(1);
  });

  it("locks by the clock nobody sets when the wall clock says less", async () => {
    let steady = 0;
    jest.spyOn(performance, "now").mockImplementation(() => steady);
    await start({ lock: withPasscode({ graceMinutes: 5 }) });
    await typeCode(CODE);
    await toApp("background");
    // The wall clock set back by nearly the time away, but not before the departure.
    steady += 5 * MINUTE;
    now += 1;
    await toApp("active");
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("The app locks again after the chosen time in the background", async () => {
    await start({ lock: withPasscode({ graceMinutes: 5 }) });
    await typeCode(CODE);
    expect(screen.queryByText(LOCKED)).toBeNull();
    await toApp("background");
    now += 5 * MINUTE;
    await toApp("active");
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("The app does not lock again within the chosen time", async () => {
    await start({ lock: withPasscode({ graceMinutes: 5 }) });
    await typeCode(CODE);
    await toApp("background");
    now += 5 * MINUTE - 1;
    await toApp("active");
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(cover()).toBeNull();
  });

  it.each([
    [0, 0, true],
    [1, MINUTE - 1, false],
    [1, MINUTE, true],
    [15, 15 * MINUTE - 1, false],
    [15, 15 * MINUTE, true],
  ] as const)("with %p minutes chosen, %p ms away locks: %p", async (graceMinutes, away, locks) => {
    await start({ lock: withPasscode({ graceMinutes }) });
    await typeCode(CODE);
    await toApp("background");
    now += away;
    await toApp("active");
    expect(screen.queryByText(LOCKED) !== null).toBe(locks);
  });

  it("locks when the clock was set back while away, and times from the first background", async () => {
    await start({ lock: withPasscode({ graceMinutes: 15 }) });
    await typeCode(CODE);
    await toApp("background");
    now -= 1;
    await toApp("active");
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("The right passcode opens the app and resets the tries", async () => {
    store.set("kuutti.lock.tries", "3");
    await start({ lock: withPasscode() });
    await typeCode(CODE);
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(store.has("kuutti.lock.tries")).toBe(false);
  });

  it("counts a wrong passcode before checking it, and says the tries left", async () => {
    await start({ lock: withPasscode() });
    await typeCode("111111");
    expect(store.get("kuutti.lock.tries")).toBe("1");
    expect(screen.getByText("Wrong passcode. 4 tries left.")).toBeTruthy();
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("Five wrong passcodes sign this phone out", async () => {
    store.set("kuutti.lock.tries", "4");
    await start({ lock: withPasscode() });
    await typeCode("111111");
    await act(async () => undefined);
    expect(logouts()).toHaveLength(1);
    expect(session).toMatchObject({ status: "signed-out", notice: "lock" });
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(store.has("kuutti.lock")).toBe(false);
    expect(store.has("kuutti.lock.tries")).toBe(false);
  });

  it("Signing in with the bank instead signs this phone out and turns the lock off", async () => {
    await start({ lock: withPasscode() });
    await fireEvent.press(screen.getByRole("button", { name: BANK }));
    await act(async () => undefined);
    expect(logouts()).toHaveLength(1);
    expect(session).toMatchObject({ status: "signed-out", notice: "lock" });
    expect(store.has("kuutti.lock")).toBe(false);
    expect(lock.settings).toBeNull();
  });

  it("starts unlocked at the sign-in after the lock signed this phone out", async () => {
    await start({ lock: withPasscode() });
    await fireEvent.press(screen.getByRole("button", { name: BANK }));
    await act(async () => undefined);
    await act(async () => saveSession(SESSION));
    expect(session.status).toBe("signed-in");
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("Logging out turns the lock off", async () => {
    await start({ lock: withPasscode() });
    await typeCode(CODE);
    await act(async () => session.signOut());
    expect(session).toEqual(expect.objectContaining({ status: "signed-out" }));
    expect(session.status === "signed-out" && session.notice).toBeFalsy();
    expect(store.has("kuutti.lock")).toBe(false);
    expect(lock.settings).toBeNull();
  });

  it("clears a lock left from an earlier session when the app starts signed out", async () => {
    store.set("kuutti.lock.tries", "2");
    await start({ lock: withPasscode(), signedIn: false });
    expect(store.has("kuutti.lock")).toBe(false);
    expect(store.has("kuutti.lock.tries")).toBe(false);
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("A lock that cannot be read keeps the app locked with the bank as the way out", async () => {
    await start({ lock: "{not json" });
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(screen.queryByLabelText(FIELD)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: BANK }));
    await act(async () => undefined);
    expect(session.status).toBe("signed-out");
    expect(store.has("kuutti.lock")).toBe(false);
  });

  it("covers the screens, not locks them, while the stored lock is still being read", async () => {
    const read = deferred<string | null>();
    secureStore.getItemAsync.mockImplementation((key: string) =>
      key === "kuutti.lock" ? read.promise : reading?.(key),
    );
    await start();
    expect(cover()).toBeTruthy();
    expect(screen.queryByText(LOCKED)).toBeNull();
    await act(async () => read.resolve(JSON.stringify(withPasscode())));
    expect(cover()).toBeNull();
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("says it holds the screens while it is read at a cold start, while it shows and under the cover, not once open (#102)", async () => {
    const read = deferred<string | null>();
    secureStore.getItemAsync.mockImplementation((key: string) =>
      key === "kuutti.lock" ? read.promise : reading?.(key),
    );
    await start();
    expect(lock.holding).toBe(true);
    await act(async () => read.resolve(JSON.stringify(withPasscode({ graceMinutes: 5 }))));
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(lock.holding).toBe(true);
    await typeCode(CODE);
    expect(lock.holding).toBe(false);
    // Away, covered: the return may lock.
    await toApp("background");
    expect(lock.holding).toBe(true);
    await toApp("active");
    expect(lock.holding).toBe(false);
  });

  it("says it holds nothing while it is off, away or not", async () => {
    await start();
    expect(lock.holding).toBe(false);
    await toApp("background");
    expect(lock.holding).toBe(false);
  });

  it("says it holds nothing with no session, whatever lock is stored", async () => {
    await start({ lock: withPasscode(), signedIn: false });
    expect(lock.holding).toBe(false);
  });

  it("The app switcher shows a cover while the lock is on", async () => {
    await start({ lock: withPasscode() });
    await typeCode(CODE);
    expect(cover()).toBeNull();
    // iOS, as the app switcher opens: covered, not locked.
    await toApp("inactive");
    expect(cover()).toBeTruthy();
    expect(screen.queryByText(LOCKED)).toBeNull();
    await toApp("active");
    expect(cover()).toBeNull();
    await toApp("background");
    expect(cover()).toBeTruthy();
    await toApp("active");
    expect(cover()).toBeNull();
  });

  it("takes no state but the three it knows as the person leaving or coming back", async () => {
    await start({ lock: withPasscode({ graceMinutes: 0 }) });
    await typeCode(CODE);
    await toApp("unknown");
    expect(cover()).toBeNull();
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("draws no cover on Android while the phone's own prompt has the focus", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(true);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([1]);
    const prompt = deferred<{ success: boolean }>();
    auth.authenticateAsync.mockReturnValue(prompt.promise);
    await start();
    await act(async () => lock.setPasscode(CODE));
    let turning: Promise<string> | undefined;
    await act(async () => {
      turning = lock.setBiometrics(true);
    });
    await emit("blur");
    expect(cover()).toBeNull();
    await act(async () => {
      prompt.resolve({ success: true });
      await turning;
    });
    expect(lock.settings?.biometrics).toBe(true);
  });

  it("draws no cover while the lock is off", async () => {
    await start();
    await toApp("inactive");
    await toApp("background");
    expect(cover()).toBeNull();
  });

  it("on Android covers as the window loses the focus and uncovers as it comes back", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await start({ lock: withPasscode() });
    await typeCode(CODE);
    await emit("blur");
    expect(cover()).toBeTruthy();
    (AppState as { currentState: unknown }).currentState = "background";
    await emit("focus");
    expect(cover()).toBeTruthy();
    (AppState as { currentState: unknown }).currentState = "active";
    await emit("focus");
    expect(cover()).toBeNull();
  });

  it("clears a cover that the lock's own modal drew on Android once the lock opens", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await start({ lock: withPasscode() });
    // The lock's modal took the window's focus.
    await emit("blur");
    await typeCode(CODE);
    expect(cover()).toBeNull();
  });
});

describe("the phone's face or fingerprint on the lock", () => {
  // A trip away while the phone's own prompt is up (Settings turning it on).
  async function awayDuringPrompt(answer: { success: boolean; error?: string }, back: boolean) {
    enrol();
    const prompt = deferred<{ success: boolean; error?: string }>();
    auth.authenticateAsync.mockReturnValue(prompt.promise);
    await start({ lock: withPasscode({ graceMinutes: 1 }) });
    await typeCode(CODE);
    let turning: Promise<string> | undefined;
    await act(async () => {
      turning = lock.setBiometrics(true);
    });
    await toApp("inactive");
    await toApp("background");
    (AppState as { currentState: unknown }).currentState = back ? "active" : "background";
    now += 2 * MINUTE;
    if (back) await toApp("active");
    await act(async () => {
      prompt.resolve(answer);
      await turning;
    });
  }

  it("counts a trip away while the prompt was up once it is cancelled, back already", async () => {
    await awayDuringPrompt({ success: false, error: "system_cancel" }, true);
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("covers after a prompt cancelled while away, and locks on the return", async () => {
    await awayDuringPrompt({ success: false, error: "system_cancel" }, false);
    expect(cover()).toBeTruthy();
    (AppState as { currentState: unknown }).currentState = "active";
    await toApp("active");
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("forgives the trip when the prompt said yes: the owner was there", async () => {
    await awayDuringPrompt({ success: true }, true);
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(lock.settings?.biometrics).toBe(true);
  });

  it("covers, not locks, while the phone is still asked what it has at a cold start", async () => {
    const kind = deferred<boolean>();
    auth.hasHardwareAsync.mockReturnValue(kind.promise);
    auth.isEnrolledAsync.mockResolvedValue(true);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
    await start({ lock: withPasscode({ biometrics: true }) });
    expect(cover()).toBeTruthy();
    expect(screen.queryByText(LOCKED)).toBeNull();
    await act(async () => kind.resolve(true));
    expect(cover()).toBeNull();
    expect(screen.getByRole("button", { name: "Unlock with your face" })).toBeTruthy();
    expect(screen.getByLabelText(FIELD).props.autoFocus).toBe(false);
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it("asks the phone again what it has each time the app comes back with the lock on", async () => {
    await start({ lock: withPasscode() });
    await typeCode(CODE);
    expect(lock.biometrics).toBeNull();
    enrol();
    await toApp("active");
    expect(lock.biometrics).toBe("face");
  });

  it("asks the phone again when Settings asks", async () => {
    await start();
    expect(lock.biometrics).toBeNull();
    enrol();
    await act(async () => lock.recheck());
    expect(lock.biometrics).toBe("face");
  });

  const enrol = () => {
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(true);
    auth.supportedAuthenticationTypesAsync.mockResolvedValue([2]);
  };

  it("opens on the prompt it asks as the lock shows, and resets the tries", async () => {
    enrol();
    store.set("kuutti.lock.tries", "2");
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await start({ lock: withPasscode({ biometrics: true }) });
    await act(async () => undefined);
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(store.has("kuutti.lock.tries")).toBe(false);
  });

  it("stays locked when the prompt is cancelled, with the passcode and the bank still there", async () => {
    enrol();
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
    await start({ lock: withPasscode({ biometrics: true }) });
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock with your face" })).toBeTruthy();
    expect(screen.getByLabelText(FIELD)).toBeTruthy();
    expect(screen.getByRole("button", { name: BANK })).toBeTruthy();
  });

  it("offers no biometric button when the phone no longer has any enrolled", async () => {
    await start({ lock: withPasscode({ biometrics: true }) });
    expect(screen.queryByRole("button", { name: /Unlock with/ })).toBeNull();
    expect(auth.authenticateAsync).not.toHaveBeenCalled();
  });

  it("ignores what the prompt does to the app's state: no cover, no lock", async () => {
    enrol();
    const prompt = deferred<{ success: boolean; error?: string }>();
    auth.authenticateAsync.mockReturnValue(prompt.promise);
    await start({ lock: withPasscode({ biometrics: true, graceMinutes: 0 }) });
    await toApp("inactive");
    await toApp("background");
    expect(cover()).toBeNull();
    await act(async () => prompt.resolve({ success: true }));
    await toApp("active");
    expect(screen.queryByText(LOCKED)).toBeNull();
    expect(cover()).toBeNull();
  });

  it("Turning biometrics on asks for the face or finger once", async () => {
    enrol();
    auth.authenticateAsync.mockResolvedValue({ success: true });
    await start();
    expect(lock.biometrics).toBe("face");
    let answer: string | undefined;
    await act(async () => {
      answer = await lock.setBiometrics(true);
    });
    expect(answer).toBe("ok");
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(auth.authenticateAsync.mock.calls[0]?.[0]).toMatchObject({
      promptMessage: "Unlock Kuutti",
      cancelLabel: "Cancel",
      disableDeviceFallback: true,
    });
    expect(lock.settings).toMatchObject({ biometrics: true, passcode: null, graceMinutes: 1 });
    expect(stored()).toMatchObject({ biometrics: true, passcode: null, graceMinutes: 1 });
    // Off asks nothing, and a lock with neither way is no lock.
    await act(async () => {
      answer = await lock.setBiometrics(false);
    });
    expect(answer).toBe("ok");
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(lock.settings).toBeNull();
    expect(store.has("kuutti.lock")).toBe(false);
  });

  it("leaves biometrics off when the confirming prompt does not succeed", async () => {
    enrol();
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
    await start();
    let answer: string | undefined;
    await act(async () => {
      answer = await lock.setBiometrics(true);
    });
    expect(answer).toBe("failed");
    expect(lock.settings).toBeNull();
    expect(store.has("kuutti.lock")).toBe(false);
  });
});

describe("the lock's settings", () => {
  it("keeps a passcode as its hash, the grace time chosen, and removes a lock with no way in", async () => {
    await start();
    await act(async () => lock.setPasscode(CODE));
    const saved = stored();
    expect(saved?.passcode?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get("kuutti.lock")).not.toContain(CODE);
    expect(saved?.graceMinutes).toBe(1);
    await act(async () => lock.setGrace(15));
    expect(stored()?.graceMinutes).toBe(15);
    expect(lock.settings?.graceMinutes).toBe(15);
    // Turned on while the app is open: nothing locks until it is away.
    expect(screen.queryByText(LOCKED)).toBeNull();
    await act(async () => lock.removePasscode());
    expect(lock.settings).toBeNull();
    expect(store.has("kuutti.lock")).toBe(false);
  });

  it("still checks the passcode when the tries cannot be counted", async () => {
    await start({ lock: withPasscode() });
    secureStore.getItemAsync.mockImplementation((key: string) =>
      key === "kuutti.lock.tries" ? Promise.reject(new Error("keychain")) : reading?.(key),
    );
    await typeCode(CODE);
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("is needed above whoever reads it", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(renderHook(() => useLock())).rejects.toThrow(
      "useLock needs a LockProvider above it",
    );
  });
});

describe("the lock's one offer", () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => underProviders(<>{children}</>);

  it("is due on a phone where it was never offered and the lock is off", async () => {
    await saveSession(SESSION);
    const { result } = await renderHook(() => useLockOfferDue(), { wrapper });
    await act(async () => undefined);
    expect(result.current).toBe(true);
  });

  it("is not known while the phone is asked", async () => {
    const read = deferred<string | null>();
    secureStore.getItemAsync.mockImplementation((key: string) =>
      key === "kuutti.preference.lockOffered" ? read.promise : reading?.(key),
    );
    const { result } = await renderHook(() => useLockOfferDue(), { wrapper });
    expect(result.current).toBeNull();
    await act(async () => read.resolve(null));
    expect(result.current).toBe(true);
  });

  it("is not due once offered, and markLockOffered remembers it", async () => {
    await markLockOffered();
    expect(await readPreference("lockOffered")).toBe("true");
    const { result } = await renderHook(() => useLockOfferDue(), { wrapper });
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  it("is not due while the lock is on", async () => {
    await saveSession(SESSION);
    store.set("kuutti.lock", JSON.stringify(withPasscode()));
    const { result } = await renderHook(() => useLockOfferDue(), { wrapper });
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  it("is never due on the web preview", async () => {
    jest.replaceProperty(Platform, "OS", "web");
    // Without the theme, whose web path wants a class-based dark mode jest lacks.
    const { result } = await renderHook(() => useLockOfferDue(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <LocaleProvider>
          <SessionProvider>
            <LockProvider>{children}</LockProvider>
          </SessionProvider>
        </LocaleProvider>
      ),
    });
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });
});
