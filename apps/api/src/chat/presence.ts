import type { FrameErrorCode, ServerFrame } from "@kuutti/schema";

/**
 * The open sockets of the process, by account (#349, ADR-031 §5): in memory,
 * never a table (#101), so a restart costs this map and nothing else, and the
 * reconnects rebuild it. #102 asks it whether somebody has a live socket.
 */

/** One authenticated socket, as the registry and the fan-out see it. */
export type LiveSocket = {
  accountId: string;
  sessionId: string;
  /** A shadow-banned account is never shown online (ADR-024 §6). */
  hidden: boolean;
  send(frame: ServerFrame): void;
  /** Says why in an `error` frame, then closes with the code. */
  close(code: number, error: FrameErrorCode): void;
};

export type Presence = ReturnType<typeof createPresence>;

export function createPresence(socketsPerAccount: number) {
  // A Set keeps insertion order: the first of an account's is its oldest.
  const byAccount = new Map<string, Set<LiveSocket>>();
  return {
    /**
     * Registers a socket. `first`: the account had none. `evicted`: the oldest
     * of its sockets past the limit, for the caller to close; the new one is
     * registered first, so the account never reads as offline meanwhile.
     */
    add(socket: LiveSocket): { first: boolean; evicted: LiveSocket[] } {
      const sockets = byAccount.get(socket.accountId) ?? new Set<LiveSocket>();
      const first = sockets.size === 0;
      sockets.add(socket);
      byAccount.set(socket.accountId, sockets);
      const evicted = [...sockets].slice(0, Math.max(0, sockets.size - socketsPerAccount));
      return { first, evicted };
    },
    /** Unregisters a socket. `last`: the account has none left. */
    remove(socket: LiveSocket): { last: boolean } {
      const sockets = byAccount.get(socket.accountId);
      if (!sockets?.delete(socket)) return { last: false };
      if (sockets.size > 0) return { last: false };
      byAccount.delete(socket.accountId);
      return { last: true };
    },
    socketsOf(accountId: string): LiveSocket[] {
      return [...(byAccount.get(accountId) ?? [])];
    },
    /** Shown online to others: an open socket, and not shadow-banned. */
    online(accountId: string): boolean {
      return this.socketsOf(accountId).some((socket) => !socket.hidden);
    },
    all(): LiveSocket[] {
      return [...byAccount.values()].flatMap((sockets) => [...sockets]);
    },
  };
}
