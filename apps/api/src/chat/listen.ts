import type { Pool, PoolClient } from "@kuutti/db";
import type { Logger } from "../lib/logger.ts";
import { CHAT_CHANNEL, type Live } from "./live.ts";

/**
 * The listener (#349, ADR-031 §5): one connection of the pool held for
 * LISTEN on the chat's channel, its notifications handed to the hub. When the
 * connection is lost, notifications in the gap are lost with it, so every
 * socket is closed with `restarting`: the phones reconnect and resume from
 * Postgres, which lost nothing. The connection comes back with a backoff
 * from one second to thirty.
 */
export function startChatListener(deps: { pool: Pool; logger: Logger; live: Live }): {
  /** Resolves once the first LISTEN is in place. */
  ready: Promise<void>;
  stop: () => Promise<void>;
} {
  let client: PoolClient | null = null;
  let stopped = false;
  let delay = 1_000;
  let listening = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  // One notification at a time, in the order Postgres delivers them, which
  // is the order of the commits: a phone gets its frames in that order too.
  let queue = Promise.resolve();

  const lose = (from: PoolClient, err?: unknown) => {
    if (client !== from) return;
    client = null;
    from.release(true);
    deps.logger.warn({ err }, "chat listener lost");
    deps.live.listening = false;
    deps.live.closeAll(1012, "restarting");
    if (!stopped) {
      deps.live.schedule(delay, () => void connect());
      delay = Math.min(delay * 2, 30_000);
    }
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    let next: PoolClient;
    try {
      next = await deps.pool.connect();
    } catch (err) {
      deps.logger.warn({ err }, "chat listener could not connect");
      deps.live.schedule(delay, () => void connect());
      delay = Math.min(delay * 2, 30_000);
      return;
    }
    // Stopped while the connection was on its way: given back, or the pool
    // would wait for it at shutdown.
    if (stopped) {
      next.release(true);
      return;
    }
    client = next;
    next.on("notification", (note) => {
      const payload = note.payload;
      if (note.channel !== CHAT_CHANNEL || !payload) return;
      queue = queue
        .then(() => deps.live.hub.deliver(payload))
        .catch((err: unknown) => {
          deps.logger.error({ err }, "chat notification failed");
        });
    });
    next.on("error", (err) => lose(next, err));
    next.on("end", () => lose(next));
    try {
      await next.query(`LISTEN ${CHAT_CHANNEL}`);
      delay = 1_000;
      deps.live.listening = true;
      deps.logger.info({ channel: CHAT_CHANNEL }, "chat listener on");
      listening();
    } catch (err) {
      lose(next, err);
    }
  }

  void connect();
  return {
    ready,
    async stop() {
      stopped = true;
      deps.live.listening = false;
      const held = client;
      client = null;
      if (held) {
        await held.query(`UNLISTEN ${CHAT_CHANNEL}`).catch(() => undefined);
        held.release(true);
      }
    },
  };
}
