import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  GateResponse,
  PondChoice,
  PondList,
  PondSeeksResponse,
  WaitlistResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import * as repo from "./repo.ts";
import { readPondSeeks, readWaitlist } from "./waitlist.ts";

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

// The person's own place at the gate (#94, ADR-015). What is said is the
// person's alone and moves in steps; nothing of anybody else is in it.
const gateRoute = createRoute({
  method: "get",
  path: "/gate",
  summary: "Where the caller stands at the pond gate",
  description:
    "Between a finished profile and the first round (TD-10): on the pond's waitlist with a place, let in and waiting for enough people who match (how many more, in steps of `step`), or open. Counted nightly, and once when a person with a finished profile first asks.",
  ...bearer,
  responses: {
    200: { description: "The caller's gate.", ...json(GateResponse) },
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
 * How the route learns the caller's gate. Handed in by the app: the count
 * reads across slices and lives with the nightly jobs (rules/layout.md), and
 * this slice does not import it.
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
  const guarded = [listRoute, chooseRoute, gateRoute, seeksRoute];
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
