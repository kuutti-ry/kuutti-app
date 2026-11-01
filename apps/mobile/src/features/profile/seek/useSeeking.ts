import type { AgeWindow, Gender, PreferencesUpdate, ProfileFields } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { fetchPreferences, fetchProfile, savePreferences } from "../client";

type Seeking = {
  seeks: Gender[];
  ageWindow: AgeWindow;
  intent: ProfileFields["intent"];
};

type SeekingState =
  | { status: "loading" }
  /** `error` is why the read failed, for the screen to say so (LoadFailed). */
  | { status: "error"; error: unknown }
  | { status: "ready"; seeking: Seeking };

/** What a person seeks; null while onboarding still has to ask for it, or for the consent it needs. */
async function readSeeking(): Promise<Seeking | null> {
  const [{ seeks, ageWindow }, { profile }] = await Promise.all([
    fetchPreferences(),
    fetchProfile(),
  ]);
  if (!seeks || !ageWindow || !profile?.specialCategoryConsent) return null;
  return { seeks, ageWindow, intent: profile.fields.intent };
}

/**
 * What the list of What you seek and its two screens read (#542). Nobody
 * without the answers or the consent sees a row for them: the consent is given
 * on the seeks step and taken back in Settings (ADR-019 §4), so a person who
 * lost it here, on another phone or to a new wording, goes to onboarding, which
 * asks. A read again keeps what is shown until the answer is there, and a
 * failed one takes nothing away, as the profile's does.
 */
export function useSeeking() {
  const router = useRouter();
  const [state, setState] = useState<SeekingState>({ status: "loading" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    try {
      const seeking = await readSeeking();
      if (!mounted.current) return;
      if (seeking) setState({ status: "ready", seeking });
      else router.replace("/onboarding");
    } catch (error) {
      setState((was) => (was.status === "ready" ? was : { status: "error", error }));
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, reload: load };
}

/** A refused change, held to bring its screen back with the reason. */
export type HeldChange<Draft> = { draft: Draft; code: string | undefined };

/**
 * Saves a change as its screen goes (`useSaveOnLeave`). Refused, the change is
 * held for its screen, unless the consent is what is gone: an answer with no
 * consent has nowhere to go, so nothing is held, and the list's read sends the
 * person to onboarding (ADR-010 §16).
 */
export const savedOrHeld = <Draft>(
  update: PreferencesUpdate,
  draft: Draft,
): Promise<HeldChange<Draft> | null> =>
  savePreferences(update).then(
    () => null,
    (error: unknown) => {
      const code = error instanceof ApiError ? error.code : undefined;
      return code === "consent_required" ? null : { draft, code };
    },
  );
