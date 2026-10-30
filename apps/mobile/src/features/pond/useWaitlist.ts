import type { WaitlistPond } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { fetchWaitlist } from "./client";

export type WaitlistState =
  | { status: "loading" }
  /** What the counter says of the pond; `figures` is null when the list does not name the pond. */
  | { status: "ready"; k: number; figures: WaitlistPond | null }
  /** `error` says why, for the card to say so (LoadFailed). */
  | { status: "failed"; error: unknown };

/** What the public counter says of one pond (#54). */
export function useWaitlist(
  pondId: string,
): WaitlistState & { attempt: number; retry: () => void } {
  const [state, setState] = useState<WaitlistState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetchWaitlist()
      .then((waitlist) => {
        if (!live) return;
        const figures = waitlist.ponds.find((entry) => entry.pond.id === pondId) ?? null;
        setState({ status: "ready", k: waitlist.k, figures });
      })
      .catch((error: unknown) => {
        if (live) setState({ status: "failed", error });
      });
    return () => {
      live = false;
    };
  }, [pondId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, attempt, retry };
}
