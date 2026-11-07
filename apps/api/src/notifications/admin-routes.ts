import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AdminAnnouncement,
  AdminAnnouncementList,
  AnnouncementDraft,
  AnnouncementParams,
  ErrorResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import {
  approveAnnouncement,
  deleteAnnouncement,
  listForAdmin,
  writeAnnouncement,
} from "./announcements.ts";
import type { Push } from "./push.ts";

// Announcements in the panel (#573, ADR-068 §2): admins only. One admin
// writes it, another approves it, and the approval sends it to everybody;
// before then either may delete it. Each act is an audit row with no words.

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

const listRoute = createRoute({
  method: "get",
  path: "/admin/announcements",
  summary: "The newest announcements, and how many one would reach",
  description:
    "The newest 50, drafts and sent alike, each in its languages and whether the caller wrote it, which is who may not approve it; never who wrote or approved it, which the audit log says. With them how many an announcement approved now reaches: every account that is not erased gets its notice, the people with the announcements switch on and a live device its push, and the confirmed addresses with the switch on its email. Admins only.",
  ...bearer,
  responses: {
    200: { description: "The announcements.", ...json(AdminAnnouncementList) },
    ...staffErrors,
  },
});

const writeRoute = createRoute({
  method: "post",
  path: "/admin/announcements",
  summary: "Write an announcement",
  description:
    "A draft in English and Finnish, and in Swedish or not at all: each a title of at most 80 characters and a body of at most 1,000, trimmed, never empty, and with no address, link, phone number or handle (the plain-text rule). Nothing is sent until another admin approves it. Admins only; written to audit_log with no words.",
  ...bearer,
  request: { body: { required: true, ...json(AnnouncementDraft) } },
  responses: {
    201: { description: "The draft.", ...json(AdminAnnouncement) },
    400: errorContent(
      "validation_failed, or text_contact_details naming the language and what was found.",
    ),
    ...staffErrors,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/admin/announcements/{id}",
  summary: "Delete a draft",
  description:
    "Any admin may delete an announcement that has not been approved; one that went to everybody stays. Admins only; written to audit_log.",
  ...bearer,
  request: { params: AnnouncementParams },
  responses: {
    204: { description: "Deleted." },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent("No such announcement."),
    409: errorContent("announcement_sent: it went to everybody already."),
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/admin/announcements/{id}/approve",
  summary: "Approve an announcement, which sends it to everybody",
  description:
    "The second admin's approval: never the one who wrote it, and once. In the same transaction every account that is not erased gets the announcement as a notice in the app; after the answer, the confirmed addresses whose switch is on get it by email, and the people whose notice is still unread and whose switch is on get a push in the app's own words, or once the quiet hours end. Nothing takes it back. Admins only; written to audit_log with how many notices it wrote.",
  ...bearer,
  request: { params: AnnouncementParams },
  responses: {
    200: { description: "The announcement, sent.", ...json(AdminAnnouncement) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent("No such announcement."),
    409: errorContent(
      "own_announcement: the caller wrote it; announcement_sent: it went to everybody already.",
    ),
  },
});

export function announcementAdminRoutes(
  deps: Deps,
  requireAdministrator: MiddlewareHandler<AppEnv>,
  push: Push,
) {
  const app = new OpenAPIHono<AppEnv>();
  const now = deps.now ?? (() => new Date());
  // The list and the write share a path: each path is guarded once.
  const paths = new Set(
    [listRoute, writeRoute, deleteRoute, approveRoute].map((route) => route.getRoutingPath()),
  );
  for (const path of paths) app.use(path, requireAdministrator);

  app.openapi(listRoute, async (c) => {
    const staff = staffOf(c);
    return c.json(await listForAdmin({ db: deps.db, now }, staff.identityId), 200);
  });

  app.openapi(writeRoute, async (c) => {
    const staff = staffOf(c);
    const written = await writeAnnouncement(
      { db: deps.db, now },
      { draft: c.req.valid("json"), staffIdentityId: staff.identityId },
    );
    deps.logger.info(
      { staffIdentityId: staff.identityId, announcementId: written.id },
      "announcement written",
    );
    return c.json(written, 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    await deleteAnnouncement({ db: deps.db }, { id, staffIdentityId: staff.identityId });
    deps.logger.info(
      { staffIdentityId: staff.identityId, announcementId: id },
      "announcement deleted",
    );
    return c.body(null, 204);
  });

  app.openapi(approveRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const { announcement, notices } = await approveAnnouncement(
      { db: deps.db, now },
      { id, staffIdentityId: staff.identityId },
    );
    deps.logger.info(
      { staffIdentityId: staff.identityId, announcementId: id, notices },
      "announcement approved",
    );
    // After the commit, and after the answer: the email and the push (ADR-068 §4, §5).
    push.announcement({ announcementId: id });
    return c.json(announcement, 200);
  });

  return app;
}
