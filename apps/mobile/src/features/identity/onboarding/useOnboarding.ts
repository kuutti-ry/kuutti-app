import type { OnboardingStatus } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fetchOnboarding } from "./client";

export type OnboardingState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; onboarding: OnboardingStatus };

/**
 * The onboarding status, reloaded after every step and whenever the screen
 * gets the focus back (#46, #146): the API decides what is still missing, the
 * screen only shows the next question, and the photos are added on their own
 * screen. A step that fails leaves the status as it was and says so.
 */
export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  /** The code of the API's refusal of the last step, "unknown" for anything else; null while nothing failed. */
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const onboarding = await fetchOnboarding();
      if (mounted.current) setState({ status: "ready", onboarding });
    } catch {
      if (mounted.current) setState({ status: "error" });
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  /** Runs one step's call, then reads the status again. */
  const step = useCallback(
    async (call: () => Promise<unknown>) => {
      setBusy(true);
      setFailedCode(null);
      try {
        await call();
        await reload();
      } catch (error) {
        if (mounted.current) {
          setFailedCode(error instanceof ApiError ? (error.code ?? "unknown") : "unknown");
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [reload],
  );

  return { state, busy, failed: failedCode !== null, failedCode, reload, step };
}
