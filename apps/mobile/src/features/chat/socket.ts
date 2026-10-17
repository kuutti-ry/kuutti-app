import {
  type ClientFrame,
  CONVERSATIONS_MAX,
  type FrameErrorCode,
  ServerFrame,
} from "@kuutti/schema";
import { apiBaseUrl } from "@/lib/api-url";
import {
  accessTokenIsStale,
  currentSession,
  refreshSession,
  type StoredSession,
} from "@/lib/session";

// The chat's socket (#349, ADR-031 §5): one connection at a time, which says
// what changed; writing stays on the HTTP routes. The access token goes in
// the first frame, never in the URL.

export type SocketStatus = "connecting" | "open" | "lost";

/** What the socket hands on: the frames that change what is shown, and the connection's state. */
export type SocketHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: SocketStatus) => void;
  /** The newest sequence the phone holds per conversation, named in the resume after every ready. */
  cursors: () => Array<{ id: string; seq: number }>;
  /** A number in [0, 1) for the backoff's spread; tests hand in a fixed one. */
  random?: () => number;
};

const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The socket's session is refreshed this long before its access token expires: the API checks it on every ping. */
const REFRESH_LEAD_MS = 60_000;
/** A longer setTimeout fires at once; the wait is checked again when it ends. */
const TIMER_MAX_MS = 2 ** 31 - 1;
/** Failed attempts in a row, never open between them, before the connection counts as lost. */
const LOST_AFTER_FAILURES = 2;
/** The API's answer to a token it no longer takes: refresh once, then try again. */
const AUTH_ERRORS: ReadonlySet<FrameErrorCode> = new Set([
  "unauthenticated",
  "session_expired",
  "session_revoked",
]);

const socketUrl = () => `${apiBaseUrl().replace(/^http/, "ws")}/ws`;

/** A frame from the API, or null for anything outside the contract; its content is never logged. */
function parsed(data: unknown): ServerFrame | null {
  try {
    const frame = ServerFrame.safeParse(JSON.parse(String(data)));
    return frame.success ? frame.data : null;
  } catch {
    return null;
  }
}

/**
 * Connects and stays connected until the returned function is called:
 * reconnects after every close, waiting about 1 s and doubling to 30 s
 * until a `ready`, except after `too_many_sockets`; refreshes the session once after the API refused its token, and
 * stops when there is no session left; refreshes ahead of expiry while open,
 * through the app's one single-flight refresh, so the API never sees a second
 * independent one (ADR-027).
 */
export function connect(handlers: SocketHandlers): () => void {
  const random = handlers.random ?? Math.random;
  let stopped = false;
  // Pushed out by the person's own sixth app: this one waits until the app is
  // next brought to the front, or six of them would take turns pushing each
  // other out every second.
  let parked = false;
  let socket: WebSocket | null = null;
  let live = false;
  let backoff = BACKOFF_FIRST_MS;
  let failures = 0;
  let refreshFirst = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let refresher: ReturnType<typeof setTimeout> | undefined;

  const send = (ws: WebSocket, frame: ClientFrame) => ws.send(JSON.stringify(frame));

  const later = (wasOpen: boolean) => {
    if (stopped) return;
    failures += 1;
    if (wasOpen || failures >= LOST_AFTER_FAILURES) handlers.onStatus("lost");
    // Spread over the second half of the wait, so the phones a restart closed
    // do not all come back in the same instant.
    retry = setTimeout(() => void attempt(), Math.round(backoff * (0.5 + random() / 2)));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  // Ahead of expiry while open; a refresh that did not move the expiry (the
  // API unwell, or offline) leaves it to the API's session_expired and the
  // reconnect's own refresh.
  const keepFresh = () => {
    const session = currentSession();
    if (stopped || !live || !session) return;
    const wait = new Date(session.accessExpiresAt).getTime() - REFRESH_LEAD_MS - Date.now();
    if (wait > 0) {
      refresher = setTimeout(keepFresh, Math.min(wait, TIMER_MAX_MS));
      return;
    }
    refreshSession().then(
      (next) => {
        if (next && next.accessExpiresAt !== session.accessExpiresAt) keepFresh();
      },
      () => undefined,
    );
  };

  const attempt = async () => {
    let session: StoredSession | null;
    let ws: WebSocket;
    try {
      session = currentSession();
      if (session && (refreshFirst || accessTokenIsStale(session))) {
        session = await refreshSession();
      }
      refreshFirst = false;
      if (stopped || !session) return;
      ws = new globalThis.WebSocket(socketUrl());
    } catch {
      later(false);
      return;
    }
    const token = session.accessToken;
    socket = ws;
    // React Native's send throws while the socket is still connecting.
    ws.onopen = () => send(ws, { type: "auth", token });
    ws.onmessage = (event) => {
      const frame = socket === ws ? parsed(event.data) : null;
      if (!frame) return;
      if (frame.type === "ready") {
        live = true;
        backoff = BACKOFF_FIRST_MS;
        failures = 0;
        handlers.onStatus("open");
        const conversations = handlers.cursors().slice(0, CONVERSATIONS_MAX * 2);
        send(ws, { type: "resume", conversations });
        keepFresh();
      } else if (frame.type === "ping") {
        send(ws, { type: "pong" });
      } else if (frame.type === "error") {
        if (AUTH_ERRORS.has(frame.code)) refreshFirst = true;
        if (frame.code === "too_many_sockets") parked = true;
      } else {
        handlers.onFrame(frame);
      }
    };
    // A failure fires error and then close: close is the one place that reconnects.
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      const wasOpen = live;
      live = false;
      clearTimeout(refresher);
      if (parked) {
        handlers.onStatus("lost");
        return;
      }
      later(wasOpen);
    };
  };

  void attempt();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(refresher);
    const ws = socket;
    socket = null;
    ws?.close();
  };
}
