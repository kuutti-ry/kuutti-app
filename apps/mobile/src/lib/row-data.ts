import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

/**
 * What a row of Settings says of the setting it holds (#511): read whenever
 * the list comes to the front, while `enabled`, and replaced by whatever the
 * row's own panel last read or stored, so that the row and the panel under it
 * always agree. Undefined until a read has answered, and after one that
 * failed: the row then says nothing, and its panel says why. `read` is the
 * same function on every render (a module's), or every render reads again.
 */
export function useRowData<T>(
  read: () => Promise<T>,
  enabled: boolean,
): { data: T | undefined; stored: (data: T) => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      let live = true;
      read().then(
        (answer) => live && setData(answer),
        () => undefined,
      );
      return () => {
        live = false;
      };
    }, [read, enabled]),
  );
  const stored = useCallback((answer: T) => setData(answer), []);
  return { data, stored };
}
