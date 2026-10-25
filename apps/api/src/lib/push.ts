import type { PushData } from "@kuutti/schema";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";

/**
 * One push to one device (#102, ADR-055 §1), in Expo's message format: one
 * line of the app's own words, no title, no badge, and `data` naming what it
 * is about. `collapseId` (both platforms) and `tag` (Android) replace an
 * earlier push of the same thing on the phone.
 */
export type PushMessage = {
  to: string;
  body: string;
  data: PushData;
  collapseId: string;
  tag: string;
  channelId: "default";
  priority: "normal" | "high";
  sound: "default";
  /** Seconds the push may wait for a phone that is off; Expo's four weeks when absent. */
  ttl?: number;
};

/** Expo's answer for one push, in the order sent: taken, with its receipt's id, or refused. */
export type PushTicket = { status: "ok"; id: string } | { status: "error"; error: string | null };

/** What Apple or Google made of a push, read once from Expo (ADR-055 §8). */
export type PushReceipt = { status: "ok" } | { status: "error"; error: string | null };

/** Where pushes go out: Expo's push service, or the log on a developer's machine. */
export type Pusher = {
  send: (messages: readonly PushMessage[]) => Promise<PushTicket[]>;
  receipts: (ids: readonly string[]) => Promise<Map<string, PushReceipt>>;
};

/**
 * A request Expo did not take, by its error code or HTTP status alone: never
 * the tokens it was for, since this error reaches a log line.
 */
export class PushFailed extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | undefined,
  ) {
    super(`push not sent: ${reason}`);
    this.name = "PushFailed";
  }
}

const EXPO_PUSH = "https://exp.host/--/api/v2/push";
/** Expo's ceilings per request: a hundred pushes, a thousand receipts. */
export const PUSHES_PER_REQUEST = 100;
const RECEIPTS_PER_REQUEST = 1000;
/** A send waits for Expo at most this long (ADR-055 §4): a message's answer waits on it. */
const EXPO_TIMEOUT_MS = 5_000;

const Refusal = z.object({ details: z.object({ error: z.string().max(100) }).partial() }).partial();
const TicketAnswer = z.object({
  data: z.array(
    z.union([
      z.object({ status: z.literal("ok"), id: z.string().min(1).max(100) }),
      z.object({ status: z.literal("error") }).extend(Refusal.shape),
    ]),
  ),
});
const ReceiptAnswer = z.object({
  data: z.record(
    z.string().max(100),
    z.union([
      z.object({ status: z.literal("ok") }),
      z.object({ status: z.literal("error") }).extend(Refusal.shape),
    ]),
  ),
});
/** A whole request refused (`errors`): its first code, which names no token. */
const RequestRefusal = z.object({
  errors: z.array(z.object({ code: z.string().max(100) })).min(1),
});

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Expo's push service (ADR-055 §8): JSON over HTTPS, a hundred pushes a
 * request, each request cut at five seconds. With an access token, Expo's
 * enhanced push security (EAS) can be on; without one it must be off. A
 * request refused as a whole, by its status or Expo's code, throws
 * `PushFailed`, and nothing of it is retried (Open 4).
 */
export function expoPusher(
  fetchImpl: typeof fetch,
  options: { accessToken?: string; timeoutMs?: number } = {},
): Pusher {
  const post = async (path: string, payload: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${EXPO_PUSH}/${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? EXPO_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PushFailed(error instanceof Error ? error.name : "unknown", undefined);
    }
    const answer: unknown = await response.json().catch(() => null);
    const refused = RequestRefusal.safeParse(answer);
    if (!response.ok || refused.success) {
      throw new PushFailed(
        refused.success ? (refused.data.errors[0]?.code ?? "refused") : "refused",
        response.status,
      );
    }
    return answer;
  };
  return {
    send: async (messages) => {
      const tickets: PushTicket[] = [];
      for (const part of chunks(messages, PUSHES_PER_REQUEST)) {
        const parsed = TicketAnswer.safeParse(await post("send", part));
        if (!parsed.success || parsed.data.data.length !== part.length) {
          throw new PushFailed("unexpected_answer", 200);
        }
        for (const ticket of parsed.data.data) {
          tickets.push(
            ticket.status === "ok"
              ? { status: "ok", id: ticket.id }
              : { status: "error", error: ticket.details?.error ?? null },
          );
        }
      }
      return tickets;
    },
    receipts: async (ids) => {
      const found = new Map<string, PushReceipt>();
      for (const part of chunks(ids, RECEIPTS_PER_REQUEST)) {
        const parsed = ReceiptAnswer.safeParse(await post("getReceipts", { ids: part }));
        if (!parsed.success) throw new PushFailed("unexpected_answer", 200);
        for (const [id, receipt] of Object.entries(parsed.data.data)) {
          found.set(
            id,
            receipt.status === "ok"
              ? { status: "ok" }
              : { status: "error", error: receipt.details?.error ?? null },
          );
        }
      }
      return found;
    },
  };
}

/**
 * A developer's machine and the tests (ADR-055 §8): what would go is written
 * to the log, by kind and number, never a token, and nothing leaves the
 * process. The configuration refuses it anywhere else, as it does mail's log.
 */
export function logPusher(logger: Logger): Pusher {
  return {
    send: async (messages) => {
      for (const message of messages) {
        logger.info({ push: message.data.kind }, "push not sent: written here instead");
      }
      return messages.map((_, i) => ({ status: "ok", id: `log-${i}` }));
    },
    receipts: async () => new Map(),
  };
}

/** The pusher the configuration names; none when PUSH is off, and nothing is sent. */
export function pusherFor(
  config: Pick<Config, "PUSH" | "EXPO_ACCESS_TOKEN">,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Pusher | undefined {
  if (config.PUSH === "expo") {
    return expoPusher(
      fetchImpl,
      config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {},
    );
  }
  if (config.PUSH === "log") return logPusher(logger);
  return undefined;
}
