import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { CardPreviewResponse, ErrorResponse, ProfileResponse, ProfileUpdate } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import { readPreferences } from "../matching/index.ts";
import { buildCard, type CardDeps } from "./card.ts";
import { readProfile, saveProfile } from "./service.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const readRoute = createRoute({
  method: "get",
  path: "/profile",
  summary: "The caller's profile and what it still needs",
  description:
    "The profile as saved (null before the first save) and the completeness rule's verdict: what is missing before the profile can enter a round.",
  ...bearer,
  responses: {
    200: { description: "The profile.", ...json(ProfileResponse) },
    401: unauthenticated,
  },
});

const saveRoute = createRoute({
  method: "put",
  path: "/profile",
  summary: "Save the caller's profile",
  description:
    "The whole document every time: display name, a bio or a placeholder, the fields from the registry, up to three prompts, and the special-category consent version when a field needs it. Free text passes the plain-text rule: no e-mail, URL, phone number or social handle.",
  ...bearer,
  request: { body: { required: true, ...json(ProfileUpdate) } },
  responses: {
    200: {
      description: "Saved; the profile as stored, with its completeness.",
      ...json(ProfileResponse),
    },
    400: errorContent(
      "Validation failed, or text_contact_details (a field carries an e-mail, URL, phone number or handle).",
    ),
    401: unauthenticated,
    403: errorContent(
      "consent_required: a politics or religion answer without the consent of the current wording (ADR-019); the detail names the fields and the current version.",
    ),
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent("agreement_outdated: a consent version that is not the current wording's."),
  },
});

const cardRoute = createRoute({
  method: "get",
  path: "/profile/card",
  summary: "The caller's own card, as others will see it",
  description:
    "The card built the way a round builds it for someone else, with the age from the bank-verified year and month, the approved photos in order (bytes through GET /photos/{id}/{variant}) and what is still missing. Nothing is recorded: this is the owner looking at themselves.",
  ...bearer,
  responses: {
    200: { description: "The card, or null before the first save.", ...json(CardPreviewResponse) },
    401: unauthenticated,
  },
});

export function profileRoutes(deps: Deps, requireSession: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  // Onboarding's two hard rows (#46) are what completeness waits for.
  const cardDeps: CardDeps = {
    db: deps.db,
    logger: deps.logger,
    now: () => new Date(),
    readPreferences,
  };
  for (const path of new Set([readRoute, saveRoute, cardRoute].map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }

  app.openapi(readRoute, async (c) => {
    return c.json(await readProfile(cardDeps, callerOf(c).accountId), 200);
  });

  app.openapi(saveRoute, async (c) => {
    const update = c.req.valid("json");
    return c.json(await saveProfile(cardDeps, callerOf(c).accountId, update), 200);
  });

  app.openapi(cardRoute, async (c) => {
    const { accountId } = callerOf(c);
    const preview = await buildCard(cardDeps, {
      viewerAccountId: accountId,
      subjectAccountId: accountId,
    });
    return c.json(preview, 200);
  });

  return app;
}
