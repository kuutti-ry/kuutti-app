import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  GateResponse,
  PondChoice,
  PondCounterResponse,
  PondList,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { readPondCounter } from "./counter.ts";
import * as repo from "./repo.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const listRoute = createRoute({
  method: "get",
  path: "/ponds",
  summary: "The ponds a person can choose",
  description:
    "Every pond with both Finnish case forms (TD-17), parents first. Where matching happens (TD-10); the choice is one per account.",
  ...bearer,
  responses: {
    200: { description: "The ponds.", ...json(PondList) },
    401: unauthenticated,
  },
});

const chooseRoute = createRoute({
  method: "put",
  path: "/account/pond",
  summary: "Choose the caller's pond",
  ...bearer,
  request: { body: { required: true, ...json(PondChoice) } },
  responses: {
    204: { description: "Chosen." },
    400: errorContent("Validation failed, or pond_unknown."),
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
    "Per pond: bank-verified people with the pond as theirs, their split by self-declared gender, and how many are finishing their profile. A number is published only where at least k people stand behind it (k is in the answer), the split only when every cell is at least k, and a pond's numbers move only once at least k people have come or gone since they were last said. Counted once a day. No session needed. With one, the answer is the caller's and is not cached, and the caller's own pond also says whom its people seek: whole percentages of three bands of finished profiles, those who seek men, those who seek both women and men, and those who seek women, null until every band holds at least k people.",
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
  const guarded = [listRoute, chooseRoute, gateRoute];
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

  app.openapi(listRoute, async (c) => {
    return c.json({ ponds: await repo.listPonds(deps.db) }, 200);
  });

  app.openapi(chooseRoute, async (c) => {
    const { pondId } = c.req.valid("json");
    const { accountId } = callerOf(c);
    const outcome = await repo.setPondOfAccount(deps.db, accountId, pondId);
    if (outcome === "no_pond") throw new AppError(400, "pond_unknown", "No such pond", { pondId });
    if (outcome === "no_account") throw new AppError(404, "not_found", "No live account");
    deps.logger.info({ accountId, pondId }, "pond chosen");
    return c.body(null, 204);
  });

  return app;
}
