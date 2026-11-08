import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { transaction } from "@kuutti/db";
import {
  ErrorResponse,
  PhotoUrlResponse,
  ReportCopyPhotoParams,
  ReportDecision,
  ReportDecisionRequest,
  ReportDetail,
  ReportParams,
  ReportQueue,
  ReportQueueQuery,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { staffPhotoUrl } from "../media/index.ts";
import { recordAudit } from "./audit.ts";
import { MODERATION_RESPONSE_HOURS_KEY } from "./overview-routes.ts";
import {
  copyPhotoOf,
  decideReport,
  findReportSource,
  listReports,
  openReport,
  pointedPhotoKeyOf,
} from "./report-queue.ts";

// The panel's report queue (#311, TD-5) and one report worked to a decision
// (#312). Listing writes no audit row, as it shows neither the reporter's
// words nor the conversation. Opening a report, each look at a photo of its
// frozen copy or at the photo a card's report points at (#476), and the
// decision are audit rows about the report, never about a person, written
// before anything is shown or changed (ADR-030 §6, §12, §13).
// To a member of staff who is a party, every route answers as for a report
// that does not exist, and writes nothing. The words of the note and the copy
// reach the answer and nothing else: no log line, error detail or event
// (rule 5).

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const staffErrors = {
  401: errorContent("unauthenticated, session_expired or session_revoked."),
  403: errorContent("admin_forbidden: the role does not allow this."),
};
const noSuchReport = errorContent(
  "not_found: no such report, or one the reader is a party to, answered alike.",
);

const listRoute = createRoute({
  method: "get",
  path: "/admin/reports",
  summary: "The reports, for a moderator",
  description:
    "Open reports the oldest first, those about one account together, the group whose oldest waited longest first; or closed ones, the newest decision first. Each with its reason, where it was made, both account ids, the reporter's reports filed and upheld, and the reported account's reports received and sanctions. A report the reading member of staff is a party to is left out, and out of every count. With the API's clock and matching_config moderation_response_hours. Moderators and admins.",
  ...bearer,
  request: { query: ReportQueueQuery },
  responses: {
    200: { description: "A page of reports.", ...json(ReportQueue) },
    400: errorContent("Validation failed."),
    ...staffErrors,
  },
});

const openRoute = createRoute({
  method: "get",
  path: "/admin/reports/{id}",
  summary: "One report, with the reporter's note and the frozen conversation",
  description:
    "The queue's item, the reporter's note, the decision, the frozen copy of the conversation for a report made from one (null for a card's), the photo the report points at (#476: the copy's line, or a card's photo with its id and state, or removed since), and the sanctions that may close it while it waits. Written first to audit_log, about the report: conversation.view for a conversation's report, report.view for a card's; a look whose row cannot be written answers nothing of it. Moderators and admins.",
  ...bearer,
  request: { params: ReportParams },
  responses: {
    200: { description: "The report.", ...json(ReportDetail) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: noSuchReport,
  },
});

const photoRoute = createRoute({
  method: "get",
  path: "/admin/reports/{id}/copy/{seq}/photo",
  summary: "A signed URL for a photo of a report's frozen conversation",
  description:
    "The full variant of the photo the copy holds at that line, for fifteen minutes. Every issuance is a photo.view row about the report, written before the URL is signed. Moderators and admins.",
  ...bearer,
  request: { params: ReportCopyPhotoParams },
  responses: {
    200: { description: "The signed URL.", ...json(PhotoUrlResponse) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent(
      "not_found: no such report, a party's, or no photo at that line, answered alike.",
    ),
    503: errorContent("media_unavailable: no object storage is configured here."),
  },
});

const pointedPhotoRoute = createRoute({
  method: "get",
  path: "/admin/reports/{id}/photo",
  summary: "A signed URL for the photo a card's report points at",
  description:
    "The card variant of the one photo of the card the reporter pointed at (#476), for fifteen minutes. Every issuance is a photo.view row about the report, written before the URL is signed. Moderators and admins.",
  ...bearer,
  request: { params: ReportParams },
  responses: {
    200: { description: "The signed URL.", ...json(PhotoUrlResponse) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent(
      "not_found: no such report, a party's, one that points at no photo, or a photo removed since, answered alike.",
    ),
    503: errorContent("media_unavailable: no object storage is configured here."),
  },
});

const decisionRoute = createRoute({
  method: "post",
  path: "/admin/reports/{id}/decision",
  summary: "Decide a report",
  description:
    "Dismissed, or acted on naming the sanction applied for it: one on the reported account, or a ban of its identity, at or after the filing, applied by a person or applied by an automatic rule and kept by a person on review (#105). Once; written to audit_log as report.decide. Tells nobody. Moderators and admins.",
  ...bearer,
  request: {
    params: ReportParams,
    body: { required: true, ...json(ReportDecisionRequest) },
  },
  responses: {
    200: { description: "The decision.", ...json(ReportDecision) },
    400: errorContent("Validation failed: acted without a sanction, or dismissed with one."),
    ...staffErrors,
    404: noSuchReport,
    409: errorContent(
      "report_decided: decided already; sanction_not_for_report: the sanction does not answer this report.",
    ),
  },
});

export function reportAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  for (const route of [listRoute, openRoute, photoRoute, pointedPhotoRoute, decisionRoute]) {
    app.use(route.getRoutingPath(), requireModerator);
  }
  const notFound = () => new AppError(404, "not_found", "No such report");

  app.openapi(listRoute, async (c) => {
    const staff = staffOf(c);
    const query = c.req.valid("query");
    const [page, responseHours] = await Promise.all([
      listReports(deps.db, staff.identityId, query),
      matchingConfigNumber(deps.db, MODERATION_RESPONSE_HOURS_KEY),
    ]);
    return c.json({ now: now().toISOString(), responseHours, ...page }, 200);
  });

  app.openapi(openRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    // The audit row and the read are one unit: the row is written before the
    // note or the copy is read, and the answer goes after the commit.
    const report = await transaction(deps.db, async (tx) => {
      const source = await findReportSource(tx, staff.identityId, id);
      if (!source) throw notFound();
      await recordAudit(tx, {
        actorIdentityId: staff.identityId,
        action: source === "conversation" ? "conversation.view" : "report.view",
        subjectType: "report",
        subjectId: id,
      });
      // Gone between the two reads (the night's prune): the audit row goes with the refusal.
      const opened = await openReport(tx, staff.identityId, id);
      if (!opened) throw notFound();
      return opened;
    });
    deps.logger.info(
      { staffIdentityId: staff.identityId, reportId: id, source: report.source },
      "report opened",
    );
    return c.json(report, 200);
  });

  app.openapi(photoRoute, async (c) => {
    const staff = staffOf(c);
    const { id, seq } = c.req.valid("param");
    // Asked before anything is read, so the answer is the same for everybody.
    if (!deps.media) {
      throw new AppError(503, "media_unavailable", "Object storage is not configured here");
    }
    const held = await copyPhotoOf(deps.db, staff.identityId, id, seq);
    if (!held) throw notFound();
    const at = now();
    // The audit row first: a look whose row could not be written does not happen.
    await recordAudit(deps.db, {
      actorIdentityId: staff.identityId,
      action: "photo.view",
      subjectType: "report",
      subjectId: id,
      detail: { seq, variant: "full" },
    });
    const answer = await staffPhotoUrl(deps.media.signer, held.key, "full", at);
    // Every issuance logged with its photo, as the card route's (rules/api.md);
    // the answer itself carries no photo id.
    deps.logger.info(
      {
        staffIdentityId: staff.identityId,
        reportId: id,
        seq,
        photoId: held.photoId,
        variant: "full",
        at,
      },
      "staff report photo view",
    );
    return c.json(answer, 200);
  });

  app.openapi(pointedPhotoRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    // Asked before anything is read, so the answer is the same for everybody.
    if (!deps.media) {
      throw new AppError(503, "media_unavailable", "Object storage is not configured here");
    }
    const held = await pointedPhotoKeyOf(deps.db, staff.identityId, id);
    if (!held) throw notFound();
    const at = now();
    // The audit row first, about the report as the copy's photos are (ADR-030 §9).
    await recordAudit(deps.db, {
      actorIdentityId: staff.identityId,
      action: "photo.view",
      subjectType: "report",
      subjectId: id,
      detail: { variant: "card" },
    });
    const answer = await staffPhotoUrl(deps.media.signer, held.key, "card", at);
    deps.logger.info(
      {
        staffIdentityId: staff.identityId,
        reportId: id,
        photoId: held.photoId,
        variant: "card",
        at,
      },
      "staff report photo view",
    );
    return c.json(answer, 200);
  });

  app.openapi(decisionRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const decision = c.req.valid("json");
    const decided = await transaction(deps.db, (tx) =>
      decideReport(tx, { staffIdentityId: staff.identityId, id, decision, at: now() }),
    );
    deps.logger.info(
      {
        staffIdentityId: staff.identityId,
        reportId: id,
        outcome: decided.outcome,
        sanctionId: decided.sanctionId,
      },
      "report decided",
    );
    return c.json(decided, 200);
  });

  return app;
}
