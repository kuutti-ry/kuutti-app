import {
  type ConversationList,
  type ConversationSummary,
  MESSAGE_PREVIEW_LENGTH,
} from "@kuutti/schema";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchConversations } from "./client";
import { type ConversationLive, useChatLive } from "./store";

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
 * The list as the socket moved it since the last read (#349): a newer message
 * becomes the row's last line and goes to the top, one of theirs counts as
 * unread, and a message brings an archived conversation back (TD-13). So a
 * message costs no read of the list; a state other than the row's does.
 */
export function withLive(
  list: ConversationList,
  live: Readonly<Record<string, ConversationLive>>,
): ConversationList {
  const moved: ConversationSummary[] = [];
  const rest: ConversationSummary[] = [];
  for (const c of [...list.open, ...list.archived]) {
    const newer = (live[c.id]?.messages ?? []).filter((m) => m.seq > (c.lastMessage?.seq ?? 0));
    const last = newer.at(-1);
    if (!last || c.state === "closed") {
      rest.push(c);
      continue;
    }
    moved.push({
      ...c,
      state: "open",
      lastMessage: {
        seq: last.seq,
        at: last.createdAt,
        kind: last.kind,
        // A photo's caption, or "" without one, as the API's preview (#350): the row says Photo.
        preview: [...(last.body ?? "")].slice(0, MESSAGE_PREVIEW_LENGTH).join(""),
        side: last.side,
      },
      unread: c.unread + newer.filter((m) => m.side === "theirs").length,
    });
  }
  moved.sort((a, b) => (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? ""));
  const all = [...moved, ...rest];
  return {
    open: all.filter((c) => c.state === "open"),
    archived: all.filter((c) => c.state !== "open"),
  };
}

/**
 * The person's conversations (#348), read when the screen comes to the front
 * and when the app comes back to the foreground, as the gate is (useGate).
 * What is shown stays until the new answer is there, and a read that fails
 * takes nothing away that was known. `thumbs: false` is the home screen's
 * count: nothing signed, nothing spent. The socket's messages are applied as
 * they come (`withLive`); a state other than the row's, or a conversation the
 * list does not hold, reads it again quietly, once for each such word
 * (#349). Each conversation's newest sequence goes to the socket's next
 * resume.
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

  const { report, conversations } = useChatLive();

  // What the socket says that the list does not show: a conversation it does
  // not hold (a match since the last read), or a state other than the row's.
  // A resume ends every conversation it names with its state, so comparing,
  // rather than counting frames, reads the list again only when something
  // changed; and once for each such word, so a disagreement cannot loop.
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    if (state.status !== "ready") return;
    const rows = new Map([...state.list.open, ...state.list.archived].map((c) => [c.id, c]));
    const words = Object.entries(conversations).flatMap(([id, c]) => {
      const row = rows.get(id);
      if (!row) {
        const there = c.messages.length > 0 || (c.state !== null && c.state.state !== "gone");
        return there ? [`${id} new`] : [];
      }
      if (!c.state || (c.state.state === row.state && c.state.closedHow === row.closedHow)) {
        return [];
      }
      return [`${id} ${c.state.state} ${c.state.closedHow}`];
    });
    const fresh = words.filter((word) => !askedFor.current.has(word));
    if (fresh.length === 0) return;
    for (const word of fresh) askedFor.current.add(word);
    void read(true);
  }, [conversations, state, read]);

  const shownState = useMemo<ConversationsView>(
    () =>
      state.status === "ready"
        ? { status: "ready", list: withLive(state.list, conversations) }
        : state,
    [state, conversations],
  );

  useEffect(() => {
    if (state.status !== "ready") return;
    const { open, archived } = state.list;
    report(Object.fromEntries([...open, ...archived].map((c) => [c.id, c.lastMessage?.seq ?? 0])));
  }, [state, report]);

  const refresh = useCallback(() => read(true, true), [read]);
  const retry = useCallback(() => void read(false), [read]);
  return { ...shownState, refresh, retry };
}

/** The counterpart's messages not yet read, across every conversation. */
export const unreadOf = (list: ConversationList): number =>
  [...list.open, ...list.archived].reduce((sum, c) => sum + c.unread, 0);
