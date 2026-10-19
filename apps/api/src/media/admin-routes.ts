import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { transaction } from "@kuutti/db";
import {
  ErrorResponse,
  PhotoDecisionRequest,
  PhotoDecisionResponse,
  PhotoParams,
  PhotoReviewQueue,
  PhotoReviewQueueQuery,
  PhotoUrlResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { recordAudit, withdrawPhotoCheckNote } from "../safety/index.ts";
import { groupOf } from "./label-groups.ts";
import { isTipSignal, readThresholds } from "./moderation.ts";
import type { MediaDeps } from "./photos.ts";
import * as repo from "./repo.ts";
import { staffPhotoUrl } from "./urls.ts";

// The photo review queue (#49, rules/admin.md): what a moderator sees and
// decides. Every route sits behind requireAdmin with the moderator and admin
// roles; every photo a member of staff looks at and every decision is an
// audit_log row before anything is served or changed (security checklist line
// 67). Staff see the card variant only, through the same short-lived signed
// URL as everyone else.

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

const queueRoute = createRoute({
  method: "get",
  path: "/admin/photos/queue",
  summary: "Photos waiting for a person's decision",
  description:
    "Oldest first, with what the automatic check saw: labels with confidences, faces, what was flagged.",
  ...bearer,
  request: { query: PhotoReviewQueueQuery },
  responses: {
    200: { description: "The queue.", ...json(PhotoReviewQueue) },
    400: errorContent("Validation failed."),
    ...staffErrors,
  },
});

const cardRoute = createRoute({
  method: "get",
  path: "/admin/photos/{id}/card",
  summary: "A signed URL for the card variant, for review",
  description:
    "Any photo, any state. Every issuance is an audit_log row naming the member of staff.",
  ...bearer,
  request: { params: PhotoParams },
  responses: {
    200: { description: "The URL and when it stops working.", ...json(PhotoUrlResponse) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent("No such photo."),
    503: errorContent("media_unavailable: no object storage is configured here."),
  },
});

const decisionRoute = createRoute({
  method: "post",
  path: "/admin/photos/{id}/decision",
  summary: "Approve or reject a photo",
  description:
    "approve makes the photo visible to others; reject hides it and tells the owner the reason in words. Only a queued photo takes a decision, once. Only a person rejects. Written to audit_log.",
  ...bearer,
  request: { params: PhotoParams, body: { required: true, ...json(PhotoDecisionRequest) } },
  responses: {
    200: { description: "The photo's new state.", ...json(PhotoDecisionResponse) },
    400: errorContent("Validation failed (a rejection without a reason, for example)."),
    ...staffErrors,
    404: errorContent("No such photo."),
    409: errorContent(
      "photo_not_queued: the photo is not waiting for a decision (already decided, or still being checked).",
    ),
  },
});

export function photoAdminRoutes(deps: Deps, requireModerator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => new Date();

  const media = (): MediaDeps => {
    if (!deps.media) {
      throw new AppError(503, "media_unavailable", "Object storage is not configured here");
    }
    return deps.media;
  };

  const paths = new Set([queueRoute, cardRoute, decisionRoute].map((r) => r.getRoutingPath()));
  for (const path of paths) app.use(path, requireModerator);

  app.openapi(queueRoute, async (c) => {
    const { limit } = c.req.valid("query");
    const [items, total, lines] = await Promise.all([
      repo.listQueue(deps.db, limit),
      repo.countQueue(deps.db),
      readThresholds(deps.db),
    ]);
    // Blurred in the panel until a tap: a hard label at or above its review line (#253).
    const sensitive = (labels: (typeof items)[number]["labels"]) =>
      labels.some((label) => {
        const group = groupOf(label.name);
        return (
          group !== undefined &&
          group !== "allowed" &&
          label.confidence >= lines.groups[group].review
        );
      });
    // What the check decided on; the tip signals stored beside it are the owner's (#56).
    const shown = (item: (typeof items)[number]) => ({
      ...item,
      labels: item.labels.filter((label) => !isTipSignal(label.name)),
      sensitive: sensitive(item.labels),
    });
    return c.json({ items: items.map(shown), total }, 200);
  });

  app.openapi(cardRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const { signer } = media();
    const photo = await repo.findPhotoForStaff(deps.db, id);
    if (!photo) throw new AppError(404, "not_found", "No such photo");
    const at = now();
    // The audit row first: a view whose row could not be written does not happen.
    await recordAudit(deps.db, {
      actorIdentityId: staff.identityId,
      action: "photo.view",
      subjectType: "photo",
      subjectId: id,
      detail: { variant: "card", state: photo.state },
    });
    const answer = await staffPhotoUrl(signer, photo.key, "card", at);
    deps.logger.info(
      { staffIdentityId: staff.identityId, photoId: id, variant: "card", at },
      "staff photo view",
    );
    return c.json(answer, 200);
  });

  app.openapi(decisionRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const before = await repo.findPhotoForStaff(deps.db, id);
    if (!before) throw new AppError(404, "not_found", "No such photo");
    const notQueued = () =>
      new AppError(409, "photo_not_queued", "Only a queued photo takes a decision");
    if (before.state !== "queued") throw notQueued();
    const decision = body.decision === "approve" ? "approved" : "rejected";
    const reason = body.decision === "reject" ? body.reason : null;
    // The audit row and the decision are one unit: neither exists without the
    // other. The update is keyed on the queued state, so of two moderators
    // deciding at once exactly one writes, and the other's audit row is
    // rolled back with the refusal.
    const row = await transaction(deps.db, async (tx) => {
      await recordAudit(tx, {
        actorIdentityId: staff.identityId,
        action: body.decision === "approve" ? "photo.approve" : "photo.reject",
        subjectType: "photo",
        subjectId: id,
        detail: { from: before.state, to: decision, reason },
      });
      const updated = await repo.decidePhoto(tx, {
        photoId: id,
        decision,
        reason,
        decidedBy: staff.identityId,
        at: now(),
      });
      if (!updated) throw notQueued();
      // Approved on appeal: the check was wrong, and its note goes (#253).
      if (decision === "approved") {
        await withdrawPhotoCheckNote(tx, { accountId: before.accountId, photoId: id });
      }
      return updated;
    });
    deps.logger.info(
      { staffIdentityId: staff.identityId, photoId: id, from: before.state, to: decision, reason },
      "photo decided",
    );
    return c.json({ photoId: row.id, state: row.state, rejectionReason: row.rejectionReason }, 200);
  });

  return app;
}
