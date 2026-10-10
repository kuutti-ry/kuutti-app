import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  DealBreakersResponse,
  DealBreakersUpdate,
  ErrorResponse,
  PreferencesResponse,
  PreferencesUpdate,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import {
  dealBreakersMax,
  type OwnFieldsReader,
  readDealBreakers,
  saveDealBreakers,
} from "./deal-breakers.ts";
import { readPreferences, savePreferences } from "./preferences.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const readRoute = createRoute({
  method: "get",
  path: "/preferences",
  summary: "Whom the caller seeks and the age window",
  description:
    "The two hard filters of rule 7 as the person set them; null until onboarding sets them.",
  ...bearer,
  responses: {
    200: { description: "The preferences.", ...json(PreferencesResponse) },
    401: unauthenticated,
  },
});

const saveRoute = createRoute({
  method: "put",
  path: "/preferences",
  summary: "Set whom the caller seeks, the age window, or both",
  description:
    "Either or both, each replacing its row: a non-empty set of genders, an age window within 18 and 99 with min at most max. Onboarding saves each on its own screen (ADR-010 §13). Hard rows: the round builder never crosses them, in either direction.",
  ...bearer,
  request: { body: { required: true, ...json(PreferencesUpdate) } },
  responses: {
    200: { description: "Saved; the preferences as stored.", ...json(PreferencesResponse) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const dealBreakersRoute = createRoute({
  method: "get",
  path: "/preferences/deal-breakers",
  summary: "The caller's deal-breakers",
  description:
    "Each with whether it is paused: a deal-breaker waits while the person's own answer on its field is missing (#149, the disclose-to-filter rule). `max` is how many a person may have.",
  ...bearer,
  responses: {
    200: { description: "The deal-breakers.", ...json(DealBreakersResponse) },
    401: unauthenticated,
  },
});

const saveDealBreakersRoute = createRoute({
  method: "put",
  path: "/preferences/deal-breakers",
  summary: "Set the caller's deal-breakers",
  description:
    "The whole set, at most `max`, each on a distinct whitelisted field the person has answered themselves, accepting options the field has. Hard rows: #87 applies them in the pool, both ways.",
  ...bearer,
  request: { body: { required: true, ...json(DealBreakersUpdate) } },
  responses: {
    200: { description: "Saved; the deal-breakers as stored.", ...json(DealBreakersResponse) },
    400: errorContent(
      "Validation failed: more than allowed, a field twice, or an answer the field has not.",
    ),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent(
      "filter_unanswered: a deal-breaker on a field the person has not answered themselves (the log names the field, the screen knows it).",
    ),
  },
});

/** `readOwnFields` hands in the caller's own profile answers; the app wires it from the profile slice. */
export function preferencesRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  readOwnFields: OwnFieldsReader,
) {
  const app = new OpenAPIHono<AppEnv>();
  const routes = [readRoute, saveRoute, dealBreakersRoute, saveDealBreakersRoute];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }
  const dealBreakersOf = async (accountId: string) => ({
    dealBreakers: await readDealBreakers(deps.db, accountId, await readOwnFields(accountId)),
    max: await dealBreakersMax(deps.db),
  });

  app.openapi(dealBreakersRoute, async (c) => {
    return c.json(await dealBreakersOf(callerOf(c).accountId), 200);
  });

  app.openapi(saveDealBreakersRoute, async (c) => {
    const { accountId } = callerOf(c);
    const own = await readOwnFields(accountId);
    const max = await dealBreakersMax(deps.db);
    if (!(await saveDealBreakers(deps.db, accountId, c.req.valid("json"), own, max, new Date()))) {
      throw new AppError(404, "not_found", "No live account");
    }
    // The fields and values stay out of the log (rule 5): how many, and nothing else.
    deps.logger.info(
      { accountId, dealBreakers: c.req.valid("json").dealBreakers.length },
      "deal-breakers saved",
    );
    return c.json(await dealBreakersOf(accountId), 200);
  });

  app.openapi(readRoute, async (c) => {
    return c.json(await readPreferences(deps.db, callerOf(c).accountId), 200);
  });

  app.openapi(saveRoute, async (c) => {
    const update = c.req.valid("json");
    const { accountId } = callerOf(c);
    if (!(await savePreferences(deps.db, accountId, update, new Date()))) {
      throw new AppError(404, "not_found", "No live account");
    }
    // The values stay out of the log (rule 5): this line says only that they were set.
    deps.logger.info({ accountId }, "preferences saved");
    return c.json(await readPreferences(deps.db, accountId), 200);
  });

  return app;
}
