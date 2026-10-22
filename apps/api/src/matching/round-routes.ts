import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  Relaxation,
  RelaxationAnswer,
  RelaxationParams,
  RelaxationsResponse,
  RelaxationUndone,
  RoundDayParams,
  RoundDecisionAnswer,
  RoundDecisionUpdate,
  RoundEntryParams,
  RoundResponse,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { type OwnFieldsReader, readDealBreakers } from "./deal-breakers.ts";
import {
  type BuildToday,
  type CardOf,
  decide,
  type Matches,
  markSeen,
  type RoundDeps,
  readAdded,
  readRelaxations,
  readTodaysRound,
  relax,
  type ShortPool,
  undoRelaxation,
} from "./rounds.ts";

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

/** A budget's refusal names its wait; it goes in the header (the card budget's, the day's likes). */
function retryAfterOf(error: unknown): number | undefined {
  return error instanceof AppError
    ? (error.detail as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds
    : undefined;
}

const todayRoute = createRoute({
  method: "get",
  path: "/rounds/today",
  summary: "Today's round",
  description:
    "The Finnish day and its cards in order, each with why it is there and the caller's own decision. The first read of a day builds the caller's round once their matching has opened; entries null while they have none, an empty list for a round with nobody to show. A card that cannot be shown now is left out. Serving a card writes the shown record and counts against matching_config exposure_cards_per_day (ADR-008).",
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
    "Recorded, or replacing the day's earlier decision on the card; the same decision again writes nothing. A day that has ended answers round_expired. A like counts against the day's matching_config like_budget_balanced, except one on a liked_you or fish card; a pass never does. A like of somebody whose like of the caller stands is a match: the answer names its conversation, and that like is final. A fish is a like with a mark, matching_config fish_budget of them in any fish_window_days; on a liked_you or fish card it is a like. Past either budget, a like or a fish the caller's invitations earned is used by itself, left out of the counts after, and given back when the decision changes the same day.",
  ...bearer,
  request: {
    params: RoundEntryParams,
    body: { required: true, ...json(RoundDecisionUpdate) },
  },
  responses: {
    200: {
      description:
        "Recorded, with the conversation the card's like is part of, or null for a pass and a like that made no match.",
      ...json(RoundDecisionAnswer),
    },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: noCard,
    409: errorContent(
      "round_expired: the day named has ended; match_made: the card's like made a match and stays. Nothing was written.",
    ),
    429: errorContent(
      "like_budget_exceeded: the day's likes are used up and no earned like is left, Retry-After the wait until the day rolls; fish_budget_exceeded: matching_config fish_budget fish were sent within fish_window_days and no earned fish is left, Retry-After the wait until the next can go. Nothing was written.",
    ),
  },
});

const relaxationsRoute = createRoute({
  method: "get",
  path: "/rounds/{day}/relaxations",
  summary: "What today's round may relax, and what is relaxed",
  description:
    "For a short round (fewer ordered places than matching_config round_size, the liked-you and fish places aside), every deal-breaker of the caller's that is not paused and not relaxed today, each way it can be relaxed for the day: unanswered (let through those who did not answer its field) and aside (set it aside), each listed only when it would add somebody today, with more: how much it widens the caller's pool, rounded down to a step of matching_config waitlist_k. Counted on asking. Also the relaxations in force today. Never another filter (ADR-042).",
  ...bearer,
  request: { params: RoundDayParams },
  responses: {
    200: { description: "The offers and today's relaxations.", ...json(RelaxationsResponse) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("not_found: no round today, or a day not begun."),
    409: expired,
  },
});

const relaxRoute = createRoute({
  method: "post",
  path: "/rounds/{day}/relaxations",
  summary: "Relax a deal-breaker for today",
  description:
    "One of the caller's own deal-breakers loosened for the day only: the people it lets in today are added after the round's last place, as many as the room left (round_size less the ordered places), new people first, reason relaxed with the field. Tomorrow's round is built from the filters as stored. The answer is the cards added, served as the round's read serves them (ADR-008).",
  ...bearer,
  request: { params: RoundDayParams, body: { required: true, ...json(Relaxation) } },
  responses: {
    200: { description: "Relaxed; the cards it added, perhaps none.", ...json(RelaxationAnswer) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent(
      "not_found: no round today, a day not begun, or a relaxation the offers would not list (no deal-breaker of the caller's on that field, a paused one, or unanswered where those people are let through already). Nothing was written.",
    ),
    409: errorContent(
      "round_expired: the day named has ended; already_relaxed: that deal-breaker is relaxed today; relaxations_changed: another device relaxed or undid one since this tap's offers were counted. Nothing was written.",
    ),
    429: errorContent(
      "card_budget_exceeded: relaxed, and the cards added, but the day's cards are used up; Retry-After is the wait until the day rolls.",
    ),
  },
});

const undoRelaxRoute = createRoute({
  method: "delete",
  path: "/rounds/{day}/relaxations/{field}",
  summary: "Undo today's relaxation of a deal-breaker",
  description:
    "The relaxation goes, and with it the cards that came in under it, a later relaxation's too, that are still undecided; a decided one stays as it was decided.",
  ...bearer,
  request: { params: RelaxationParams },
  responses: {
    200: { description: "Undone; the places of the cards removed.", ...json(RelaxationUndone) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent(
      "not_found: no round today, a day not begun, or that field not relaxed today.",
    ),
    409: expired,
  },
});

/**
 * `read` is the safety slice's velocity check after a read of the day's
 * round (#86, ADR-041), handed in by app.ts as the chat's `opened` is;
 * awaited after the read was served, it changes no answer. A read refused
 * over the day's cards hands over nothing and is not checked.
 */
export function roundRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  cardOf: CardOf,
  buildToday: BuildToday,
  matches: Matches,
  read: (accountId: string) => Promise<void>,
  shortPool: ShortPool,
  readOwnFields: OwnFieldsReader,
) {
  const app = new OpenAPIHono<AppEnv>();
  for (const route of [
    todayRoute,
    seenRoute,
    decisionRoute,
    relaxationsRoute,
    relaxRoute,
    undoRelaxRoute,
  ]) {
    app.use(route.getRoutingPath(), requireSession);
  }
  const rounds = (): RoundDeps => ({
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
  });
  // The caller's own deal-breakers that filter now, for the cards' "did not answer" (ADR-042 §8).
  const filtering = async (accountId: string) =>
    (await readDealBreakers(deps.db, accountId, await readOwnFields(accountId)))
      .filter((dealBreaker) => !dealBreaker.paused)
      .map(({ paused: _paused, ...dealBreaker }) => dealBreaker);

  app.openapi(todayRoute, async (c) => {
    const { accountId } = callerOf(c);
    try {
      const dealBreakers = await filtering(accountId);
      let round = await readTodaysRound(rounds(), accountId, cardOf, dealBreakers);
      // Nobody built the day's round yet: matching opened during the day, or
      // the night has not come. The first read builds it (#95, ADR-035 §5).
      if (round.entries === null && (await buildToday(accountId))) {
        round = await readTodaysRound(rounds(), accountId, cardOf, dealBreakers);
      }
      await read(accountId);
      return c.json(round, 200);
    } catch (error) {
      const wait = retryAfterOf(error);
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
    try {
      const { match } = await decide(rounds(), matches, {
        accountId: callerOf(c).accountId,
        day,
        position,
        decision,
      });
      return c.json({ match: match ? { conversationId: match } : null }, 200);
    } catch (error) {
      const wait = retryAfterOf(error);
      if (wait !== undefined) c.header("Retry-After", String(wait));
      throw error;
    }
  });

  app.openapi(relaxationsRoute, async (c) => {
    const { day } = c.req.valid("param");
    const answer = await readRelaxations(rounds(), shortPool, {
      accountId: callerOf(c).accountId,
      day,
    });
    return c.json(answer, 200);
  });

  app.openapi(relaxRoute, async (c) => {
    const { day } = c.req.valid("param");
    const { accountId } = callerOf(c);
    const positions = await relax(rounds(), shortPool, {
      accountId,
      day,
      relaxation: c.req.valid("json"),
    });
    try {
      const entries = await readAdded(
        rounds(),
        accountId,
        day,
        positions,
        cardOf,
        await filtering(accountId),
      );
      return c.json({ entries }, 200);
    } catch (error) {
      const wait = retryAfterOf(error);
      if (wait !== undefined) c.header("Retry-After", String(wait));
      throw error;
    }
  });

  app.openapi(undoRelaxRoute, async (c) => {
    const { day, field } = c.req.valid("param");
    const removed = await undoRelaxation(rounds(), {
      accountId: callerOf(c).accountId,
      day,
      field,
    });
    return c.json({ removed }, 200);
  });

  return app;
}
