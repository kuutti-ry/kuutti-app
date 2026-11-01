import type { PondCounterPond } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { fetchPondCounter } from "./client";

export type PondCounterState =
  | { status: "loading" }
  /** What the counter says of the pond; `figures` is null when the list does not name the pond. */
  | { status: "ready"; k: number; figures: PondCounterPond | null }
  /** `error` says why, for the card to say so (LoadFailed). */
  | { status: "failed"; error: unknown };

/** What the counter says of one pond (#54), the person's own, its bar included (#507). */
export function usePondCounter(pondId: string): PondCounterState & { retry: () => void } {
  const [state, setState] = useState<PondCounterState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetchPondCounter()
      .then((counter) => {
        if (!live) return;
        const figures = counter.ponds.find((entry) => entry.pond.id === pondId) ?? null;
        setState({ status: "ready", k: counter.k, figures });
      })
      .catch((error: unknown) => {
        if (live) setState({ status: "failed", error });
      });
    return () => {
      live = false;
    };
  }, [pondId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
