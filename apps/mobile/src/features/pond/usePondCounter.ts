import type { PondCounterPond } from "@kuutti/schema";
import { useCallback, useEffect, useState } from "react";
import { fetchPondCounter } from "./client";

export type PondCounterState =
  | { status: "loading" }
  /** What the counter says; `figures` is null when it lists no pond. */
  | { status: "ready"; k: number; figures: PondCounterPond | null }
  /** `error` says why, for the card to say so (LoadFailed). */
  | { status: "failed"; error: unknown };

/** What the counter says of the one pond there is (#54, ADR-061 §8), its bar included (#507). */
export function usePondCounter(): PondCounterState & { retry: () => void } {
  const [state, setState] = useState<PondCounterState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetchPondCounter()
      .then((counter) => {
        if (live) setState({ status: "ready", k: counter.k, figures: counter.ponds[0] ?? null });
      })
      .catch((error: unknown) => {
        if (live) setState({ status: "failed", error });
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
