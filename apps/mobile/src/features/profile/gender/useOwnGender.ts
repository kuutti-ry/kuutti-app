import type { Gender } from "@kuutti/schema";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { fetchOwnGender } from "../client";

type OwnGenderState =
  | { status: "loading" }
  /** `error` is why the read failed, for the screen to say so (LoadFailed). */
  | { status: "error"; error: unknown }
  | { status: "ready"; gender: Gender; nextChange: string | null };

/**
 * What the gender screen reads (#552). A person with no gender yet has nothing
 * to change: back to Home, whose gate sends them to onboarding, which asks.
 */
export function useOwnGender() {
  const router = useRouter();
  const [state, setState] = useState<OwnGenderState>({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const { gender, nextChange } = await fetchOwnGender();
      if (gender) setState({ status: "ready", gender, nextChange });
      else router.dismissTo("/");
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, reload: load };
}
