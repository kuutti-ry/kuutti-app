import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  BanRequest,
  ErrorResponse,
  Sanction,
  SanctionAccountParams,
  SanctionList,
  SanctionParams,
  SanctionRequest,
  SanctionReviewRequest,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import {
  applySanction,
  liftSanction,
  listSanctions,
  reviewSanction,
  type SanctionScope,
} from "./sanctions.ts";

// The panel's sanctions (#307, ADR-024 §3): warn, shadow-ban and suspend for
// moderators and admins; a ban, its lift and its review on routes of their
// own for admins, so the role is the guard's and never the handler's. The log
// lines carry ids, the kind and the reason, never staff's note.

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
const validation = errorContent("Validation failed.");

const listRoute = createRoute({
  method: "get",
  path: "/admin/accounts/{id}/sanctions",
  summary: "A person's sanctions",
  description:
    "Newest first: the account's own and the identity's bans set on any of its accounts, with staff's notes and who did what by identity id.",
  ...bearer,
  request: { params: SanctionAccountParams },
  responses: {
    200: { description: "The sanctions.", ...json(SanctionList) },
    400: validation,
    ...staffErrors,
    404: errorContent("No such account."),
  },
});

const applyRoute = createRoute({
  method: "post",
  path: "/admin/accounts/{id}/sanctions",
  summary: "Warn, shadow-ban or suspend a person",
  description:
    "A reason from the closed list and a note of at most 500 characters; a suspension also its end, a day after today in Finland and at most 366 days ahead. A suspension ends every session. A ban is POST /admin/accounts/{id}/bans, for admins.",
  ...bearer,
  request: { params: SanctionAccountParams, body: { required: true, ...json(SanctionRequest) } },
  responses: {
    201: { description: "Applied.", ...json(Sanction) },
    400: errorContent(
      "Validation failed, or ends_on_invalid: the end is not after today or too far ahead.",
    ),
    ...staffErrors,
    404: errorContent("No such account."),
    409: errorContent(
      "account_deleted: only a ban binds an erased account; staff_target: a member of staff loses the role first.",
    ),
  },
});

const banRoute = createRoute({
  method: "post",
  path: "/admin/accounts/{id}/bans",
  summary: "Ban a person",
  description:
    "Admins only. On the identity, for good until an admin lifts it: every session ends, the bank login is refused, and no new account is possible. An erased account's identity can be banned too.",
  ...bearer,
  request: { params: SanctionAccountParams, body: { required: true, ...json(BanRequest) } },
  responses: {
    201: { description: "Banned.", ...json(Sanction) },
    400: validation,
    ...staffErrors,
    404: errorContent("No such account."),
    409: errorContent("staff_target: a member of staff loses the role first."),
  },
});

const liftRoute = (scope: SanctionScope) =>
  createRoute({
    method: "post",
    path: scope === "ban" ? "/admin/bans/{id}/lift" : "/admin/sanctions/{id}/lift",
    summary: scope === "ban" ? "Lift a ban" : "Lift a warning, a shadow ban or a suspension",
    description:
      "The account is settled from what is still open; no session comes back, the person signs in again. Written to audit_log.",
    ...bearer,
    request: { params: SanctionParams },
    responses: {
      200: { description: "Lifted.", ...json(Sanction) },
      400: validation,
      ...staffErrors,
      404: errorContent(
        scope === "ban"
          ? "No such ban."
          : "No such sanction here (a ban is lifted on its own route).",
      ),
      409: errorContent(
        "sanction_lifted: already lifted; own_account: nobody lifts a sanction on themselves.",
      ),
    },
  });

const reviewRoute = (scope: SanctionScope) =>
  createRoute({
    method: "post",
    path: scope === "ban" ? "/admin/bans/{id}/review" : "/admin/sanctions/{id}/review",
    summary: scope === "ban" ? "Look at a ban again" : "Look at a sanction again",
    description:
      "A second member of staff's note, and keep or lift. Somebody other than who applied it; once. Written to audit_log.",
    ...bearer,
    request: { params: SanctionParams, body: { required: true, ...json(SanctionReviewRequest) } },
    responses: {
      200: { description: "Looked at.", ...json(Sanction) },
      400: validation,
      ...staffErrors,
      404: errorContent(
        scope === "ban"
          ? "No such ban."
          : "No such sanction here (a ban is reviewed on its own route).",
      ),
      409: errorContent(
        "own_sanction: applied by the same person; own_account: a sanction on the reviewer; sanction_reviewed: looked at already; sanction_lifted: a lift of a lifted one.",
      ),
    },
  });

export function sanctionAdminRoutes(
  deps: Deps,
  requireModerator: MiddlewareHandler<AppEnv>,
  requireAdministrator: MiddlewareHandler<AppEnv>,
) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  const lift = { other: liftRoute("other"), ban: liftRoute("ban") };
  const review = { other: reviewRoute("other"), ban: reviewRoute("ban") };
  // On each routing path itself, which app.test.ts holds every guarded route
  // to; the list and the apply share one path and one guard.
  const moderated = new Set(
    [listRoute, applyRoute, lift.other, review.other].map((r) => r.getRoutingPath()),
  );
  for (const path of moderated) app.use(path, requireModerator);
  for (const route of [banRoute, lift.ban, review.ban]) {
    app.use(route.getRoutingPath(), requireAdministrator);
  }

  app.openapi(listRoute, async (c) => {
    const { id } = c.req.valid("param");
    const items = await listSanctions(deps.db, id);
    if (!items) throw new AppError(404, "not_found", "No such account");
    return c.json({ items }, 200);
  });

  const applied = (staffIdentityId: string, item: Sanction) =>
    deps.logger.info(
      {
        staffIdentityId,
        accountId: item.accountId,
        sanctionId: item.id,
        kind: item.kind,
        reason: item.reason,
      },
      "sanction applied",
    );

  app.openapi(applyRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const item = await applySanction(deps.db, {
      accountId: id,
      kind: body.kind,
      reason: body.reason,
      note: body.note,
      ...(body.kind === "suspend" ? { endsOn: body.endsOn } : {}),
      actor: staff.identityId,
      at: now(),
    });
    applied(staff.identityId, item);
    return c.json(item, 201);
  });

  app.openapi(banRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const item = await applySanction(deps.db, {
      accountId: id,
      kind: "ban",
      reason: body.reason,
      note: body.note,
      actor: staff.identityId,
      at: now(),
    });
    applied(staff.identityId, item);
    return c.json(item, 201);
  });

  for (const scope of ["other", "ban"] as const) {
    app.openapi(lift[scope], async (c) => {
      const staff = staffOf(c);
      const { id } = c.req.valid("param");
      const item = await liftSanction(deps.db, {
        sanctionId: id,
        scope,
        actor: staff.identityId,
        at: now(),
      });
      deps.logger.info(
        {
          staffIdentityId: staff.identityId,
          accountId: item.accountId,
          sanctionId: id,
          kind: item.kind,
        },
        "sanction lifted",
      );
      return c.json(item, 200);
    });

    app.openapi(review[scope], async (c) => {
      const staff = staffOf(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await reviewSanction(deps.db, {
        sanctionId: id,
        scope,
        actor: staff.identityId,
        note: body.note,
        outcome: body.outcome,
        at: now(),
      });
      deps.logger.info(
        {
          staffIdentityId: staff.identityId,
          accountId: item.accountId,
          sanctionId: id,
          kind: item.kind,
          outcome: body.outcome,
        },
        "sanction reviewed",
      );
      return c.json(item, 200);
    });
  }

  return app;
}
