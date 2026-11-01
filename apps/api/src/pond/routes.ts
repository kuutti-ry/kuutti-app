import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  GateResponse,
  HomeSummary,
  HomeUpdate,
  PondSeeksResponse,
  WaitlistResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { saveHome } from "./home.ts";
import { readPondSeeks, readWaitlist } from "./waitlist.ts";

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
// pond's. The waitlist site reads it from its allowlisted origin
// (rules/api.md); the app reads it for the person's own pond.
const waitlistRoute = createRoute({
  method: "get",
  path: "/waitlist",
  summary: "The waitlist counter",
  description:
    "Per pond: bank-verified people waiting, their split by self-declared gender, and how many are finishing their profile. A number is published only where at least k people stand behind it (k is in the answer), the split only when every cell is at least k, and a pond's numbers move only once at least k people have come or gone since they were last said. Counted once a day. No session needed.",
  responses: {
    200: { description: "Every pond with what may be said of it.", ...json(WaitlistResponse) },
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

// shortcut: a route of its own for the home card's bar, so that the public
// counter's answer stays as it is while #500 renames it (#507, ADR-013 §12).
// It goes into `GET /ponds/counter` with that rename.
const seeksRoute = createRoute({
  method: "get",
  path: "/ponds/seeks",
  summary: "Whom the people of the caller's pond seek",
  description:
    "Whole percentages of the three bands of the caller's own pond, from finished profiles: those who seek men, those who seek both women and men, and those who seek women. Null until every band holds at least k people. The bands move only once at least k finished profiles have come or gone. Counted once a day.",
  ...bearer,
  responses: {
    200: { description: "The shares, or null.", ...json(PondSeeksResponse) },
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
export const WAITLIST_CACHE_CONTROL = "public, max-age=3600";

export function pondRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  readGate: GateReader,
) {
  const app = new OpenAPIHono<AppEnv>();
  const guarded = [homeRoute, gateRoute, seeksRoute];
  for (const path of new Set(guarded.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }

  app.openapi(gateRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await readGate(accountId), 200);
  });

  app.openapi(seeksRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json({ seeks: await readPondSeeks(deps.db, accountId) }, 200);
  });

  app.openapi(waitlistRoute, async (c) => {
    // The read first, the header after it: a failure must not be answered as
    // something a cache may keep for an hour.
    const waitlist = await readWaitlist(deps.db);
    c.header("Cache-Control", WAITLIST_CACHE_CONTROL);
    return c.json(waitlist, 200);
  });

  app.openapi(homeRoute, async (c) => {
    const home = await saveHome(deps, callerOf(c).accountId, c.req.valid("json"));
    return c.json(home, 200);
  });

  return app;
}
