import type { Queryable } from "@kuutti/db";
import type { PlainMessageKey } from "@kuutti/i18n";
import type { NotificationKind, PushData } from "@kuutti/schema";
import { finnishHour } from "../lib/finnish-day.ts";
import { tFor } from "../lib/i18n.ts";
import type { Logger } from "../lib/logger.ts";
import { matchingConfigNumber, matchingConfigNumbers } from "../lib/matching-config.ts";
import {
  PUSHES_PER_REQUEST,
  type Pusher,
  PushFailed,
  type PushMessage,
  type PushTicket,
} from "../lib/push.ts";

// The push (#102, ADR-055): that there is something, never what or from
// whom. Each sender reads, fresh: the person's switch for its kind (ADR-032),
// the quiet hours, and the tokens of the person's live sessions. A push's one
// line is the app's own words in the device's language; its data names the
// kind and, for a message or a match, the conversation. Nothing here reaches
// a log line but kinds, counts, error codes and the account a line is about.

export const MESSAGE_PUSH_INTERVAL_KEY = "message_push_min_interval_minutes";
export const QUIET_FROM_KEY = "push_quiet_from_hour";
export const QUIET_TO_KEY = "push_quiet_to_hour";

/** The receipts are read once, this long after the send (Expo's advice; ADR-055 §8). */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** What a push of each kind says, in the app's words. */
const LINES: Record<PushData["kind"], PlainMessageKey> = {
  message: "push.message",
  match: "push.match",
  round: "push.round",
};

/**
 * Runs a task after `ms`, on a timer that keeps no process alive. The task
 * never rejects: it logs its own failure. Tests hand in their own, and await it.
 */
export type Schedule = (ms: number, task: () => Promise<void>) => void;

const realSchedule: Schedule = (ms, task) => {
  setTimeout(() => void task(), ms).unref();
};

export type PushDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  /** Absent where PUSH is off: nothing is sent, and nothing is read for it. */
  pusher?: Pusher;
  /** Whether the account has a live socket now (#349): the chat's registry. */
  online: (accountId: string) => boolean;
  schedule?: Schedule;
};

type Token = { id: string; accountId: string; token: string; locale: string };

/** Whether `hour` is in the quiet hours from `from` to `to` (ADR-055 §7); equal hours mean none. */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The pushes of one process: the message's interval kept in its memory
 * (`shortcut:` a restart forgets it, ADR-055 §4) and the receipts it waits
 * for on its timers. One per app, as the chat's live registry is.
 */
export function createPush(deps: PushDeps) {
  const schedule = deps.schedule ?? realSchedule;
  /** When a conversation last pushed to its recipient, by `account:conversation`, in ms. */
  const lastPushed = new Map<string, number>();

  async function quietNow(at: Date): Promise<boolean> {
    const hours = await matchingConfigNumbers(deps.db, [QUIET_FROM_KEY, QUIET_TO_KEY]);
    return inQuietHours(finnishHour(at), hours[QUIET_FROM_KEY], hours[QUIET_TO_KEY]);
  }

  /** The accounts among `accountIds` whose switch for `kind` is on: no row means on (ADR-032 §1). */
  async function switchedOn(kind: NotificationKind, accountIds: string[]): Promise<string[]> {
    const { rows } = await deps.db.query<{ account_id: string }>(
      `SELECT account_id FROM notification_preference
        WHERE account_id = ANY($1::uuid[]) AND kind = $2 AND NOT enabled`,
      [accountIds, kind],
    );
    const off = new Set(rows.map((row) => row.account_id));
    return accountIds.filter((id) => !off.has(id));
  }

  /** The tokens of the accounts' live sessions: an expired one waits for the night's prune, unsent to. */
  async function tokensOf(accountIds: string[], at: Date): Promise<Token[]> {
    const { rows } = await deps.db.query<{
      id: string;
      account_id: string;
      token: string;
      locale: string;
    }>(
      `SELECT t.id, t.account_id, t.token, t.locale FROM push_token t
         JOIN session s ON s.id = t.session_id AND s.account_id = t.account_id
        WHERE t.account_id = ANY($1::uuid[]) AND s.revoked_at IS NULL AND s.expires_at > $2
        ORDER BY t.account_id, t.created_at`,
      [accountIds, at],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      token: row.token,
      locale: row.locale,
    }));
  }

  /** A token Apple or Google no longer knows goes (ADR-055 §8), by its row and its account. */
  async function forget(token: Token): Promise<void> {
    await deps.db.query("DELETE FROM push_token WHERE id = $1 AND account_id = $2", [
      token.id,
      token.accountId,
    ]);
  }

  /** What a ticket or receipt refused: a dead token goes, any other refusal is logged by its code. */
  async function refused(token: Token, error: string | null, kind: PushData["kind"]) {
    if (error === "DeviceNotRegistered") {
      await forget(token);
      deps.logger.info({ accountId: token.accountId, push: kind }, "push token gone");
      return;
    }
    deps.logger.warn({ accountId: token.accountId, push: kind, error }, "push refused");
  }

  /** The receipts of what Expo took, read once (ADR-055 §8); a failure is logged and the tokens kept. */
  function readReceiptsLater(
    pusher: Pusher,
    taken: Array<{ id: string; token: Token }>,
    kind: PushData["kind"],
  ) {
    if (taken.length === 0) return;
    schedule(RECEIPT_DELAY_MS, async () => {
      try {
        const receipts = await pusher.receipts(taken.map(({ id }) => id));
        for (const { id, token } of taken) {
          const receipt = receipts.get(id);
          if (receipt?.status === "error") await refused(token, receipt.error, kind);
        }
      } catch (error) {
        deps.logger.warn(failure(error, kind), "push receipts not read");
      }
    });
  }

  /**
   * One push of `data` to every live device of `accountIds`, worded in each
   * device's language. The number of pushes Expo took; none in the quiet
   * hours, where nothing is kept for later (Open 1). A refused request is
   * logged and answers nought: the push is lost, and the app shows everything
   * when it opens (Open 4).
   */
  async function deliver(
    accountIds: string[],
    data: PushData,
    options: { collapse: string; priority: PushMessage["priority"]; ttl?: number },
  ): Promise<number> {
    const { pusher } = deps;
    if (!pusher || accountIds.length === 0) return 0;
    const at = deps.now();
    if (await quietNow(at)) return 0;
    const kind = data.kind;
    const tokens = await tokensOf(await switchedOn(kind, accountIds), at);
    if (tokens.length === 0) return 0;
    const messages: PushMessage[] = tokens.map((token) => ({
      to: token.token,
      body: tFor(token.locale)(LINES[kind]),
      data,
      collapseId: options.collapse,
      tag: options.collapse,
      channelId: "default",
      priority: options.priority,
      sound: "default",
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
    }));
    // A request at a time, as many pushes as Expo takes in one, so a request
    // refused loses only its own pushes, and the tickets of those sent before
    // it are still read (the round's push can be thousands).
    const taken: Array<{ id: string; token: Token }> = [];
    for (let from = 0; from < messages.length; from += PUSHES_PER_REQUEST) {
      const part = tokens.slice(from, from + PUSHES_PER_REQUEST);
      let tickets: PushTicket[];
      try {
        tickets = await pusher.send(messages.slice(from, from + PUSHES_PER_REQUEST));
      } catch (error) {
        deps.logger.warn({ ...failure(error, kind), pushes: part.length }, "push not sent");
        continue;
      }
      for (const [i, ticket] of tickets.entries()) {
        const token = part[i];
        if (!token) continue;
        if (ticket.status === "ok") taken.push({ id: ticket.id, token });
        else await refused(token, ticket.error, kind);
      }
    }
    readReceiptsLater(pusher, taken, kind);
    return taken.length;
  }

  /** A sender's failure (a config row missing, the database gone) is logged and changes nothing for its caller. */
  async function guarded(kind: PushData["kind"], task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      deps.logger.error({ ...failure(error, kind), err: error }, "push failed");
    }
  }

  return {
    /**
     * A message committed (ADR-055 §4): to each of its readers, the
     * participants other than its sender who may read it by the socket's own
     * rule (read only when something may be sent), who has no live socket
     * and was not pushed of this conversation within the interval. The
     * interval counts from the push that went.
     */
    message: (input: { conversationId: string; readers: () => Promise<readonly string[]> }) =>
      guarded("message", async () => {
        if (!deps.pusher) return;
        const nowMs = deps.now().getTime();
        const intervalMs =
          (await matchingConfigNumber(deps.db, MESSAGE_PUSH_INTERVAL_KEY)) * 60 * 1000;
        for (const [key, at] of lastPushed) {
          if (nowMs - at >= intervalMs) lastPushed.delete(key);
        }
        const due = (await input.readers()).filter(
          (accountId) =>
            !deps.online(accountId) && !lastPushed.has(`${accountId}:${input.conversationId}`),
        );
        for (const accountId of due) {
          // Taken before the send, so two messages at once push once; given
          // back when nothing went (the quiet hours, no device, a refusal, a
          // failure on the way, which `guarded` logs).
          const key = `${accountId}:${input.conversationId}`;
          lastPushed.set(key, nowMs);
          let sent = 0;
          try {
            sent = await deliver(
              [accountId],
              { kind: "message", conversationId: input.conversationId },
              { collapse: input.conversationId, priority: "high" },
            );
          } finally {
            if (sent === 0) lastPushed.delete(key);
          }
        }
      }),

    /**
     * A match committed (ADR-055 §5): to the person whose earlier like it met,
     * in the app or not, since no frame tells of a new match.
     */
    match: (input: { accountId: string; conversationId: string }) =>
      guarded("match", async () => {
        await deliver(
          [input.accountId],
          { kind: "match", conversationId: input.conversationId },
          { collapse: input.conversationId, priority: "high" },
        );
      }),

    /** The day's round (ADR-055 §6), to those the job chose; it lives until the day ends. */
    async round(accountIds: readonly string[], ttlSeconds: number): Promise<number> {
      return deliver(
        [...accountIds],
        { kind: "round" },
        {
          collapse: "round",
          priority: "normal",
          ttl: ttlSeconds,
        },
      );
    },
  };
}

export type Push = ReturnType<typeof createPush>;

/** A failure's kind for a log line: Expo's code or status, never a token. */
function failure(error: unknown, kind: PushData["kind"]): Record<string, unknown> {
  return error instanceof PushFailed
    ? { push: kind, reason: error.reason, status: error.status }
    : { push: kind, reason: error instanceof Error ? error.name : "unknown" };
}
