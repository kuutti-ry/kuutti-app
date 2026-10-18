import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AccountDeletionRequest,
  AccountEmail,
  AccountEmailResponse,
  AccountExport,
  AccountPauseRequest,
  ErrorResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { tOf } from "../lib/i18n.ts";
import { type ErasureDeps, eraseAccount } from "./erasure.ts";
import { exportArchive } from "./export.ts";
import { pauseAccount } from "./pause.ts";
import * as repo from "./repo.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };

const deleteRoute = createRoute({
  method: "post",
  path: "/account/delete",
  summary: "Delete this account",
  description:
    "Erasure per TD-7: every session, login attempt, photo (with its objects unless another account shares them), review row and fetch log entry goes; the account row stays as an anonymised tombstone and the identity keeps a deletion count and a 30-day cooldown before a new account. The audit log is untouched. The body confirms; the app asks first.",
  ...bearer,
  request: { body: { required: true, ...json(AccountDeletionRequest) } },
  responses: {
    204: { description: "Erased. Every token of this account has stopped working." },
    400: errorContent("Validation failed (confirm missing)."),
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    404: errorContent(
      "No live account: a second deletion that passed the session guard before the first committed (not_found).",
    ),
  },
});

const exportRoute = createRoute({
  method: "get",
  path: "/account/export",
  summary: "Everything Kuutti holds about this account",
  description:
    "One zip, named <stem>-<date>.zip in the request's language: a JSON document (the AccountExport schema) with the account, the identity's dates and login level, the devices signed in, the photos with their moderation outcome and the person's own fetch log, and beside it photos/<photo id>.webp, the full-size file of every profile photo whose object the store holds and of the newest hundred photos the person sent in conversations, whose lines carry each one's moderation outcome and description. Nothing about anyone else. At most matching_config exports_per_day copies per Finnish calendar day; each photo read is logged as a fetch of the full variant, a sent photo's with the purpose message, never counted.",
  ...bearer,
  responses: {
    200: {
      description: "The zip; Content-Disposition names the file.",
      content: {
        "application/zip": {
          schema: z.string().openapi({
            format: "binary",
            description: "The zip with the document and the photos.",
          }),
        },
      },
    },
    401: errorContent("unauthenticated, session_expired or session_revoked."),
    404: errorContent(
      "No live account: erased between the session guard and the record (not_found).",
    ),
    429: errorContent(
      "export_budget_exceeded: the day's copies are used up; Retry-After is the wait until the day rolls.",
    ),
  },
});

const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const pauseRoute = createRoute({
  method: "post",
  path: "/account/pause",
  summary: "Take a break: pause this account",
  description:
    "The account goes to paused (#170, ADR-022): the profile leaves every pool, counter and round, and every session of the account ends, this one included. Nothing is erased: the profile, the photos, the preferences, the consents and the place at the gate stay as they are, and the next bank login brings the account back as it was. The body confirms; the screen asks first.",
  ...bearer,
  request: { body: { required: true, ...json(AccountPauseRequest) } },
  responses: {
    204: { description: "Paused. Every token of this account has stopped working." },
    400: errorContent("Validation failed (confirm missing)."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent(
      "not_active: onboarding is not finished, so there is nothing to hide yet; already_paused: another device paused the account first.",
    ),
  },
});

const emailRoute = createRoute({
  method: "get",
  path: "/account/email",
  summary: "The caller's optional e-mail",
  description:
    "The optional e-mail of #148 (TD-18): a way back in if a phone is lost, never a login, never shown to anybody. Null when none is set.",
  ...bearer,
  responses: {
    200: { description: "The e-mail, or null.", ...json(AccountEmailResponse) },
    401: unauthenticated,
  },
});

const setEmailRoute = createRoute({
  method: "put",
  path: "/account/email",
  summary: "Set the caller's optional e-mail",
  description:
    "Validated as an address and nothing else; no mail is sent until SES exists (M5). The value reaches no log line and no event.",
  ...bearer,
  request: { body: { required: true, ...json(AccountEmail) } },
  responses: {
    204: { description: "Set." },
    400: errorContent("Validation failed: not an address."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const clearEmailRoute = createRoute({
  method: "delete",
  path: "/account/email",
  summary: "Clear the caller's optional e-mail",
  ...bearer,
  responses: {
    204: { description: "Cleared." },
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

export function accountRoutes(deps: Deps, requireSession: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  // The document inside the zip is not a response body, so the contract
  // carries it as a component by name (#237): a reader of openapi.json finds it.
  app.openAPIRegistry.register("AccountExport", AccountExport);
  const erasureDeps: ErasureDeps = {
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    ...(deps.media ? { media: deps.media } : {}),
  };
  const routes = [deleteRoute, exportRoute, pauseRoute, emailRoute, setEmailRoute, clearEmailRoute];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }

  app.openapi(emailRoute, async (c) => {
    const account = await repo.findAccountById(deps.db, callerOf(c).accountId);
    if (!account || account.state === "deleted") {
      throw new AppError(404, "not_found", "No live account");
    }
    return c.json({ email: account.email }, 200);
  });

  app.openapi(setEmailRoute, async (c) => {
    const { accountId } = callerOf(c);
    if (!(await repo.setEmail(deps.db, accountId, c.req.valid("json").email))) {
      throw new AppError(404, "not_found", "No live account");
    }
    // The address stays out of the log (rules/api.md): this line says only that one was set.
    deps.logger.info({ accountId }, "email set");
    return c.body(null, 204);
  });

  app.openapi(clearEmailRoute, async (c) => {
    const { accountId } = callerOf(c);
    if (!(await repo.setEmail(deps.db, accountId, null))) {
      throw new AppError(404, "not_found", "No live account");
    }
    deps.logger.info({ accountId }, "email cleared");
    return c.body(null, 204);
  });

  app.openapi(deleteRoute, async (c) => {
    c.req.valid("json"); // confirm: true, or the validator has answered 400
    await eraseAccount(erasureDeps, callerOf(c).accountId);
    return c.body(null, 204);
  });

  app.openapi(pauseRoute, async (c) => {
    c.req.valid("json"); // confirm: true, or the validator has answered 400
    await pauseAccount(
      { db: deps.db, logger: deps.logger, now: () => new Date() },
      callerOf(c).accountId,
    );
    return c.body(null, 204);
  });

  app.openapi(exportRoute, async (c) => {
    let archive: Awaited<ReturnType<typeof exportArchive>>;
    try {
      archive = await exportArchive(
        { ...erasureDeps, version: deps.config.APP_VERSION },
        callerOf(c).accountId,
        tOf(c),
      );
    } catch (error) {
      // The wait until the day rolls, as the photo and card routes say it.
      if (error instanceof AppError && error.code === "export_budget_exceeded") {
        const wait = (error.detail as { retryAfterSeconds?: number } | undefined)
          ?.retryAfterSeconds;
        c.header("Retry-After", String(wait ?? 1));
      }
      throw error;
    }
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${archive.name}"`);
    c.header("Cache-Control", "no-store");
    return c.body(archive.bytes, 200);
  });

  return app;
}
