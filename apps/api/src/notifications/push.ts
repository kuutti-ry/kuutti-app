import type { Queryable } from "@kuutti/db";
import type { PlainMessageKey } from "@kuutti/i18n";
import type { NotificationKind, PushData } from "@kuutti/schema";
import { finnishHour, msUntilFinnishHour } from "../lib/finnish-day.ts";
import { tFor } from "../lib/i18n.ts";
import type { Logger } from "../lib/logger.ts";
import { asHour, matchingConfigNumber, matchingConfigNumbers } from "../lib/matching-config.ts";
import {
  EXPO_PROJECT,
  MIXED_PROJECTS,
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
// kind alone, never the conversation, whose id both people's phones would
// share. Nothing here reaches a log line but kinds, counts, error codes and
// the account a line is about.

export const MESSAGE_PUSH_INTERVAL_KEY = "message_push_min_interval_minutes";
export const QUIET_FROM_KEY = "push_quiet_from_hour";
export const QUIET_TO_KEY = "push_quiet_to_hour";

/** The receipts are read once, this long after the send (Expo's advice; ADR-055 §8). */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/**
 * The least time between two requests of one delivery: Expo takes at most
 * 600 pushes a second for a project, and a request is a hundred (ADR-055 §8).
 */
export const REQUEST_SPACING_MS = 200;

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

const realPause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export type PushDeps = {
  db: Queryable;
  logger: Logger;
  now: () => Date;
  /** Absent where PUSH is off: nothing is sent, and nothing is read for it. */
  pusher?: Pusher;
  /** Whether the account has a live socket now (#349): the chat's registry. */
  online: (accountId: string) => boolean;
  schedule?: Schedule;
  /** Waits between two requests of one delivery; tests hand in one that does not. */
  pause?: (ms: number) => Promise<void>;
  /** The Expo project this app's tokens are of; EXPO_PROJECT unless a test says otherwise. */
  project?: string;
};

type Token = { id: string; accountId: string; token: string; locale: string };

/** Whether `hour` is in the quiet hours from `from` to `to` (ADR-055 §7); equal hours mean none. */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The pushes of one process, one per app as the chat's live registry is.
 * A message's and a match's push run after the answer that caused them, so
 * how long an answer takes says nothing about whether anybody was pushed: a
 * shadow ban, a switch or a phone (ADR-055 §4, §5). `settled` waits for what
 * is in flight.
 */
export function createPush(deps: PushDeps) {
  const schedule = deps.schedule ?? realSchedule;
  const pause = deps.pause ?? realPause;
  const project = deps.project ?? EXPO_PROJECT;
  // shortcut: the interval lives in this process's memory, so a restart forgets
  // it and the first message after one may push again early (ADR-055 §4); a
  // column on push_token for the last push of each conversation would lift it.
  const lastPushed = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();

  /**
   * Whether now is in the quiet hours, and how long a push sent now may wait
   * for its phone: until the quiet hours begin, and at most to the end of the
   * Finnish day, so a phone that comes back later is not told late (§7).
   */
  async function timing(at: Date): Promise<{ quiet: boolean; ttl: number }> {
    const hours = await matchingConfigNumbers(deps.db, [QUIET_FROM_KEY, QUIET_TO_KEY]);
    const from = asHour(QUIET_FROM_KEY, hours[QUIET_FROM_KEY]);
    const to = asHour(QUIET_TO_KEY, hours[QUIET_TO_KEY]);
    const untilMidnight = msUntilFinnishHour(at, 0);
    const untilQuiet = from === to ? untilMidnight : msUntilFinnishHour(at, from);
    return {
      quiet: inQuietHours(finnishHour(at), from, to),
      ttl: Math.max(1, Math.floor(Math.min(untilMidnight, untilQuiet) / 1000)),
    };
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
    // shortcut: the receipts wait on a timer in this process's memory, so a
    // restart within the fifteen minutes never reads them and a dead token
    // stays until its next refusal; a table of tickets would lift it.
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
   * One request's pushes, and what Expo said of each. A request refused for
   * tokens of more than one Expo project (a build of another project, or a
   * token typed in by hand) forgets the tokens Expo names under another
   * project than this app's, and is sent once more without them, so one stray
   * token cannot cost the rest of its request every day. Without this app's
   * project among those named, nothing is forgotten on a guess.
   */
  async function sendPart(
    pusher: Pusher,
    part: Array<{ token: Token; message: PushMessage }>,
    kind: PushData["kind"],
  ): Promise<Array<{ token: Token; ticket: PushTicket }>> {
    try {
      const tickets = await pusher.send(part.map(({ message }) => message));
      return part.map(({ token }, i) => ({
        token,
        ticket: tickets[i] ?? { status: "error", error: null },
      }));
    } catch (error) {
      const groups = error instanceof PushFailed ? error.byProject : undefined;
      if (!(error instanceof PushFailed) || error.reason !== MIXED_PROJECTS || !groups) throw error;
      if (!Object.hasOwn(groups, project)) throw error;
      // A stray is a token Expo named under another project; one it named nowhere is kept.
      const foreign = new Set(
        Object.entries(groups).flatMap(([name, tokens]) => (name === project ? [] : tokens)),
      );
      const strays = part.filter(({ token }) => foreign.has(token.token));
      // No stray among this request's tokens: the refusal is the request's, as any other.
      if (strays.length === 0) throw error;
      for (const { token } of strays) await forget(token);
      deps.logger.warn(
        { push: kind, strays: strays.length },
        "push tokens of another project gone",
      );
      const kept = part.filter(({ token }) => !foreign.has(token.token));
      if (kept.length === 0) return [];
      await pause(REQUEST_SPACING_MS);
      return sendPart(pusher, kept, kind);
    }
  }

  /**
   * One push of `data` to every live device of `accountIds`, worded in each
   * device's language. The number of pushes Expo took; none in the quiet
   * hours, where nothing is kept for later (Open 1), and none of them waits
   * for its phone into them. A request at a time, a hundred pushes each and
   * spaced to Expo's rate, so a request refused loses only its own pushes and
   * the tickets of those before it are read; a refusal is logged and nothing
   * is retried (Open 4).
   */
  async function deliver(
    accountIds: string[],
    data: PushData,
    priority: PushMessage["priority"],
  ): Promise<number> {
    const { pusher } = deps;
    if (!pusher || accountIds.length === 0) return 0;
    const at = deps.now();
    const { quiet, ttl } = await timing(at);
    if (quiet) return 0;
    const kind = data.kind;
    const tokens = await tokensOf(await switchedOn(kind, accountIds), at);
    if (tokens.length === 0) return 0;
    const all = tokens.map((token) => ({
      token,
      message: {
        to: token.token,
        body: tFor(token.locale)(LINES[kind]),
        data,
        // A later push of the same kind replaces the earlier one on the phone.
        collapseId: kind,
        tag: kind,
        channelId: "default",
        priority,
        sound: "default",
        ttl,
      } satisfies PushMessage,
    }));
    const taken: Array<{ id: string; token: Token }> = [];
    for (let from = 0; from < all.length; from += PUSHES_PER_REQUEST) {
      if (from > 0) await pause(REQUEST_SPACING_MS);
      const part = all.slice(from, from + PUSHES_PER_REQUEST);
      let answered: Array<{ token: Token; ticket: PushTicket }>;
      try {
        answered = await sendPart(pusher, part, kind);
      } catch (error) {
        deps.logger.warn({ ...failure(error, kind), pushes: part.length }, "push not sent");
        continue;
      }
      for (const { token, ticket } of answered) {
        if (ticket.status === "ok") {
          taken.push({ id: ticket.id, token });
          continue;
        }
        // The push is gone either way; a refusal that cannot be acted on (the
        // database away) is logged and the rest go on, so nothing is retried
        // that was sent (a round run tried again would push everybody twice).
        try {
          await refused(token, ticket.error, kind);
        } catch (error) {
          deps.logger.error({ ...failure(error, kind), err: error }, "push refusal not handled");
        }
      }
    }
    readReceiptsLater(pusher, taken, kind);
    return taken.length;
  }

  /**
   * A sender started after its caller's answer: its failure (a config row
   * missing, the database gone) is logged, and nothing waits for it but
   * `settled`.
   */
  function inTheBackground(kind: PushData["kind"], task: () => Promise<void>): void {
    const running = task().catch((error: unknown) => {
      deps.logger.error({ ...failure(error, kind), err: error }, "push failed");
    });
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
  }

  return {
    /**
     * A message committed (ADR-055 §4): to each of its readers, the
     * participants other than its sender who may read it by the socket's own
     * rule (read only when something may be sent), who has no live socket
     * and was not pushed of this conversation within the interval. The
     * interval counts from the push that went. Returns at once.
     */
    message(input: { conversationId: string; readers: () => Promise<readonly string[]> }): void {
      if (!deps.pusher) return;
      inTheBackground("message", async () => {
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
          // failure on the way, which the background logs).
          const key = `${accountId}:${input.conversationId}`;
          lastPushed.set(key, nowMs);
          let sent = 0;
          try {
            sent = await deliver([accountId], { kind: "message" }, "high");
          } finally {
            if (sent === 0) lastPushed.delete(key);
          }
        }
      });
    },

    /**
     * A match committed (ADR-055 §5): to the person whose earlier like it met,
     * in the app or not, since no frame tells of a new match. Returns at once.
     */
    match(input: { accountId: string }): void {
      if (!deps.pusher) return;
      inTheBackground("match", async () => {
        await deliver([input.accountId], { kind: "match" }, "high");
      });
    },

    /** The day's round (ADR-055 §6), to those the job chose; the job waits for it and logs its failure, and `settled` waits for it too. */
    round(accountIds: readonly string[]): Promise<number> {
      const run = deliver([...accountIds], { kind: "round" }, "normal");
      const watched = run.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(watched);
      void watched.finally(() => inFlight.delete(watched));
      return run;
    },

    /** Resolves once every push started in the background has settled: the tests, and a shutdown. */
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
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
