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
  /** Shadow-banned: never shown online (ADR-024 §6). Read at the auth, again at every ping. */
  hidden: boolean;
  send(frame: ServerFrame): void;
  /** Says why in an `error` frame, then closes with the code. */
  close(code: number, error: FrameErrorCode): void;
};

export type Presence = ReturnType<typeof createPresence>;

export function createPresence(socketsPerAccount: number) {
  // A Set keeps insertion order: the first of an account's is its oldest.
  const byAccount = new Map<string, Set<LiveSocket>>();
  const socketsOf = (accountId: string): LiveSocket[] => [...(byAccount.get(accountId) ?? [])];
  /** Shown online to others: an open socket, and not shadow-banned. */
  const online = (accountId: string): boolean =>
    socketsOf(accountId).some((socket) => !socket.hidden);
  return {
    /**
     * Registers a socket; every socket of the account takes its `hidden`,
     * the newest word on a shadow ban. `shown`: the account now reads online
     * and did not before. `evicted`: the oldest of its sockets past the
     * limit, for the caller to close; the new one is registered first, so
     * the account never reads as offline meanwhile.
     */
    add(socket: LiveSocket): { shown: boolean; evicted: LiveSocket[] } {
      const before = online(socket.accountId);
      const sockets = byAccount.get(socket.accountId) ?? new Set<LiveSocket>();
      for (const other of sockets) other.hidden = socket.hidden;
      sockets.add(socket);
      byAccount.set(socket.accountId, sockets);
      const evicted = [...sockets].slice(0, Math.max(0, sockets.size - socketsPerAccount));
      return { shown: !before && online(socket.accountId), evicted };
    },
    /** Unregisters a socket. `changed`: the account read online and no longer does, or the reverse. */
    remove(socket: LiveSocket): { changed: boolean } {
      const before = online(socket.accountId);
      const sockets = byAccount.get(socket.accountId);
      if (!sockets?.delete(socket)) return { changed: false };
      if (sockets.size === 0) byAccount.delete(socket.accountId);
      return { changed: before !== online(socket.accountId) };
    },
    /**
     * A shadow ban put on or lifted while the account's sockets are open
     * (the ping reads it, ADR-024 §6). `changed` as for remove.
     */
    setHidden(accountId: string, hidden: boolean): { changed: boolean } {
      const before = online(accountId);
      for (const socket of socketsOf(accountId)) socket.hidden = hidden;
      return { changed: before !== online(accountId) };
    },
    socketsOf,
    online,
    all(): LiveSocket[] {
      return [...byAccount.values()].flatMap((sockets) => [...sockets]);
    },
  };
}
