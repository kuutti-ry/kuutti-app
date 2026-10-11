import type { PondSummary } from "@kuutti/schema";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useSession } from "../session";
import { fetchOnboarding } from "./client";

export type OnboardingGate =
  | { status: "signed-out" }
  | { status: "checking" }
  /** Nothing required is missing: the home screen may show what needs a finished account, and knows the person's pond (#54). */
  | { status: "complete"; pond: PondSummary | null }
  /** Sent to onboarding; the home screen shows nothing meanwhile. */
  | { status: "incomplete" }
  /** The status could not be read: the gate stays closed and offers a retry (#65 review). */
  | { status: "unknown" };

/**
 * The home screen's gate (#46): a signed-in account that has not finished
 * onboarding is sent to it, and until the status has been read and says
 * complete, the screen shows none of what needs a finished account. A
 * status that cannot be read keeps the gate closed rather than open. The
 * status is read again whenever the screen regains the focus: a consent
 * withdrawn in Settings reopens a step, and the way back to home is the
 * moment to ask it (09/10/2026, found on the simulator). What was known
 * stays on screen while the re-read is in flight.
 */
export function useOnboardingGate(): OnboardingGate & { retry: () => void } {
  const session = useSession();
  const router = useRouter();
  const signedIn = session.status === "signed-in";
  const [gate, setGate] = useState<OnboardingGate>({ status: "signed-out" });
  const [attempt, setAttempt] = useState(0);
  const read = useCallback(() => {
    if (!signedIn) {
      setGate({ status: "signed-out" });
      return;
    }
    let live = true;
    setGate((previous) => (previous.status === "complete" ? previous : { status: "checking" }));
    fetchOnboarding()
      .then((status) => {
        if (!live) return;
        if (status.state === "registered" || !status.complete) {
          setGate({ status: "incomplete" });
          router.replace("/onboarding");
        } else {
          setGate({ status: "complete", pond: status.pond });
        }
      })
      .catch(() => {
        if (live) setGate({ status: "unknown" });
      });
    return () => {
      live = false;
    };
  }, [signedIn, router, attempt]);
  useFocusEffect(read);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...gate, retry };
}
