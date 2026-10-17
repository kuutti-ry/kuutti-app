import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { BlockRequest, ErrorResponse, ReportRequest } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { dayWindow, secondsUntil } from "../media/index.ts";
import { recordBlock } from "./blocks.ts";
import { REPORTS_PER_DAY_KEY, recordReport } from "./reports.ts";

// A block and a report from a card (#84, ADR-030). Both answer 204 whatever
// stood before, so neither tells the caller anything about the other person,
// and both answer the same 404 for a card never shown, oneself and nobody.
// What a request names (the other account, the reason, the note) reaches no
// log line, no error detail and no research event (rule 5): the request line
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
    "A reason from the closed list and, if the person likes, a few lines for the moderators, who read it in the panel. The report blocks both ways in the same transaction. The reported person learns nothing. At most matching_config reports_per_day a day per account, the Finnish calendar day; one open report per pair.",
  ...bearer,
  request: { body: { required: true, ...json(ReportRequest) } },
  responses: {
    204: {
      description:
        "Filed and blocked; or a report of the same person is still open, and nothing more is written.",
    },
    400: errorContent(
      "Validation failed: a missing or unknown reason, a note blank or over 500 characters, a malformed account id, an unknown key.",
    ),
    401: unauthenticated,
    404: notShown,
    429: errorContent(
      "report_budget_exceeded: the day's reports are filed and nothing was written, the block neither; Retry-After is the wait until the day rolls.",
    ),
  },
});

export function reportRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [blockRoute, reportRoute]) app.use(route.getRoutingPath(), guard);

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
      at,
      since: day.start,
      limit,
    });
    if (record.outcome === "not_found") throw new AppError(404, "not_found", "No such card");
    if (record.outcome === "over_budget") {
      const retryAfterSeconds = secondsUntil(day.end, at);
      // How many and until when, never whom or why.
      deps.logger.warn(
        { accountId, used: record.used, limit, retryAfterSeconds, refusal: "budget" },
        "report refused",
      );
      c.header("Retry-After", String(retryAfterSeconds));
      throw new AppError(429, "report_budget_exceeded", "The day's reports are filed", {
        retryAfterSeconds,
      });
    }
    return c.body(null, 204);
  });

  return app;
}
