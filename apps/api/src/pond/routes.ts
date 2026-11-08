import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  GateResponse,
  HomeSummary,
  HomeUpdate,
  PondCounterResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { readPondCounter } from "./counter.ts";
import { saveHome } from "./home.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const homeRoute = createRoute({
  method: "put",
  path: "/account/home",
  summary: "Set the caller's home, or what their card shows of it",
  description:
    "A postal code of five digits, whether the card shows the area instead of the town, or both. What is kept is a place of at least matching_config home_min_inhabitants people: the postal area, else its municipality, else the nearest municipality that has them. A new postal code starts from the town again unless the same request says otherwise, and showArea stays false where no area is kept. The home changes whenever the person likes. The write sets the account's pond if it has none. The answer names places and never carries digits.",
  ...bearer,
  request: { body: { required: true, ...json(HomeUpdate) } },
  responses: {
    200: { description: "Saved; the home as its owner reads it.", ...json(HomeSummary) },
    400: errorContent(
      "validation_failed, or postal_code_unknown: five digits the list lacks. Both constant, repeating nothing that was sent.",
    ),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

// The one public route that carries figures (#54, ADR-013): aggregates per
// pond, nothing below k, moving in steps of at least k people, no id but the
// pond's. The public site may read it from its allowlisted origin (rules/api.md).
// The app reads it with the person's session, which adds the one thing a
// session adds here, the bar of their own pond, and which is checked as on every
// other route (ADR-013 §18).
const counterRoute = createRoute({
  method: "get",
  path: "/ponds/counter",
  summary: "The pond counter",
  description:
    "Per pond: how many bank-verified people with the pond as theirs have completed their profiles. The number is published only where at least k people stand behind it (k is in the answer), and it moves only once at least k people have come or gone since it was last said. Counted once a day. No session needed. With one, the answer is the caller's and is not cached, and the caller's own pond also says whom its people seek: percentages in steps of five of three bands of finished profiles, those who seek men, those who seek both women and men, and those who seek women, null until every band holds at least k people.",
  security: [{}, { session: [] }],
  responses: {
    200: { description: "Every pond with what may be said of it.", ...json(PondCounterResponse) },
    401: errorContent(
      "A session was offered and does not stand: unauthenticated, session_expired or session_revoked. No session at all is the public answer.",
    ),
  },
});

// Whether matching is open for the caller (#500, ADR-060 §4): the person's
// alone, with nothing of anybody else in it.
const gateRoute = createRoute({
  method: "get",
  path: "/gate",
  summary: "Whether matching is open for the caller",
  description:
    "Between a finished profile and the first round: incomplete while the profile or onboarding lacks something, closed once it is finished and matching has not opened in the caller's pond yet, open once it has. An admin opens a pond; nothing here counts anybody.",
  ...bearer,
  responses: {
    200: { description: "What stands for the caller.", ...json(GateResponse) },
    401: unauthenticated,
  },
});

/**
 * How the route learns what stands for the caller. Handed in by the app:
 * completeness reads across slices and lives with the jobs (rules/layout.md),
 * and this slice does not import it.
 */
export type GateReader = (accountId: string) => Promise<GateResponse>;

/** The figures move at most once a day; an hour is short enough for the day's turn. */
export const POND_COUNTER_CACHE_CONTROL = "public, max-age=3600";

export function pondRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  readGate: GateReader,
) {
  const app = new OpenAPIHono<AppEnv>();
  const guarded = [homeRoute, gateRoute];
  for (const path of new Set(guarded.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }
  app.use(counterRoute.getRoutingPath(), (c, next) =>
    c.req.header("authorization") === undefined ? next() : requireSession(c, next),
  );

  app.openapi(gateRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await readGate(accountId), 200);
  });

  app.openapi(counterRoute, async (c) => {
    const accountId = c.get("accountId");
    // The read first, the header after it: a failure must not be answered as
    // something a cache may keep for an hour. A session's answer keeps the
    // guard's `no-store`: it holds that person's bar.
    const counter = await readPondCounter(deps.db, accountId);
    if (accountId === undefined) c.header("Cache-Control", POND_COUNTER_CACHE_CONTROL);
    c.header("Vary", "Authorization");
    return c.json(counter, 200);
  });

  app.openapi(homeRoute, async (c) => {
    const home = await saveHome(deps, callerOf(c).accountId, c.req.valid("json"));
    return c.json(home, 200);
  });

  return app;
}
