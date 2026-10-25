import * as React from "react";
import { AppState, type AppStateStatus, Modal, Platform, StyleSheet, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/locale";
import { readPreference, writePreference } from "@/lib/preferences";
import { useSession } from "../session";
import {
  askBiometrics,
  type BiometricAnswer,
  type Biometrics,
  biometricsOnThisPhone,
} from "./biometrics";
import { LockScreen, type PasscodeAnswer } from "./LockScreen";
import { hashPasscode, PASSCODE_TRIES, passcodeMatches } from "./passcode";
import {
  clearLock,
  DEFAULT_GRACE,
  type GraceMinutes,
  type LockSettings,
  lockIsOn,
  readLock,
  readTries,
  writeLock,
  writeTries,
} from "./store";

/** What Settings and the offer read and change, and what the push waits for. */
export type LockApi = {
  /** The lock as stored; null while it is off. */
  settings: LockSettings | null;
  /**
   * Whether the lock holds the screens: shown, still deciding at a cold
   * start, or covering them while the app is away, whence it may come back
   * locked. A tap on a push waits while it holds (#102), since a screen
   * opened under the lock would run before anybody unlocked it.
   */
  holding: boolean;
  /** What this phone can open it with; null when nothing is enrolled, undefined while asked. */
  biometrics: Biometrics | null | undefined;
  /** Asks the phone again what it has, as Settings opens. */
  recheck: () => Promise<void>;
  /** Turning biometrics on asks for the face or finger once; "failed" leaves it off. */
  setBiometrics: (on: boolean) => Promise<"ok" | "failed">;
  setPasscode: (code: string) => Promise<void>;
  removePasscode: () => Promise<void>;
  setGrace: (minutes: GraceMinutes) => Promise<void>;
};

const LockContext = React.createContext<LockApi | null>(null);

/**
 * A moment by the wall clock and by a clock nobody sets, performance.now.
 * shortcut: that one stops while the phone sleeps, so a wall clock set back
 * in sleep to a time after the departure goes unseen; a native read of the
 * time since boot lifts it (ADR-045 §4, Open 7).
 */
const now = () => ({ wall: Date.now(), steady: performance.now() });

/**
 * The app's lock (#418, ADR-045). It gates the screens, not the session
 * (the maintainer's proposal 1): over everything, the lock screen holds the
 * app at a cold start and once it comes back after the chosen time in the
 * background, and a plain cover lies over the screens whenever
 * the app is in the app switcher or the background, so the snapshot shows
 * none of them. The cover is a view, not a second modal: on Android a modal
 * is a window of its own, which takes the focus whose loss draws the cover,
 * and the cover would then stand for good. The screens below go on as they
 * are; the session is read as before.
 *
 * The lock belongs to this phone's session: whenever there is none, any lock
 * stored is removed, so logging out by any path turns it off, and a sign-in
 * after it starts unlocked. A stored lock that cannot be read keeps the app
 * locked with the bank as the only way out.
 */
export function LockProvider({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const session = useSession();
  const { status, signOut } = session;
  // undefined until read; null when there is none.
  const [settings, setSettings] = React.useState<LockSettings | null | undefined>(undefined);
  const [unreadable, setUnreadable] = React.useState(false);
  const [biometrics, setAvailable] = React.useState<Biometrics | null | undefined>(undefined);
  // "start" until the first moment signed in with the store read: a cold start.
  const [phase, setPhase] = React.useState<"start" | "open" | "locked">("start");
  const [covered, setCovered] = React.useState(false);
  // When the app went to the background, for the grace time: the wall clock,
  // and a clock nobody sets, which catches a wall clock set back while the
  // phone is awake (ADR-045 §4).
  const away = React.useRef<{ wall: number; steady: number } | null>(null);
  // The phone's own prompt is up: what it does to the app's state is not the
  // person leaving, but a real trip to the background meanwhile is kept here.
  const asking = React.useRef(false);
  const leftWhileAsking = React.useRef<{ wall: number; steady: number } | null>(null);

  React.useEffect(() => {
    let live = true;
    readLock().then(
      (stored) => live && setSettings(stored),
      () => {
        if (!live) return;
        setUnreadable(true);
        setSettings(null);
      },
    );
    void biometricsOnThisPhone().then((kind) => live && setAvailable(kind));
    return () => {
      live = false;
    };
  }, []);
  // The phone's face or finger may be added or removed while Kuutti is away:
  // asked again as the lock comes back, and as Settings opens (`recheck`).
  const recheck = React.useCallback(async () => {
    setAvailable(await biometricsOnThisPhone());
  }, []);

  const on = unreadable || lockIsOn(settings ?? null);
  const graceMs = (settings?.graceMinutes ?? DEFAULT_GRACE) * 60_000;
  /** Whether a time away is long enough to lock: a clock set back counts as long enough. */
  const longEnough = React.useCallback(
    (since: { wall: number; steady: number }) => {
      const wall = Date.now() - since.wall;
      return wall < 0 || Math.max(wall, performance.now() - since.steady) >= graceMs;
    },
    [graceMs],
  );

  React.useEffect(() => {
    if (status === "loading" || settings === undefined) return;
    if (status === "signed-out") {
      setPhase("open");
      if (settings !== null || unreadable) {
        setSettings(null);
        setUnreadable(false);
        void clearLock().catch(() => undefined);
      }
      return;
    }
    setPhase((current) => (current === "start" ? (on ? "locked" : "open") : current));
  }, [status, settings, unreadable, on]);

  const signedInWithLock = status === "signed-in" && on;
  React.useEffect(() => {
    if (!signedInWithLock) {
      setCovered(false);
      away.current = null;
      leftWhileAsking.current = null;
      return;
    }
    const subscriptions = [
      AppState.addEventListener("change", (next: AppStateStatus) => {
        if (asking.current) {
          if (next === "background") leftWhileAsking.current ??= now();
          return;
        }
        if (next === "background") {
          away.current ??= now();
          setCovered(true);
        } else if (next === "inactive") {
          // iOS, as the app switcher opens: the snapshot is taken after this.
          setCovered(true);
        } else if (next === "active") {
          setCovered(false);
          void recheck();
          const since = away.current;
          away.current = null;
          if (since !== null && longEnough(since)) setPhase("locked");
        }
      }),
    ];
    // Android has no "inactive": it loses the window's focus as recents open.
    // shortcut: the cover is drawn from JavaScript, so Android may take the
    // recents thumbnail first; setRecentsScreenshotEnabled(false) behind a
    // native module lifts it, FLAG_SECURE may not (#296; ADR-045 §4, Open 3).
    if (Platform.OS === "android") {
      subscriptions.push(
        AppState.addEventListener("blur", () => {
          if (!asking.current) setCovered(true);
        }),
        AppState.addEventListener("focus", () => {
          if (AppState.currentState === "active") setCovered(false);
        }),
      );
    }
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [signedInWithLock, longEnough, recheck]);

  // Unlocked: the cover goes too, since Android drew it as the lock's own
  // modal took the focus and says nothing until the modal is gone.
  const open = React.useCallback(() => {
    setPhase("open");
    setCovered(false);
  }, []);

  /**
   * The phone's prompt, for the lock and for Settings alike. A trip to the
   * background while it was up still counts once it answers: away still, it
   * covers and waits for the return; back already, the time away is judged
   * now. A yes from the face or finger is the owner, so it forgives the trip.
   */
  const ask = React.useCallback(async (): Promise<BiometricAnswer> => {
    asking.current = true;
    leftWhileAsking.current = null;
    let answer: BiometricAnswer = "failed";
    try {
      answer = await askBiometrics({
        prompt: t("lock.biometrics.prompt"),
        cancel: t("lock.biometrics.cancel"),
      });
      return answer;
    } finally {
      asking.current = false;
      const since = leftWhileAsking.current;
      leftWhileAsking.current = null;
      if (since !== null) {
        if (AppState.currentState !== "active") {
          away.current ??= since;
          setCovered(true);
        } else if (answer !== "ok" && longEnough(since)) {
          setPhase("locked");
        }
      }
    }
  }, [t, longEnough]);

  const unlockWithBiometrics = React.useCallback(async (): Promise<BiometricAnswer> => {
    const answer = await ask();
    if (answer === "ok") {
      await writeTries(0).catch(() => undefined);
      open();
    }
    return answer;
  }, [ask, open]);

  const leave = React.useCallback(() => signOut("lock"), [signOut]);

  const unlockWithPasscode = React.useCallback(
    async (code: string): Promise<PasscodeAnswer> => {
      const stored = settings?.passcode;
      if (!stored) return { ok: false, left: 0 };
      // Counted before it is checked: closing the app in between gives no try back.
      // A store that cannot count still checks the code, which alone opens it.
      const before = await readTries().catch(() => 0);
      // The tries are spent: a sign-out that never finished, a restart, and
      // this one goes to the bank without being checked.
      if (before >= PASSCODE_TRIES) {
        await leave();
        return { ok: false, left: 0 };
      }
      const tries = before + 1;
      await writeTries(tries).catch(() => undefined);
      if (passcodeMatches(code, stored)) {
        await writeTries(0).catch(() => undefined);
        open();
        return { ok: true };
      }
      const left = Math.max(0, PASSCODE_TRIES - tries);
      if (left === 0) await leave();
      return { ok: false, left };
    },
    [settings, leave, open],
  );

  const change = React.useCallback(
    async (next: (current: LockSettings) => LockSettings) => {
      const current = settings ?? {
        biometrics: false,
        passcode: null,
        graceMinutes: DEFAULT_GRACE,
      };
      const updated = next(current);
      await writeLock(updated);
      setSettings(lockIsOn(updated) ? updated : null);
    },
    [settings],
  );

  const signedIn = status === "signed-in";
  // Signed in at a cold start: locked while the stored lock is on, and
  // covered while it is not read yet, or while the phone is still asked
  // whether it has the face or finger the lock was set with.
  const kindPending = settings?.biometrics === true && biometrics === undefined;
  const deciding = signedIn && phase === "start" && (settings === undefined || on);
  // What the lock wants shown; held back as a cover while the phone is asked.
  const wantsLock = signedIn && settings !== undefined && (phase === "locked" || deciding);
  const locked = wantsLock && !kindPending;
  const cover =
    signedIn &&
    ((covered && on) || (deciding && settings === undefined) || (wantsLock && kindPending));
  // The cover counts while away: the return that locks lifts it in the same render.
  const holding = signedIn && (phase === "locked" || deciding || (covered && on));

  const api = React.useMemo<LockApi>(
    () => ({
      settings: settings ?? null,
      holding,
      biometrics,
      recheck,
      setBiometrics: async (wanted) => {
        if (wanted && (await ask()) !== "ok") return "failed";
        await change((current) => ({ ...current, biometrics: wanted }));
        return "ok";
      },
      setPasscode: (code) => change((current) => ({ ...current, passcode: hashPasscode(code) })),
      removePasscode: () => change((current) => ({ ...current, passcode: null })),
      setGrace: (minutes) => change((current) => ({ ...current, graceMinutes: minutes })),
    }),
    [settings, holding, biometrics, recheck, change, ask],
  );

  // A lock that shows with its tries spent goes to the bank at once.
  React.useEffect(() => {
    if (!locked || !settings?.passcode) return;
    let live = true;
    void readTries()
      .catch(() => 0)
      .then((tries) => {
        if (live && tries >= PASSCODE_TRIES) void leave();
      });
    return () => {
      live = false;
    };
  }, [locked, settings, leave]);

  const lockScreen = (
    <LockScreen
      biometrics={settings?.biometrics ? (biometrics ?? null) : null}
      passcode={Boolean(settings?.passcode)}
      onBiometrics={unlockWithBiometrics}
      onPasscode={unlockWithPasscode}
      onBank={() => void leave()}
    />
  );

  return (
    <LockContext.Provider value={api}>
      {children}
      {cover && (
        <View
          style={StyleSheet.absoluteFill}
          className="items-center justify-center bg-background"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="h1">{t("lock.cover")}</Text>
        </View>
      )}
      {/* iOS: a view of the window's own, above whatever is presented, a
          photo picker or a share sheet the lock could not be presented over
          as a modal, and above an open dialog; modal to VoiceOver. Android:
          a modal, a window of its own, whose back key stays on the lock. */}
      {locked && Platform.OS === "ios" && (
        <FullWindowOverlay>
          <View style={StyleSheet.absoluteFill} className="bg-background">
            {lockScreen}
          </View>
        </FullWindowOverlay>
      )}
      {Platform.OS !== "ios" && (
        <Modal
          visible={locked}
          animationType="none"
          presentationStyle="fullScreen"
          statusBarTranslucent
          onRequestClose={() => undefined}
        >
          {lockScreen}
        </Modal>
      )}
    </LockContext.Provider>
  );
}

export function useLock(): LockApi {
  const value = React.useContext(LockContext);
  if (!value) throw new Error("useLock needs a LockProvider above it");
  return value;
}

/**
 * Whether the lock is still to be offered on this phone, after the e-mail
 * among the later screens (#418, proposal: offered once): never on the web
 * preview, never while it is on, never twice. Null while asked.
 */
export function useLockOfferDue(): boolean | null {
  const { settings } = useLock();
  const [offered, setOffered] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let live = true;
    void readPreference("lockOffered").then((stored) => live && setOffered(stored !== null));
    return () => {
      live = false;
    };
  }, []);
  if (Platform.OS === "web") return false;
  if (offered === null) return null;
  return !offered && settings === null;
}

/** The offer is made once it has been shown. */
export function markLockOffered(): Promise<void> {
  return writePreference("lockOffered", "true");
}
