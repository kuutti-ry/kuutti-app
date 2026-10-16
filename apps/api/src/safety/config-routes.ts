import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ConfigChange,
  ConfigChangeRequest,
  ConfigKeyParams,
  ConfigList,
  ErrorResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { staffOf } from "../lib/admin-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { changeConfig, listConfig } from "./config.ts";

// The tunables in the panel (#304, #305): admins read every key with its
// versions and write a new version with a reason. The log line names the key
// and the version, never the reason, which is an admin's words.

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
  path: "/admin/config",
  summary: "Every tunable with its versions",
  description:
    "Each key of matching_config with its latest value, which every reader uses, and its versions newest first: the value, from when, by whom and why. Admins only.",
  ...bearer,
  responses: { 200: { description: "The tunables.", ...json(ConfigList) }, ...staffErrors },
});

const changeRoute = createRoute({
  method: "post",
  path: "/admin/config/{key}",
  summary: "Change a tunable",
  description:
    "A new version of the key with the admin's reason, used from the next request on. The value keeps the current one's JSON type, and an object its keys. Keys are born in migrations. Admins only; written to audit_log.",
  ...bearer,
  request: { params: ConfigKeyParams, body: { required: true, ...json(ConfigChangeRequest) } },
  responses: {
    200: { description: "The row this change wrote.", ...json(ConfigChange) },
    400: errorContent(
      "Validation failed, or config_shape: the value changes the current one's type or keys.",
    ),
    ...staffErrors,
    404: errorContent("No such key."),
    409: errorContent("config_conflict: another admin changed the key meanwhile."),
  },
});

export function configAdminRoutes(deps: Deps, requireAdministrator: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  for (const route of [listRoute, changeRoute])
    app.use(route.getRoutingPath(), requireAdministrator);

  app.openapi(listRoute, async (c) => c.json({ items: await listConfig(deps.db) }, 200));

  app.openapi(changeRoute, async (c) => {
    const staff = staffOf(c);
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    const item = await changeConfig(deps.db, {
      key,
      value: body.value,
      reason: body.reason,
      actor: staff.identityId,
      at: now(),
    });
    deps.logger.info(
      { staffIdentityId: staff.identityId, key, version: item.version },
      "config changed",
    );
    return c.json(item, 200);
  });

  return app;
}
