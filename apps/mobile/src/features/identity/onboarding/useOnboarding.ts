import type { OnboardingStatus } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { codeOf } from "@/lib/api";
import { fetchOnboarding } from "./client";

export type OnboardingState =
  | { status: "loading" }
  /** `error` is why the read failed, for the screen to say so (LoadFailed). */
  | { status: "error"; error: unknown }
  | { status: "ready"; onboarding: OnboardingStatus };

/**
 * The onboarding status, reloaded after every step and whenever the screen
 * gets the focus back (#46, #146): the API decides what is still missing, and
 * the screen only shows the next question. A step that fails leaves the status
 * as it was and says so.
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

  /** Reads the status, and hands back what it read: null if that failed. */
  const reload = useCallback(async (): Promise<OnboardingStatus | null> => {
    try {
      const onboarding = await fetchOnboarding();
      if (mounted.current) setState({ status: "ready", onboarding });
      return onboarding;
    } catch (error) {
      if (mounted.current) setState({ status: "error", error });
      return null;
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  /** Runs one step's call, then reads the status again, and hands back what it read. */
  const step = useCallback(
    async (call: () => Promise<unknown>): Promise<OnboardingStatus | null> => {
      setBusy(true);
      setFailedCode(null);
      try {
        await call();
        return await reload();
      } catch (error) {
        const code = codeOf(error) ?? "unknown";
        if (mounted.current) setFailedCode(code);
        // The consent is gone (taken back on another device, or a new wording):
        // the status says so, and the step's switch can be given again (ADR-010 §16).
        if (code === "consent_required") await reload();
        return null;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [reload],
  );

  return { state, busy, failed: failedCode !== null, failedCode, reload, step };
}
