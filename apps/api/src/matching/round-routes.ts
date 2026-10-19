import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  RoundDecisionUpdate,
  RoundEntryParams,
  RoundResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { type CardOf, decide, markSeen, type RoundDeps, readTodaysRound } from "./rounds.ts";

// Today's round for the app (#96, ADR-034): read it, report a card seen,
// like or pass a card. The day is in the path of every write, so a phone
// holding a round past midnight is refused (round_expired) and never decides
// the next day's card at the same place. No route takes another person's id.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");
const noCard = errorContent(
  "not_found: no round today, no card at that place, a card that can no longer be shown, or a day not begun.",
);
const expired = errorContent("round_expired: the day named has ended; nothing was written.");

const todayRoute = createRoute({
  method: "get",
  path: "/rounds/today",
  summary: "Today's round",
  description:
    "The Finnish day and its cards in order, each with why it is there and the caller's own decision; entries null before the day's round is built. A card that cannot be shown now is left out. Serving a card writes the shown record and counts against matching_config exposure_cards_per_day (ADR-008).",
  ...bearer,
  responses: {
    200: { description: "Today's round.", ...json(RoundResponse) },
    401: unauthenticated,
    429: errorContent(
      "card_budget_exceeded: the day's cards are used up; Retry-After is the wait until the day rolls.",
    ),
  },
});

const seenRoute = createRoute({
  method: "post",
  path: "/rounds/{day}/entries/{position}/seen",
  summary: "Report a card seen",
  description:
    "The phone had the card on the screen. The first report is recorded; a repeat writes nothing. A decision does not need it.",
  ...bearer,
  request: { params: RoundEntryParams },
  responses: {
    204: { description: "Recorded, or recorded before." },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: noCard,
    409: expired,
  },
});

const decisionRoute = createRoute({
  method: "put",
  path: "/rounds/{day}/entries/{position}/decision",
  summary: "Like or pass a card",
  description:
    "Recorded, or replacing the day's earlier decision on the card; the same decision again writes nothing. A day that has ended answers round_expired.",
  ...bearer,
  request: {
    params: RoundEntryParams,
    body: { required: true, ...json(RoundDecisionUpdate) },
  },
  responses: {
    204: { description: "Recorded." },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: noCard,
    409: expired,
  },
});

export function roundRoutes(deps: Deps, requireSession: MiddlewareHandler<AppEnv>, cardOf: CardOf) {
  const app = new OpenAPIHono<AppEnv>();
  for (const route of [todayRoute, seenRoute, decisionRoute]) {
    app.use(route.getRoutingPath(), requireSession);
  }
  const rounds = (): RoundDeps => ({
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
  });

  app.openapi(todayRoute, async (c) => {
    try {
      return c.json(await readTodaysRound(rounds(), callerOf(c).accountId, cardOf), 200);
    } catch (error) {
      // The card builder's budget refusal names its wait; it goes in the header.
      const wait =
        error instanceof AppError
          ? (error.detail as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds
          : undefined;
      if (wait !== undefined) c.header("Retry-After", String(wait));
      throw error;
    }
  });

  app.openapi(seenRoute, async (c) => {
    const { day, position } = c.req.valid("param");
    await markSeen(rounds(), { accountId: callerOf(c).accountId, day, position });
    return c.body(null, 204);
  });

  app.openapi(decisionRoute, async (c) => {
    const { day, position } = c.req.valid("param");
    const { decision } = c.req.valid("json");
    await decide(rounds(), { accountId: callerOf(c).accountId, day, position, decision });
    return c.body(null, 204);
  });

  return app;
}
