import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ErrorResponse,
  InvitationCreated,
  InvitationParams,
  InvitationRedeemRequest,
  Invitations,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { localisedEnvelope } from "../lib/errors.ts";
import { matchingConfigNumber } from "../lib/matching-config.ts";
import { personOf, rateLimit } from "../lib/rate-limit.ts";
import { dayWindow } from "../media/index.ts";
import {
  INVITATION_TRIES_PER_DAY_KEY,
  invitationsOf,
  makeInvitation,
  redeemInvitation,
  withdrawInvitation,
} from "./invitations.ts";

// Invitations (#107, ADR-044): the caller's own, a new one, its withdrawal,
// and a code typed by somebody invited. All behind the session guard, every
// statement naming the caller's account (rule 6). A code is in the create's
// answer once and in the redeem's body; neither reaches a log line, since
// the request line names the route and the status alone.

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");
const erased = errorContent("not_found: the account was erased while the request was on its way.");

const listRoute = createRoute({
  method: "get",
  path: "/invitations",
  summary: "The caller's invitations",
  description:
    "Whether the caller may invite (their profile has passed the pond gate's test) and may still type a code, what an invitation earns today (matching_config invitation_reward), their open invitations newest first, how many of theirs have counted, and what those earned that is not used yet. Never a code, and nothing of anybody invited.",
  ...bearer,
  responses: {
    200: { description: "The caller's invitations.", ...json(Invitations) },
    401: unauthenticated,
    404: erased,
  },
});

const createInvitationRoute = createRoute({
  method: "post",
  path: "/invitations",
  summary: "Make an invitation",
  description:
    "A code for one friend, in two groups of five, shown here once: Kuutti keeps only its hash. For a caller whose profile has passed the pond gate's test; at most matching_config invitations_open open at once. The night the friend's profile first passes the same test, the invitation counts and the caller earns matching_config invitation_reward.",
  ...bearer,
  responses: {
    201: { description: "Made; the code is not shown again.", ...json(InvitationCreated) },
    401: unauthenticated,
    404: erased,
    409: errorContent(
      "invitation_not_yet: the caller's profile has not passed the pond gate's test; invitations_full: as many invitations open as matching_config invitations_open allows. Nothing was written.",
    ),
  },
});

const withdrawRoute = createRoute({
  method: "delete",
  path: "/invitations/{id}",
  summary: "Withdraw an open invitation",
  ...bearer,
  request: { params: InvitationParams },
  responses: {
    204: { description: "Withdrawn: its code works no more." },
    400: errorContent("validation_failed: the id is not a uuid."),
    401: unauthenticated,
    404: errorContent(
      "not_found: no open invitation of the caller's: redeemed, another's or none.",
    ),
  },
});

const redeemRoute = createRoute({
  method: "post",
  path: "/invitations/redeem",
  summary: "Use an invitation code",
  description:
    "A code typed by the caller, before their profile first passes the pond gate's test: case, spaces and hyphens do not matter. The caller is checked before the code is looked up. At most matching_config invitation_tries_per_day tries a Finnish day, whatever their answer.",
  ...bearer,
  request: { body: { required: true, ...json(InvitationRedeemRequest) } },
  responses: {
    204: {
      description:
        "Redeemed: the invitation counts the night the caller's profile passes the test.",
    },
    400: errorContent("validation_failed: no code, too long, not a code, or an unknown key."),
    401: unauthenticated,
    404: errorContent(
      "invitation_unknown: no open invitation has that code; one used or the caller's own answers the same. not_found: the account was erased meanwhile.",
    ),
    409: errorContent(
      "invitation_not_for_you: the caller cannot use a code: their profile has passed the test, they used one already, the current terms and privacy consents are not given, or their identity had an account erased before.",
    ),
    429: errorContent(
      "invitation_tries_exceeded: the day's tries are used; Retry-After is the wait until midnight in Finland.",
    ),
  },
});

export function invitationRoutes(deps: Deps, guard: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const now = () => (deps.now ?? (() => new Date()))();
  const rewards = () => ({ db: deps.db, logger: deps.logger, now });
  // On the routing paths themselves, which app.test.ts holds every guarded route to.
  for (const route of [listRoute, withdrawRoute]) app.use(route.getRoutingPath(), guard);
  // The day's tries (ADR-044 §6), as the chat counts a day's photo tries: every
  // code a person types counts, whatever its answer, to midnight in Finland,
  // in process (TD-3: one box; a restart forgets them). The refusal names the
  // limit, never its key or the code.
  const perDayTries = rateLimit({
    limit: () => matchingConfigNumber(deps.db, INVITATION_TRIES_PER_DAY_KEY),
    windowMs: 25 * 60 * 60 * 1000,
    windowEnd: (at) => dayWindow(new Date(at)).end.getTime(),
    now: () => now().getTime(),
    keyOf: personOf,
    refuse: (c, retryAfterSeconds) => {
      deps.logger.warn(
        {
          accountId: c.get("accountId"),
          limiter: INVITATION_TRIES_PER_DAY_KEY,
          retryAfterSeconds,
        },
        "invitation code refused",
      );
      return c.json(localisedEnvelope(c, "invitation_tries_exceeded"), 429);
    },
  });
  // The guard first, then the tries, before the body is read: only a POST
  // spends one, as /invitations/{id}'s DELETE shares the path's pattern.
  app.use(redeemRoute.getRoutingPath(), guard, (c, next) =>
    c.req.method === "POST" ? perDayTries(c, next) : next(),
  );

  app.openapi(listRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await invitationsOf(deps.db, accountId), 200);
  });

  app.openapi(createInvitationRoute, async (c) => {
    const { accountId } = callerOf(c);
    return c.json(await makeInvitation(rewards(), accountId), 201);
  });

  app.openapi(withdrawRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { id } = c.req.valid("param");
    await withdrawInvitation(deps.db, { accountId, invitationId: id });
    return c.body(null, 204);
  });

  app.openapi(redeemRoute, async (c) => {
    const { accountId } = callerOf(c);
    const { code } = c.req.valid("json");
    await redeemInvitation(rewards(), { accountId, code });
    return c.body(null, 204);
  });

  return app;
}
