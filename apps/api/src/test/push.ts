import type { Queryable } from "@kuutti/db";
import { expect } from "vitest";
import type { Pusher, PushMessage, PushReceipt, PushTicket } from "../lib/push.ts";

// The push's doubles (#102, ADR-055 §8): a pusher that keeps what it was
// handed in memory and answers what the test chooses, a schedule that keeps
// the receipts' task for the test to run, a device's session and token
// written straight into the test's transaction, and the payload rule's
// checker (§1), which every push a test records is held to.

/** A pusher in memory: every batch it was handed, tickets and receipts as the test says, or a failure. */
export type MemoryPusher = Pusher & {
  /** Each send's messages, in order, a failed one's too. */
  batches: PushMessage[][];
  /** Every message handed to a send. */
  sent: () => PushMessage[];
  /** Each receipts read's ids, in order. */
  asked: string[][];
  /** The ticket for each message; by default taken, with the next id. */
  ticket: (message: PushMessage) => PushTicket;
  /** The receipt for each id; undefined is an id Expo has no receipt for. By default ok. */
  receipt: (id: string) => PushReceipt | undefined;
  /** Thrown by the next sends while set. */
  failure?: Error;
  /** Thrown by the receipts read while set. */
  receiptFailure?: Error;
  /** While set, a send waits for it before it answers. */
  gate?: Promise<void>;
  /** Called as a send begins, before it waits. */
  reached?: () => void;
};

export function memoryPusher(): MemoryPusher {
  let tickets = 0;
  const pusher: MemoryPusher = {
    batches: [],
    asked: [],
    sent: () => pusher.batches.flat(),
    ticket: () => {
      tickets += 1;
      return { status: "ok", id: `ticket-${tickets}` };
    },
    receipt: () => ({ status: "ok" }),
    async send(messages) {
      pusher.batches.push([...messages]);
      pusher.reached?.();
      if (pusher.gate) await pusher.gate;
      if (pusher.failure) throw pusher.failure;
      return messages.map((message) => pusher.ticket(message));
    },
    async receipts(ids) {
      pusher.asked.push([...ids]);
      if (pusher.receiptFailure) throw pusher.receiptFailure;
      const found = new Map<string, PushReceipt>();
      for (const id of ids) {
        const receipt = pusher.receipt(id);
        if (receipt) found.set(id, receipt);
      }
      return found;
    },
  };
  return pusher;
}

/** A schedule that keeps each task with its delay; the test runs them and awaits them. */
export function heldSchedule() {
  const tasks: Array<{ ms: number; task: () => Promise<void> }> = [];
  return {
    tasks,
    schedule: (ms: number, task: () => Promise<void>) => {
      tasks.push({ ms, task });
    },
    /** Runs every task not yet run, in order, as their timers would. */
    async runAll(): Promise<number> {
      const due = tasks.splice(0);
      for (const held of due) await held.task();
      return due.length;
    },
  };
}

/** A gate the test opens: what waits on it goes on when it is opened. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let devices = 0;

/**
 * A device of `accountId`: a session and its push token, written as the
 * route writes them, the session revoked or expired as asked (a row the
 * trigger would never leave, for the sender's own filter). The token is
 * counted, never random: tests are deterministic.
 */
export async function deviceOf(
  db: Queryable,
  accountId: string,
  options: {
    locale?: string;
    platform?: "ios" | "android";
    at?: Date;
    expiresAt?: Date;
    revokedAt?: Date;
  } = {},
): Promise<{ sessionId: string; token: string; tokenId: string }> {
  devices += 1;
  const at = options.at ?? new Date("2026-10-01T09:00:00.000Z");
  const platform = options.platform ?? "ios";
  const session = await db.query<{ id: string }>(
    `INSERT INTO session (account_id, platform, access_hash, access_expires_at, refresh_hash, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      accountId,
      platform,
      `push-device-access-${process.pid}-${devices}`,
      new Date(at.getTime() + 15 * 60 * 1000),
      `push-device-refresh-${process.pid}-${devices}`,
      options.expiresAt ?? new Date(at.getTime() + 365 * 24 * 60 * 60 * 1000),
      options.revokedAt ?? null,
    ],
  );
  const sessionId = session.rows[0]?.id;
  if (!sessionId) throw new Error("test session not written");
  const token = `ExponentPushToken[device-${process.pid}-${devices}]`;
  const written = await db.query<{ id: string }>(
    `INSERT INTO push_token (account_id, session_id, token, platform, locale, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [accountId, sessionId, token, platform, options.locale ?? "en", at],
  );
  const tokenId = written.rows[0]?.id;
  if (!tokenId) throw new Error("test push token not written");
  return { sessionId, token, tokenId };
}

/** The push tokens left, by their strings, in the order written. */
export async function tokensLeft(db: Queryable, accountIds: string[]): Promise<string[]> {
  const { rows } = await db.query<{ token: string }>(
    "SELECT token FROM push_token WHERE account_id = ANY($1::uuid[]) ORDER BY created_at, token",
    [accountIds],
  );
  return rows.map((row) => row.token);
}

/**
 * What a push must never carry (ADR-055 §1): the people's words, names,
 * accounts and sessions, and the conversation, whose id both people's
 * phones would share.
 */
export type Withheld = {
  texts?: readonly string[];
  names?: readonly string[];
  ids?: readonly string[];
  conversations?: readonly string[];
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The payload rule (ADR-055 §1): what a push carries past its address says
 * that there is something, never what or from whom. Its every field but `to`
 * is read as Expo, Apple and Google receive it: no message text, no name, no
 * account's, session's or conversation's id, in any case; no uuid at all,
 * since its data names its kind alone. The reasons it fails, empty when it
 * passes.
 */
export function payloadBreaches(message: PushMessage, withheld: Withheld): string[] {
  const { to: _address, ...payload } = message;
  const carried = JSON.stringify(payload);
  const lower = carried.toLowerCase();
  const breaches: string[] = [];
  for (const [what, values] of [
    ["text", withheld.texts ?? []],
    ["name", withheld.names ?? []],
    ["id", withheld.ids ?? []],
    ["conversation", withheld.conversations ?? []],
  ] as const) {
    for (const value of values) {
      if (value.length > 0 && lower.includes(value.toLowerCase()))
        breaches.push(`${what}: ${value}`);
    }
  }
  for (const uuid of carried.match(UUID) ?? []) breaches.push(`uuid: ${uuid}`);
  return breaches;
}

/** Every push in `messages` holds to the payload rule; the number held, so a test can see it held some. */
export function expectNamesNothing(messages: readonly PushMessage[], withheld: Withheld): number {
  for (const message of messages) {
    expect(payloadBreaches(message, withheld), JSON.stringify(message.data)).toEqual([]);
  }
  return messages.length;
}
