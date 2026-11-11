import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { RoundEntryParams, RoundResponse, StarAnswer, StarList, StarParams } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { retryAfterOf } from "../lib/errors.ts";
import { bearer, errorContent, json, unauthenticated } from "../lib/openapi.ts";
import { filteringDealBreakers, type OwnFieldsReader } from "./deal-breakers.ts";
import type { CardOf, Matches, RoundDeps } from "./rounds.ts";
import { clearStar, openStar, putStar, type Stars } from "./stars.ts";

// The stars for the app (#575, ADR-064). A star is put on a card by its place, and
// read, opened and cleared by its own id; no route takes another person's id.

const noStar = errorContent(
  "not_found: no such star of the caller's, or somebody the list leaves out now.",
);

const listRoute = createRoute({
  method: "get",
  path: "/stars",
  summary: "The people the caller starred",
  description:
    "Those who may be shown now, the latest star first and in no other order: both people's filters, the accounts' state and the inbox stop are asked on every read, and whoever does not pass is left out with no word why. Each with a name, an age and the main one of the photos the caller was shown, whose thumb is asked for as any photo's. It serves no card and signs no photo.",
  ...bearer,
  responses: {
    200: { description: "The list, perhaps empty.", ...json(StarList) },
    401: unauthenticated,
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/rounds/{day}/entries/{position}/star",
  summary: "Put a star on a card",
  description:
    "Marks the card's person for later: it spends nothing and decides nothing, and the same star again answers the one that stands. It reaches nobody. A card holding a like or a pass takes none. first says this is the only star the list shows.",
  ...bearer,
  request: { params: RoundEntryParams },
  responses: {
    200: { description: "The star, and whether it is the first.", ...json(StarAnswer) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent(
      "not_found: no such card in today's round, one that can no longer be shown, or one holding a like or a pass.",
    ),
    409: errorContent(
      "round_expired: the day named has ended; stars_full: the list shows matching_config stars_max people. Nothing was written.",
    ),
  },
});

const clearRoute = createRoute({
  method: "delete",
  path: "/stars/{id}",
  summary: "Take a star off",
  description:
    "The person comes back to the queue where it would have them. Nobody is told, and nothing else changes.",
  ...bearer,
  request: { params: StarParams },
  responses: {
    204: { description: "Taken off." },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("not_found: no such star of the caller's."),
  },
});

const openRoute = createRoute({
  method: "post",
  path: "/stars/{id}/open",
  summary: "Open a starred person's card",
  description:
    "The card comes into today's log, or as it stands there, so it is reported seen and decided by its day and place as any card is, spending what those spend anywhere else. Answered as a read of the queue is, with that one card, served as a read serves one (ADR-008, ADR-041).",
  ...bearer,
  request: { params: StarParams },
  responses: {
    200: { description: "The card.", ...json(RoundResponse) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: noStar,
    429: errorContent(
      "card_budget_exceeded: the day's cards are used up; Retry-After is the wait until the day rolls.",
    ),
  },
});

/**
 * `read` is the safety slice's velocity check, as after a read of the queue
 * (#86, ADR-041): opening a star serves a card, and it counts as one.
 */
export function starRoutes(
  deps: Deps,
  requireSession: MiddlewareHandler<AppEnv>,
  cardOf: CardOf,
  stars: Stars,
  matches: Pick<Matches, "yourTurn">,
  read: (accountId: string) => Promise<void>,
  readOwnFields: OwnFieldsReader,
) {
  const app = new OpenAPIHono<AppEnv>();
  for (const route of [listRoute, putRoute, clearRoute, openRoute]) {
    app.use(route.getRoutingPath(), requireSession);
  }
  const rounds = (): RoundDeps => ({
    db: deps.db,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
  });

  app.openapi(listRoute, async (c) => {
    return c.json({ items: await stars.people(callerOf(c).accountId) }, 200);
  });

  app.openapi(putRoute, async (c) => {
    const { day, position } = c.req.valid("param");
    const star = await putStar(rounds(), stars, {
      accountId: callerOf(c).accountId,
      day,
      position,
    });
    return c.json(star, 200);
  });

  app.openapi(clearRoute, async (c) => {
    await clearStar(deps.db, { accountId: callerOf(c).accountId, id: c.req.valid("param").id });
    return c.body(null, 204);
  });

  app.openapi(openRoute, async (c) => {
    const { accountId } = callerOf(c);
    try {
      // The caller's own deal-breakers that filter now, for the card's "did not answer" (ADR-042 §8).
      const dealBreakers = await filteringDealBreakers(deps.db, accountId, readOwnFields);
      const answer = await openStar(rounds(), matches, stars, cardOf, dealBreakers, {
        accountId,
        id: c.req.valid("param").id,
      });
      await read(accountId);
      return c.json(answer, 200);
    } catch (error) {
      const wait = retryAfterOf(error);
      if (wait !== undefined) c.header("Retry-After", String(wait));
      throw error;
    }
  });

  return app;
}
