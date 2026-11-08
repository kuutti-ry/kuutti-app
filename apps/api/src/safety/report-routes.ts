import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  BlockRequest,
  ConversationParams,
  ConversationReportRequest,
  ErrorResponse,
  ReportRequest,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { REPORT_AFTER_CLOSE_DAYS_KEY } from "../chat/index.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { dayWindow, secondsUntil } from "../media/index.ts";
import { checkReports } from "./automatic.ts";
import { recordBlock, recordConversationBlock } from "./blocks.ts";
import { REPORTS_PER_DAY_KEY, recordConversationReport, recordReport } from "./reports.ts";

// A block and a report from a card (#84, ADR-030), and from a conversation
// (#351, ADR-030 §12). Both answer 204 whatever stood before, so neither
// tells the caller anything about the other person, and from a card both
// answer the same 404 for a card never shown, oneself and nobody.
// What a request names (the other account, the reason, the note, the photo
// or line it points at, #476) reaches no log line, no error detail and no
// research event (rule 5): the request line
// says that the caller did it, a refusal its code, and the cap's refusal how
// many and until when.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");
const notShown = errorContent(
  "not_found: no card of that account was shown to the caller and no block stands between the two accounts (never shown, oneself, nobody, a later account of somebody blocked), or the caller was erased meanwhile; nothing is written.",
);

const blockRoute = createRoute({
  method: "post",
  path: "/blocks",
  summary: "Block the person of a card one was shown",
  description:
    "From then on neither is shown to the other, in either direction, in any round, card, photo or pool. Between the two identities, so it holds for a later account of either; final. Nobody is told.",
  ...bearer,
  request: { body: { required: true, ...json(BlockRequest) } },
  responses: {
    204: {
      description: "The block stands: set now, set before, or set by the other first, alike.",
    },
    400: errorContent("Validation failed: a missing or malformed account id, an unknown key."),
    401: unauthenticated,
    404: notShown,
  },
});

const reportRoute = createRoute({
  method: "post",
  path: "/reports",
  summary: "Report the person of a card one was shown, and block them",
  description:
    "A reason from the closed list and, if the person likes, a few lines for the moderators, who read it in the panel, and the one photo of the card it is about (#476). The report blocks both ways in the same transaction. The reported person learns nothing. At most matching_config reports_per_day a day per account, the Finnish calendar day; one open report per pair.",
  ...bearer,
  request: { body: { required: true, ...json(ReportRequest) } },
  responses: {
    204: {
      description:
        "Filed and blocked; or a report of the same person is still open, and nothing more is written. A photo that is not one of the card the person was shown is left out, and the answer is the same.",
    },
    400: errorContent(
      "Validation failed: a missing or unknown reason, a note blank or over 500 characters, a malformed account or photo id, an unknown key.",
    ),
    401: unauthenticated,
    404: notShown,
    429: errorContent(
      "report_budget_exceeded: the day's reports are filed and nothing was written, the block neither; Retry-After is the wait until the day rolls.",
    ),
  },
});

const conversationNotFound = errorContent(
  "not_found: no such conversation for the caller (not theirs, nobody's, or hidden from the one who blocked the other), or the caller was erased meanwhile; nothing is written.",
);

const conversationBlockRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/block",
  summary: "Block the other person of a conversation",
  description:
    "The block both ways and the conversation's close in one transaction (#351): from then on the conversation is gone for the caller, who gets 404 for it from every other route, and ended for the other person, who is not told why. The block holds everywhere a card's does, between the identities, and is final. Blocking again answers the same, the conversation then hidden from the caller.",
  ...bearer,
  request: { params: ConversationParams },
  responses: {
    204: {
      description:
        "The block stands: set now, or set before; alike when the other person deleted their account meanwhile, and nothing is written.",
    },
    400: errorContent("validation_failed: the id is not a uuid."),
    401: unauthenticated,
    404: errorContent(
      "not_found: no such conversation for the caller (not theirs, or nobody's), or the caller was erased meanwhile; nothing is written.",
    ),
  },
});

const conversationReportRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/report",
  summary: "Report the other person of a conversation, with a copy of it, and block them",
  description:
    "The card's reason and note (#351, ADR-030 §12), and the line of the one photo it is about (#476). In one transaction: the report naming the conversation, a frozen copy of every message it holds now, both people's, for the moderators, who read it in the panel, the block both ways and the conversation's close. Taken while the conversation is open or archived, and for matching_config report_after_close_days after it closed, so a person blocked can still report what was said. At most matching_config reports_per_day a day, one open report per pair, as from a card. The reported person learns nothing.",
  ...bearer,
  request: {
    params: ConversationParams,
    body: { required: true, ...json(ConversationReportRequest) },
  },
  responses: {
    204: {
      description:
        "Filed, copied, blocked and closed; or a report of the same person is still open, and nothing more is written. A line that is not a photo the other person sent, as the reporter could read it, is left out, and the answer is the same.",
    },
    400: errorContent(
      "Validation failed: a missing or unknown reason, a note blank or over 500 characters, a line that is not a whole number from 1, an unknown key, an id that is not a uuid.",
    ),
    401: unauthenticated,
    404: conversationNotFound,
    409: errorContent(
      "report_window_closed: the conversation closed longer ago than report_after_close_days, or the other person deleted their account; nothing is written.",
    ),
    429: errorContent(
      "report_budget_exceeded: the day's reports are filed and nothing was written, the block neither; Retry-After is the wait until the day rolls.",
    ),
  },
});

export function reportRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  // The reports rule (#105, ADR-033) after a report is filed and committed;
  // it changes no answer, whatever it finds.
  const afterFiled = (reportedAccountId: string) =>
    checkReports({ db: deps.db, logger: deps.logger, now }, reportedAccountId);
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [blockRoute, reportRoute, conversationBlockRoute, conversationReportRoute]) {
    app.use(route.getRoutingPath(), guard);
  }

  /**
   * The cap's refusal, from a card or a conversation alike, logged with how
   * many and until when, never whom or why; the wait, for Retry-After.
   */
  const overBudget = (input: {
    accountId: string;
    used: number;
    limit: number;
    at: Date;
    end: Date;
  }): { retryAfterSeconds: number; error: AppError } => {
    const retryAfterSeconds = secondsUntil(input.end, input.at);
    deps.logger.warn(
      {
        accountId: input.accountId,
        used: input.used,
        limit: input.limit,
        retryAfterSeconds,
        refusal: "budget",
      },
      "report refused",
    );
    const error = new AppError(429, "report_budget_exceeded", "The day's reports are filed", {
      retryAfterSeconds,
    });
    return { retryAfterSeconds, error };
  };

  app.openapi(blockRoute, async (c) => {
    const { accountId } = callerOf(c);
    const body = c.req.valid("json");
    const set = await recordBlock(deps.db, {
      blockerAccountId: accountId,
      blockedAccountId: body.accountId,
      at: now(),
    });
    if (!set) throw new AppError(404, "not_found", "No such card");
    return c.body(null, 204);
  });

  app.openapi(reportRoute, async (c) => {
    const { accountId } = callerOf(c);
    const body = c.req.valid("json");
    const at = now();
    const day = dayWindow(at);
    const limit = await matchingConfigNumber(deps.db, REPORTS_PER_DAY_KEY);
    const record = await recordReport(deps.db, {
      reporterAccountId: accountId,
      reportedAccountId: body.accountId,
      reason: body.reason,
      note: body.note ?? null,
      photoId: body.photoId ?? null,
      at,
      since: day.start,
      limit,
    });
    if (record.outcome === "not_found") throw new AppError(404, "not_found", "No such card");
    if (record.outcome === "over_budget") {
      const refused = overBudget({ accountId, used: record.used, limit, at, end: day.end });
      c.header("Retry-After", String(refused.retryAfterSeconds));
      throw refused.error;
    }
    if (record.outcome === "filed") await afterFiled(record.reportedAccountId);
    return c.body(null, 204);
  });

  app.openapi(conversationBlockRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    const set = await recordConversationBlock(deps.db, {
      accountId,
      conversationId: id,
      at: now(),
    });
    if (set === "not_found") throw new AppError(404, "not_found", "No such conversation");
    return c.body(null, 204);
  });

  app.openapi(conversationReportRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const at = now();
    const day = dayWindow(at);
    const limit = await matchingConfigNumber(deps.db, REPORTS_PER_DAY_KEY);
    const record = await recordConversationReport(deps.db, {
      reporterAccountId: accountId,
      conversationId: id,
      reason: body.reason,
      note: body.note ?? null,
      seq: body.seq ?? null,
      at,
      since: day.start,
      limit,
      afterCloseDays: await matchingConfigNumber(deps.db, REPORT_AFTER_CLOSE_DAYS_KEY),
    });
    if (record.outcome === "not_found") {
      throw new AppError(404, "not_found", "No such conversation");
    }
    if (record.outcome === "window_closed") {
      throw new AppError(409, "report_window_closed", "The conversation can no longer be reported");
    }
    if (record.outcome === "over_budget") {
      const refused = overBudget({ accountId, used: record.used, limit, at, end: day.end });
      c.header("Retry-After", String(refused.retryAfterSeconds));
      throw refused.error;
    }
    if (record.outcome === "filed") await afterFiled(record.reportedAccountId);
    return c.body(null, 204);
  });

  return app;
}
