import type { ConversationList, ConversationSummary } from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchConversations } from "./client";

export type ConversationsView =
  | { status: "loading" }
  | { status: "ready"; list: ConversationList }
  | { status: "failed"; error: unknown };

/**
 * A quiet read signs no thumb: each one carries the thumb of the read before,
 * where the conversation is the same and still not closed. The phone holds
 * the picture under its photo id already (rules/mobile.md), and a look back
 * at the list spends no fetch of the day's budget (ADR-008).
 */
function withEarlierThumbs(earlier: ConversationList, list: ConversationList): ConversationList {
  const thumbs = new Map(
    [...earlier.open, ...earlier.archived].flatMap((c) =>
      c.counterpart.deleted || !c.counterpart.thumb ? [] : [[c.id, c.counterpart.thumb] as const],
    ),
  );
  const carry = (c: ConversationSummary): ConversationSummary =>
    c.counterpart.deleted || c.state === "closed"
      ? c
      : { ...c, counterpart: { ...c.counterpart, thumb: thumbs.get(c.id) ?? null } };
  return { open: list.open.map(carry), archived: list.archived.map(carry) };
}

/**
 * The person's conversations (#348), read when the screen comes to the front
 * and when the app comes back to the foreground, as the gate is (useGate).
 * What is shown stays until the new answer is there, and a read that fails
 * takes nothing away that was known. `thumbs: false` is the home screen's
 * count: nothing signed, nothing spent.
 */
export function useConversations(thumbs = true): ConversationsView & {
  refresh: () => Promise<void>;
  retry: () => void;
} {
  const [state, setState] = useState<ConversationsView>({ status: "loading" });
  const asked = useRef(0);
  const mounted = useRef(true);

  const shown = useRef<ConversationList | null>(null);

  const read = useCallback(
    async (quietly: boolean, sign = false) => {
      asked.current += 1;
      const mine = asked.current;
      const current = () => mounted.current && mine === asked.current;
      if (!quietly) setState({ status: "loading" });
      // Thumbs on the first read, a retry and a pull; a look back carries them.
      const earlier = shown.current;
      const signing = thumbs && (sign || !quietly || earlier === null);
      try {
        const answer = await fetchConversations(signing);
        const list = signing || earlier === null ? answer : withEarlierThumbs(earlier, answer);
        if (current()) {
          shown.current = list;
          setState({ status: "ready", list });
        }
      } catch (error) {
        if (current()) {
          setState((was) =>
            quietly && was.status === "ready" ? was : { status: "failed", error },
          );
        }
      }
    },
    [thumbs],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void read(true);
    }, [read]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void read(true);
    });
    return () => subscription.remove();
  }, [read]);

  const refresh = useCallback(() => read(true, true), [read]);
  const retry = useCallback(() => void read(false), [read]);
  return { ...state, refresh, retry };
}

/** The counterpart's messages not yet read, across every conversation. */
export const unreadOf = (list: ConversationList): number =>
  [...list.open, ...list.archived].reduce((sum, c) => sum + c.unread, 0);
