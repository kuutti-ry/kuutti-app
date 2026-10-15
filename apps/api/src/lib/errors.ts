import type { Hook } from "@hono/zod-openapi";
import type { ErrorResponse } from "@kuutti/schema";
import type { Context, Env, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ERROR_MESSAGE_KEYS, isLocalisedErrorCode, type LocalisedErrorCode, tOf } from "./i18n.ts";
import type { Logger } from "./logger.ts";

/** A failure the route chose to signal. Detail is logged, never returned. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Called for every unhandled error after it is logged; Sentry in deployed environments (#11), nothing in tests. */
export type ErrorReporter = (
  error: unknown,
  context: { requestId: string; route?: string },
) => void;

const noReporter: ErrorReporter = () => {};

export function envelope(code: string, message: string, requestId: string): ErrorResponse {
  return { error: { code, message, requestId } };
}

/** The envelope for a code whose message is in messages.yaml, in the request's language (#13). */
export function localisedEnvelope<E extends Env>(
  c: Context<E, string>,
  code: LocalisedErrorCode,
): ErrorResponse {
  return envelope(code, tOf(c)(ERROR_MESSAGE_KEYS[code]), requestIdOf(c));
}

function requestIdOf<E extends Env>(c: Context<E, string>): string {
  const id: unknown = c.get("requestId");
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

export function onError<E extends Env>(
  logger: Logger,
  report: ErrorReporter = noReporter,
): ErrorHandler<E> {
  return (err, c) => {
    const requestId = requestIdOf(c);
    if (err instanceof AppError) {
      logger.warn({ requestId, code: err.code, detail: err.detail }, err.message);
      // A code with a catalogue message answers in the request's language; any
      // other code returns the route's own English message until it gets a key.
      const body = isLocalisedErrorCode(err.code)
        ? localisedEnvelope(c, err.code)
        : envelope(err.code, err.message, requestId);
      return c.json(body, err.status);
    }
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      const code =
        status === 413
          ? "payload_too_large"
          : status === 415
            ? "unsupported_media_type"
            : status === 401
              ? "unauthenticated"
              : "http_error";
      logger.warn({ requestId, status }, err.message);
      return c.json(localisedEnvelope(c, code), status);
    }
    logger.error({ requestId, err }, "unhandled error");
    report(err, { requestId, route: c.req.routePath });
    return c.json(localisedEnvelope(c, "internal_error"), 500);
  };
}

export function notFound<E extends Env>(): NotFoundHandler<E> {
  return (c) => c.json(localisedEnvelope(c, "not_found"), 404);
}

/**
 * Runs after every contract validation. A failed body, query, or param never
 * reaches a handler: 400 in the envelope, the zod issues in the log line that
 * shares the requestId.
 */
export function validationHook<E extends Env>(logger: Logger): Hook<unknown, E, string, unknown> {
  return (result, c) => {
    if (!result.success) {
      logger.warn(
        { requestId: requestIdOf(c), route: c.req.routePath, issues: result.error.issues },
        "request validation failed",
      );
      return c.json(localisedEnvelope(c, "validation_failed"), 400);
    }
    return undefined;
  };
}
