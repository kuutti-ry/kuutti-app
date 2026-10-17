import type {
  ChatMessage,
  ConversationClosedHow,
  ConversationState,
  ServerFrame,
} from "@kuutti/schema";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useSession } from "@/features/identity";
import { connect, type SocketStatus } from "./socket";

/** What the socket said about one conversation since it was last cleared (#349). */
export type ConversationLive = {
  /** Messages that arrived, oldest first, each sequence once. */
  messages: ChatMessage[];
  /** How far the counterpart has read. */
  readUpTo: number;
  online: boolean;
  /** How it stands, from the newest `conversation` frame; null until one came. */
  state: { state: ConversationState | "gone"; closedHow: ConversationClosedHow | null } | null;
  /** The newest sequence the phone knows: what the next resume names. */
  cursor: number;
};

export type ChatLive = {
  status: SocketStatus;
  /** Moves on every conversation frame: the list reads again when it does; a message it applies itself. */
  changes: number;
  conversations: Record<string, ConversationLive>;
};

type ChatLiveAction =
  | { type: "frame"; frame: ServerFrame }
  | { type: "status"; status: SocketStatus }
  /** The screens and the list say what they hold: the newest sequence per conversation. */
  | { type: "cursors"; cursors: Record<string, number> }
  | { type: "clear" };

export const EMPTY: ChatLive = { status: "connecting", changes: 0, conversations: {} };

const BLANK: ConversationLive = {
  messages: [],
  readUpTo: 0,
  online: false,
  state: null,
  cursor: 0,
};

/** Oldest first, each sequence once, the later one winning. */
export const merged = (a: ChatMessage[], b: ChatMessage[]): ChatMessage[] =>
  [...new Map([...a, ...b].map((m) => [m.seq, m])).values()].sort((x, y) => x.seq - y.seq);

function changed(
  live: ChatLive,
  id: string,
  change: (conversation: ConversationLive) => Partial<ConversationLive>,
  changes = live.changes,
): ChatLive {
  const conversation = live.conversations[id] ?? BLANK;
  return {
    ...live,
    changes,
    conversations: { ...live.conversations, [id]: { ...conversation, ...change(conversation) } },
  };
}

/** What a frame, a status, a cursor or a sign-out does to what the store holds. */
export function reduce(live: ChatLive, action: ChatLiveAction): ChatLive {
  switch (action.type) {
    case "clear":
      return EMPTY;
    case "status":
      return action.status === live.status ? live : { ...live, status: action.status };
    case "cursors":
      return Object.entries(action.cursors).reduce(
        (next, [id, seq]) =>
          seq > (next.conversations[id]?.cursor ?? -1)
            ? changed(next, id, () => ({ cursor: seq }))
            : next,
        live,
      );
  }
  const { frame } = action;
  switch (frame.type) {
    case "message":
      return changed(live, frame.conversationId, (c) => ({
        messages: merged(c.messages, [frame.message]),
        cursor: Math.max(c.cursor, frame.message.seq),
      }));
    case "read":
      return changed(live, frame.conversationId, (c) => ({
        readUpTo: Math.max(c.readUpTo, frame.upTo),
      }));
    case "presence":
      return changed(live, frame.conversationId, () => ({ online: frame.online }));
    case "conversation":
      return changed(
        live,
        frame.conversationId,
        () => ({ state: { state: frame.state, closedHow: frame.closedHow } }),
        live.changes + 1,
      );
    default:
      // ready, ping and error are the socket's own.
      return live;
  }
}

type ChatLiveValue = ChatLive & { report: (cursors: Record<string, number>) => void };

// Without the provider (a screen's own test) nothing is live: the screens read over HTTP alone.
const ChatLiveContext = createContext<ChatLiveValue>({ ...EMPTY, report: () => undefined });

/**
 * The chat's socket for the whole app (#349): open while signed in and not in
 * the background (iOS passes through "inactive" for the control centre and
 * the app switcher; closing there would flap), and everything it said cleared
 * when the session ends or changes, since someone else may sign in on the
 * same phone.
 */
export function ChatLiveProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const sessionId = session.status === "signed-in" ? session.sessionId : null;
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [live, dispatch] = useReducer(reduce, EMPTY);
  const known = useRef(live.conversations);
  known.current = live.conversations;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next !== "background"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => () => dispatch({ type: "clear" }), [sessionId]);

  useEffect(() => {
    if (!sessionId || !foreground) return;
    dispatch({ type: "status", status: "connecting" });
    return connect({
      onFrame: (frame) => dispatch({ type: "frame", frame }),
      onStatus: (status) => dispatch({ type: "status", status }),
      cursors: () => Object.entries(known.current).map(([id, c]) => ({ id, seq: c.cursor })),
    });
  }, [sessionId, foreground]);

  const report = useCallback(
    (cursors: Record<string, number>) => dispatch({ type: "cursors", cursors }),
    [],
  );
  const value = useMemo(() => ({ ...live, report }), [live, report]);
  return <ChatLiveContext.Provider value={value}>{children}</ChatLiveContext.Provider>;
}

/** What the socket said, and where the screens report what they hold. Inert without the provider. */
export const useChatLive = (): ChatLiveValue => useContext(ChatLiveContext);
