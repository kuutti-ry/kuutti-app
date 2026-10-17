import { upgradeWebSocket } from "@hono/node-server";
import type { Queryable } from "@kuutti/db";
import {
  ClientFrame,
  FRAME_BYTES_MAX,
  type FrameErrorCode,
  type ServerFrame,
} from "@kuutti/schema";
import { Hono, type MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { WebSocketServer } from "ws";
import { authenticate, type SessionStore } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import type { Logger } from "../lib/logger.ts";
import type { Live } from "./live.ts";
import type { LiveSocket } from "./presence.ts";

// The chat's socket (#349, ADR-031 §5): GET /ws, one per signed-in app in
// front. It authenticates by its first frame, `auth { token }`, so the token
// never sits in a URL and the web preview, which cannot set headers on a
// WebSocket, runs the same code. Every frame both ways is the contract's
// (packages/schema/src/chat-frames.ts); one that is not closes the socket.
// The socket only tells: writing stays on the HTTP routes. What a frame says
// reaches no log line (rule 5): a line names the account, the request and a
// code, never a frame or a token.

export type SocketDeps = {
  db: Queryable;
  logger: Logger;
  store: Pick<SessionStore, "findByAccessHash" | "touch" | "standing">;
  live: Live;
  now: () => Date;
  allowedOrigins: ReadonlySet<string>;
  timing: { authMs: number; pingMs: number; pongMs: number };
};

const POLICY = 1008;
const GOING_AWAY = 1001;
const RESTARTING = 1012;

/** The 401s of the session guard, as the socket's error codes say them. */
const AUTH_CODES: Record<string, FrameErrorCode> = {
  unauthenticated: "unauthenticated",
  session_revoked: "session_revoked",
  session_expired: "session_expired",
};

/**
 * A browser's socket comes only from an origin the API admits (rule 8): the
 * API's own host (React Native names its own URL's origin) or one on the CORS
 * allowlist (the admin panel, a preview's web origin). No Origin at all is a
 * native client or a test, admitted.
 */
function originCheck(allowed: ReadonlySet<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin === undefined) return next();
    let host: string | null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (allowed.has(origin) || (host !== null && host === c.req.header("host"))) return next();
    return c.body(null, 403);
  };
}

/**
 * The server the sockets are upgraded on, handed to `serve` (index.ts): a
 * frame is bounded before it is read, and the upgrade itself goes through the
 * app's routes.
 */
export function createSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES_MAX });
}

export function chatSocketRoutes(deps: SocketDeps) {
  const app = new Hono<AppEnv>();
  app.get(
    "/ws",
    originCheck(deps.allowedOrigins),
    upgradeWebSocket((c) => socketEvents(deps, c.get("requestId")), {
      onError: (err) => deps.logger.error({ err }, "chat socket failed"),
    }),
    // A plain GET: this path speaks WebSocket only.
    (c) => {
      c.header("Upgrade", "websocket");
      return c.body(null, 426);
    },
  );
  return app;
}

/**
 * One connection's life. Built for every GET /ws, the plain ones too, so
 * nothing happens here until the socket opens. Exported for ws.test.ts,
 * which interleaves its awaits with frames and a close.
 */
export function socketEvents(deps: SocketDeps, requestId: string): WSEvents {
  const { logger, live, timing } = deps;
  let ws: WSContext | null = null;
  let phase: "waiting" | "authenticating" | "ready" | "resumed" | "closed" = "waiting";
  let socket: LiveSocket | null = null;
  let cancelAuth = () => {};
  let cancelPing = () => {};
  let cancelPong = () => {};
  let closing = false;
  // Refused or closed: a frame still arriving is not read, and an await
  // that returns finds nothing to do (ws reads frames until the close's
  // answer, and a phone may vanish while its token is being looked up).
  const gone = () => closing || phase === "closed";

  const send = (frame: ServerFrame) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  };
  /** Says why, then closes; the reason is the code, never more. */
  const refuse = (code: number, error: FrameErrorCode) => {
    if (closing || phase === "closed" || !ws) return;
    closing = true;
    send({ type: "error", code: error });
    logger.info({ requestId, accountId: socket?.accountId, refusal: error }, "chat socket closed");
    ws.close(code, error);
  };

  const ping = () => {
    cancelPing = live.schedule(timing.pingMs, () => {
      void tick().catch((err: unknown) => {
        logger.error({ err, requestId }, "chat socket ping failed");
        // Asked again at the next ping, never dropped: the expiry and the
        // pong's deadline depend on it.
        if (!gone()) {
          cancelPing();
          ping();
        }
      });
    });
  };
  async function tick(): Promise<void> {
    if (!socket || gone()) return;
    const { standing, shadowBanned } = await deps.store.standing(deps.db, socket, deps.now());
    if (gone()) return;
    if (standing !== "live") {
      refuse(POLICY, standing === "expired" ? "session_expired" : "session_revoked");
      return;
    }
    send({ type: "ping" });
    cancelPong = live.schedule(timing.pongMs, () => refuse(GOING_AWAY, "pong_timeout"));
    ping();
    // A shadow ban put on or lifted since: the account hides or shows itself.
    if (shadowBanned !== socket.hidden) {
      const { changed } = live.presence.setHidden(socket.accountId, shadowBanned);
      if (changed) await live.hub.announcePresence(socket.accountId);
    }
  }

  async function onFrame(data: unknown): Promise<void> {
    if (gone()) return;
    let frame: ClientFrame | null = null;
    if (typeof data === "string") {
      try {
        const parsed = ClientFrame.safeParse(JSON.parse(data));
        frame = parsed.success ? parsed.data : null;
      } catch {
        frame = null;
      }
    }
    if (!frame) return refuse(POLICY, "bad_frame");
    switch (frame.type) {
      case "auth":
        // Set before the first await: a second auth is refused unread.
        if (phase !== "waiting") return refuse(POLICY, "bad_frame");
        phase = "authenticating";
        return onAuth(frame.token);
      case "resume":
        if (phase !== "ready" || !socket) return refuse(POLICY, "bad_frame");
        phase = "resumed";
        return live.hub.resume(socket, frame.conversations);
      case "pong":
        if (!socket) return refuse(POLICY, "bad_frame");
        cancelPong();
        return;
    }
  }

  async function onAuth(token: string): Promise<void> {
    cancelAuth();
    if (!live.listening) return refuse(RESTARTING, "restarting");
    const at = deps.now();
    let found: Awaited<ReturnType<typeof authenticate>>;
    try {
      found = await authenticate(deps, token, at);
    } catch (err) {
      if (err instanceof AppError && AUTH_CODES[err.code]) {
        return refuse(POLICY, AUTH_CODES[err.code] as FrameErrorCode);
      }
      throw err;
    }
    if (gone()) return;
    await deps.store.touch(deps.db, found.sessionId, at);
    // Checked again where nothing awaits before the registration: the
    // listener lost meanwhile has already closed every socket it knew.
    if (gone()) return;
    if (!live.listening) return refuse(RESTARTING, "restarting");
    phase = "ready";
    socket = {
      accountId: found.accountId,
      sessionId: found.sessionId,
      hidden: found.accountState === "shadow_banned",
      send,
      close: (code, error) => refuse(code, error),
    };
    const { shown, evicted } = live.presence.add(socket);
    for (const old of evicted) old.close(POLICY, "too_many_sockets");
    // A session ended between the token's check and the registration missed
    // the trigger's close: asked once more, now that an end would find it.
    const { standing } = await deps.store.standing(deps.db, socket, deps.now());
    // Closed meanwhile: onGone has taken it out again, or will.
    if (gone()) return;
    if (standing !== "live") {
      return refuse(POLICY, standing === "expired" ? "session_expired" : "session_revoked");
    }
    logger.info({ requestId, accountId: found.accountId }, "chat socket opened");
    send({ type: "ready" });
    ping();
    if (shown) await live.hub.announcePresence(found.accountId);
  }

  async function onGone(): Promise<void> {
    phase = "closed";
    cancelAuth();
    cancelPing();
    cancelPong();
    if (!socket) return;
    const { changed } = live.presence.remove(socket);
    if (changed) await live.hub.announcePresence(socket.accountId);
  }

  return {
    onOpen(_event, context) {
      ws = context;
      cancelAuth = live.schedule(timing.authMs, () => refuse(POLICY, "auth_timeout"));
    },
    onMessage(event) {
      onFrame(event.data).catch((err: unknown) => {
        logger.error({ err, requestId }, "chat socket frame failed");
        refuse(1011, "internal_error");
      });
    },
    onClose() {
      onGone().catch((err: unknown) => {
        logger.error({ err, requestId }, "chat socket close failed");
      });
    },
  };
}
