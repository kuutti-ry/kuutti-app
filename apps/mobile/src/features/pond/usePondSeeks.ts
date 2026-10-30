import type { PondSeeks } from "@kuutti/schema";
import { useEffect, useState } from "react";
import { fetchPondSeeks } from "./client";

/**
 * The shares of the card's bar (#507). On its own beside `useWaitlist`, as its
 * route is (a `shortcut:` in the API, until #500's rename folds them together).
 * A read that fails leaves the bar out and the rest of the card as it is: the
 * figures have their own failure and their own retry, and the bar adds to them.
 */
export function usePondSeeks(pondId: string): PondSeeks | null {
  const [seeks, setSeeks] = useState<PondSeeks | null>(null);
  useEffect(() => {
    let live = true;
    setSeeks(null);
    fetchPondSeeks()
      .then((answer) => {
        if (live) setSeeks(answer);
      })
      .catch(() => {
        if (live) setSeeks(null);
      });
    return () => {
      live = false;
    };
  }, [pondId]);
  return seeks;
}
