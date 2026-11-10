import type { MiddlewareHandler } from "hono";
import pino, { type Logger } from "pino";
import type { TrustedProxy } from "./rate-limit.ts";
import { cloudFrontRequestId } from "./request-id.ts";

export type { Logger };

/**
 * Fields that must never reach a log line: the personal identity code, message
 * text, email, credentials, a report's note, a message's body, a stored contact, a home (CLAUDE.md security defaults, rule 5). Top level and
 * one level nested; the PII-in-logs test (#11) is the backstop.
 */
const REDACTED_PATHS = [
  "hetu",
  "personal_identity_code",
  "email",
  "message",
  "text",
  "password",
  "authorization",
  "cookie",
  // Whom a person seeks and how they describe themselves stay out of every line (rule 5, #46).
  "seeks",
  "gender",
  // A person's own words to the moderators, a report's note (#84, ADR-030 §9).
  "note",
  // A message's text (#348, ADR-031 §7): the request line only; a photo's caption too (#350).
  "body",
  "caption",
  // A stored contact (#103, ADR-031 §11): the request's body names it so.
  "value",
  // A home (#514, ADR-061 §9): the request's body and the row name it so. A net:
  // the digits are looked up in memory, and no line is written with a home in it.
  "postalCode",
  "homePlace",
  "home_place",
  // App Attest (ADR-069): what the phone sends and the key a session keeps. A
  // net: no line is written with any of them.
  "attestation",
  "assertion",
  "keyId",
  "attestKey",
  "attest_key",
  "*.hetu",
  "*.personal_identity_code",
  "*.email",
  "*.message",
  "*.text",
  "*.caption",
  "*.password",
  "*.authorization",
  "*.cookie",
  "*.seeks",
  "*.gender",
  "*.note",
  "*.body",
  "*.value",
  "*.postalCode",
  "*.homePlace",
  "*.home_place",
  "*.attestation",
  "*.assertion",
  "*.keyId",
  "*.attestKey",
  "*.attest_key",
];

type LogDestination = { write(line: string): void };

export type LoggerOptions = {
  level: string;
  pretty: boolean;
  destination?: LogDestination;
};

/**
 * What of an error may reach a line: the fields that name the kind of failure
 * and nothing that quotes a value. pino's default serializer copies every own
 * property of the error, and a database error's `detail` ("Key (hetu_hmac)=(…)
 * already exists"), `hint` and `where` quote the statement and its values, a
 * validation error's `issues` can carry what was received (#636, the audit of
 * #609). An `AppError`'s detail is the route's own object, meant for the log
 * (lib/errors.ts) and kept; a detail that is a string is a database's and goes.
 * The message is blanked here at every level, since the redaction of `*.message`
 * reaches one level down and a cause's cause is deeper; the stack keeps its
 * frames and nothing else, since pino writes the message on its first line, a
 * multiline message on the next ones and a cause's message after `caused by:`.
 * Sentry receives the unredacted error (#11).
 */
const ERROR_FIELDS = new Set([
  "type",
  "message",
  "stack",
  "name",
  "code",
  "status",
  "statusCode",
  "reason",
  "kind",
  "problem",
  // A database error's kind: never its detail, hint or where.
  "severity",
  "schema",
  "table",
  "column",
  "constraint",
  "routine",
  // An AWS SDK error's: the status, the request ids, the retries.
  "$metadata",
]);

export function serializeError(error: unknown): ReturnType<typeof pino.stdSerializers.err> {
  const serialized = pino.stdSerializers.err(error as Error);
  // A value that is no error comes back as it was, null too (#102: a push
  // refused with no code logs `error: null`), and has no stack to redact.
  if (typeof serialized?.stack !== "string") return serialized;
  const kept: Record<string, unknown> = Object.fromEntries(
    Object.entries(serialized).filter(
      ([field, value]) =>
        ERROR_FIELDS.has(field) ||
        (field === "detail" && typeof value === "object" && value !== null),
    ),
  );
  kept.stack = serialized.stack
    .split("\n")
    .map((line, i) => {
      if (i === 0) return `${serialized.type ?? "Error"}: [redacted]`;
      if (/^\s+at /.test(line)) return line;
      return line.startsWith("caused by: ") ? "caused by: [redacted]" : "[redacted]";
    })
    .join("\n");
  if ("message" in kept) kept.message = "[redacted]";
  // A cause gets the same allowlist, read off the error itself, since pino
  // leaves it out; one that is no error (a library's object of claims, a
  // database's string) is dropped, as nothing of it names a kind.
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) kept.cause = serializeError(cause);
  return kept as ReturnType<typeof pino.stdSerializers.err>;
}

export async function createLogger(options: LoggerOptions): Promise<Logger> {
  const base = {
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    serializers: { err: serializeError, error: serializeError },
  };
  if (options.pretty) {
    // Development only. pino-pretty is external to the production bundle and
    // never installed in the runtime image.
    const { default: pretty } = await import("pino-pretty");
    return pino(base, pretty({ colorize: true, translateTime: "HH:MM:ss" }));
  }
  return pino(base, options.destination ?? pino.destination(1));
}

/**
 * Structured request log with the fields the checklist allows: ids, route,
 * status, timing. Never a client address (ADR-026 §7).
 */
export function requestLogger(
  logger: Logger,
  options: { trustedProxy: TrustedProxy } = { trustedProxy: "none" },
): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId: c.get("requestId"),
        // CloudFront's id is a correlation field only, and only once nothing
        // but CloudFront can reach the box; before that a client could plant one.
        ...(options.trustedProxy === "cloudfront"
          ? { cfRequestId: cloudFrontRequestId(c.req.header("x-amz-cf-id")) }
          : {}),
        accountId: c.get("accountId"),
        // The panel's requests carry the staff identity as the app's carry the account (ADR-026 §7).
        staffIdentityId: c.get("adminIdentityId"),
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      },
      "request",
    );
  };
}
