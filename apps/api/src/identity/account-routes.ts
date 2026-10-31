import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  AccountDeletionRequest,
  AccountEmail,
  AccountEmailConfirmation,
  AccountEmailResponse,
  AccountExport,
  AccountPauseRequest,
  ErrorResponse,
  FoundThemRequest,
  FoundThemStatus,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { tOf } from "../lib/i18n.ts";
import {
  confirmEmailCode,
  type EmailDeps,
  readEmail,
  sendEmailCode,
  setAccountEmail,
} from "./email.ts";
import { type ErasureDeps, eraseAccount } from "./erasure.ts";
import { exportArchive } from "./export.ts";
import { foundThemAnswered, tellFoundThem } from "./found-them.ts";
import { pauseAccount } from "./pause.ts";

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
    "The account goes to paused (#170, ADR-022): the profile leaves every pool, counter and round, and every session of the account ends, this one included. Nothing is erased: the profile, the photos, the preferences and the consents stay as they are, and the next bank login brings the account back as it was. The body confirms; the screen asks first.",
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

const foundThemReadRoute = createRoute({
  method: "get",
  path: "/account/found-them",
  summary: "Whether the caller told Kuutti they found somebody",
  description:
    '"Löysin hänet" (#83, ADR-040): whether this account has answered, so the screen can thank the person instead of asking again. Never which reason: the account does not keep it.',
  ...bearer,
  responses: {
    200: { description: "Answered or not.", ...json(FoundThemStatus) },
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const foundThemRoute = createRoute({
  method: "post",
  path: "/account/found-them",
  summary: "Tell Kuutti you found somebody",
  description:
    '"Löysin hänet" (#83, ADR-040): the reason, from a closed list, counted once per account in an anonymous daily count that names nobody, and a research event for those who said yes to research. An indication only: nothing else changes, no state, no session, no round, no conversation.',
  ...bearer,
  request: { body: { required: true, ...json(FoundThemRequest) } },
  responses: {
    204: { description: "Counted." },
    400: errorContent("Validation failed (a reason outside the list)."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent(
      "found_them_answered: this account told Kuutti already; nothing was counted.",
    ),
  },
});

const emailRoute = createRoute({
  method: "get",
  path: "/account/email",
  summary: "The caller's optional e-mail",
  description:
    "The optional e-mail of #148 (TD-18): a way for Kuutti to stay in touch (#385), never a login, never shown to anybody. Null when none is set; whether it is confirmed, and until when a code waits for it (ADR-043).",
  ...bearer,
  responses: {
    200: {
      description: "The e-mail, or null, and its confirmation.",
      ...json(AccountEmailResponse),
    },
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const setEmailRoute = createRoute({
  method: "put",
  path: "/account/email",
  summary: "Set the caller's optional e-mail",
  description:
    "Validated as an address. A different address than the one stored is unconfirmed, and a code waiting for the old one goes; the same address again changes nothing. Nothing is sent: the app asks for a code with POST /account/email/code (ADR-043). The value reaches no log line and no event.",
  ...bearer,
  request: { body: { required: true, ...json(AccountEmail) } },
  responses: {
    200: { description: "Set; the address and its confirmation.", ...json(AccountEmailResponse) },
    400: errorContent("Validation failed: not an address."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const sendCodeRoute = createRoute({
  method: "post",
  path: "/account/email/code",
  summary: "Send a code to the caller's unconfirmed e-mail",
  description:
    "Six digits to the stored address, in the request's language (#385, ADR-043), replacing any code that waits, good for matching_config email_code_minutes and email_code_attempts. At most email_codes_per_day per Finnish day. Neither the address nor the code reaches a log line.",
  ...bearer,
  responses: {
    200: { description: "Sent; until when the code works.", ...json(AccountEmailResponse) },
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent(
      "email_none: no address is set; email_confirmed: the address is confirmed already.",
    ),
    429: errorContent(
      "email_code_budget_exceeded: the day's codes are sent; Retry-After is the wait until the day rolls.",
    ),
    503: errorContent(
      "mail_unavailable: no mail is sent in this environment, or the send failed; nothing was counted.",
    ),
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/account/email/confirm",
  summary: "Confirm the caller's e-mail with its code",
  description:
    "The six digits of the last code sent (#385, ADR-043). Right, the address is confirmed and the code goes; the same answer when it is confirmed already.",
  ...bearer,
  request: { body: { required: true, ...json(AccountEmailConfirmation) } },
  responses: {
    200: { description: "Confirmed.", ...json(AccountEmailResponse) },
    400: errorContent(
      "validation_failed: not six digits; email_code_wrong: not the code, and a try remains.",
    ),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent(
      "email_none: no address is set; email_code_none: no code waits (none sent, or the address changed); email_code_expired: past its minutes; email_code_spent: its last attempt was wrong.",
    ),
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
  const emailDeps: EmailDeps = {
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    ...(deps.mailer ? { mailer: deps.mailer } : {}),
  };
  const routes = [
    deleteRoute,
    exportRoute,
    pauseRoute,
    foundThemReadRoute,
    foundThemRoute,
    emailRoute,
    setEmailRoute,
    clearEmailRoute,
    sendCodeRoute,
    confirmRoute,
  ];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }

  app.openapi(emailRoute, async (c) =>
    c.json(await readEmail(emailDeps, callerOf(c).accountId), 200),
  );

  app.openapi(setEmailRoute, async (c) => {
    const { email } = c.req.valid("json");
    return c.json(await setAccountEmail(emailDeps, callerOf(c).accountId, email), 200);
  });

  app.openapi(clearEmailRoute, async (c) => {
    await setAccountEmail(emailDeps, callerOf(c).accountId, null);
    return c.body(null, 204);
  });

  app.openapi(sendCodeRoute, async (c) => {
    try {
      return c.json(await sendEmailCode(emailDeps, callerOf(c).accountId, tOf(c)), 200);
    } catch (error) {
      // The wait until the day rolls, as the export and the feedback say it.
      if (error instanceof AppError && error.code === "email_code_budget_exceeded") {
        const wait = (error.detail as { retryAfterSeconds?: number } | undefined)
          ?.retryAfterSeconds;
        c.header("Retry-After", String(wait ?? 1));
      }
      throw error;
    }
  });

  app.openapi(confirmRoute, async (c) => {
    const { code } = c.req.valid("json");
    return c.json(await confirmEmailCode(emailDeps, callerOf(c).accountId, code), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    c.req.valid("json"); // confirm: true, or the validator has answered 400
    await eraseAccount(erasureDeps, callerOf(c).accountId);
    return c.body(null, 204);
  });

  app.openapi(foundThemReadRoute, async (c) => {
    return c.json({ answered: await foundThemAnswered(deps.db, callerOf(c).accountId) }, 200);
  });

  app.openapi(foundThemRoute, async (c) => {
    const { reason } = c.req.valid("json");
    // The database, the logger and the clock the erasure uses: one fallback to the present.
    await tellFoundThem(erasureDeps, callerOf(c).accountId, reason);
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
    return c.body(archive.bytes, 200);
  });

  return app;
}
