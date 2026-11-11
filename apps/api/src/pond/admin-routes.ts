import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { transaction } from "@kuutti/db";
import { AdminPond, AdminPondList, PondIdParams, PondMatchingChange } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { bearer, errorContent, json, staffErrors } from "../lib/openapi.ts";
import { recordAudit } from "../safety/index.ts";
import { listPondsForAdmin, setMatchingOpen } from "./repo.ts";

// The switch of a pond in the panel (#500, ADR-060 §1, §2): matching opens in
// a pond when an admin says so, and nothing else opens or closes it. The audit
// row is the history of when each pond opened and closed; it carries which way
// and no words, and no person is named by it.

const listRoute = createRoute({
  method: "get",
  path: "/admin/ponds",
  summary: "Every pond with its switch",
  description: "Each pond and whether matching is open in it. Admins only.",
  ...bearer,
  responses: { 200: { description: "The ponds.", ...json(AdminPondList) }, ...staffErrors },
});

const matchingRoute = createRoute({
  method: "post",
  path: "/admin/ponds/{id}/matching",
  summary: "Open or close matching in a pond",
  description:
    "Sets the switch of the one pond, which stands for the whole country (ADR-061 §8). Open, each complete person reads their queue from their next read, and their matching card says so; closed, nobody new joins a queue, cards already queued stay for the day, and conversations go on (ADR-060, ADR-062). Nothing else turns it. A press that finds the switch as it asks changes nothing and writes nothing. Admins only; written to audit_log.",
  ...bearer,
  request: { params: PondIdParams, body: { required: true, ...json(PondMatchingChange) } },
  responses: {
    200: { description: "The pond as it now stands.", ...json(AdminPond) },
    400: errorContent("Validation failed."),
    ...staffErrors,
    404: errorContent("No such pond."),
  },
});

export function pondAdminRoutes(deps: Deps, requireAdministrator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  for (const route of [listRoute, matchingRoute]) {
    app.use(route.getRoutingPath(), requireAdministrator);
  }

  app.openapi(listRoute, async (c) => c.json({ items: await listPondsForAdmin(deps.db) }, 200));

  app.openapi(matchingRoute, async (c) => {
    const staff = staffOf(c);
    const { id } = c.req.valid("param");
    const { open } = c.req.valid("json");
    const result = await transaction(deps.db, async (tx) => {
      const set = await setMatchingOpen(tx, id, open);
      if (!set) throw new AppError(404, "not_found", "No such pond");
      if (set.changed) {
        await recordAudit(tx, {
          actorIdentityId: staff.identityId,
          action: "pond.matching",
          subjectType: "pond",
          subjectId: id,
          detail: { open },
        });
      }
      return set;
    });
    if (result.changed) {
      deps.logger.info({ staffIdentityId: staff.identityId, pondId: id, open }, "pond matching");
    }
    return c.json(result.pond, 200);
  });

  return app;
}
