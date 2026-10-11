import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ConsentRequest,
  ConsentsResponse,
  ErrorResponse,
  GenderUpdate,
  OnboardingStatus,
  WithdrawableConsentKind,
} from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { callerOf } from "../lib/auth-middleware.ts";
import type { AppEnv } from "../lib/env.ts";
import {
  consentsOf,
  declareGender,
  giveConsent,
  type OnboardingDeps,
  onboardingStatus,
  withdrawConsentOf,
} from "./onboarding.ts";

const errorContent = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorResponse } },
});
const json = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const bearer = { security: [{ session: [] }] };
const unauthenticated = errorContent("unauthenticated, session_expired or session_revoked.");

const statusRoute = createRoute({
  method: "get",
  path: "/onboarding",
  summary: "What the caller has answered and which steps of onboarding are still open",
  description:
    "The steps of the field sheet in the order the app asks them, the answers so far, the consents given for the current wordings and the current versions. An account without a pond is put in the default pond here. When the four answers matching needs and the two consents are there and the account is still registered, it becomes active here; the profile steps keep `complete` false until they are done.",
  ...bearer,
  responses: {
    200: { description: "The status.", ...json(OnboardingStatus) },
    401: unauthenticated,
  },
});

const genderRoute = createRoute({
  method: "put",
  path: "/account/gender",
  summary: "Declare the caller's gender",
  description: "Self-declared, one of a closed list (rule 3); nothing from the bank informs it.",
  ...bearer,
  request: { body: { required: true, ...json(GenderUpdate) } },
  responses: {
    204: { description: "Declared." },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

const consentsRoute = createRoute({
  method: "get",
  path: "/consents",
  summary: "Every consent the caller has given, and the current versions",
  ...bearer,
  responses: {
    200: { description: "The consents.", ...json(ConsentsResponse) },
    401: unauthenticated,
  },
});

const consentRoute = createRoute({
  method: "post",
  path: "/consents",
  summary: "Record a consent for the current wording",
  description:
    "The kind (terms, privacy, research, or special_category for whom one seeks, politics and religion), the consent_version the person read and the language it was shown in. An old version is refused with agreement_outdated; the same consent twice is recorded once.",
  ...bearer,
  request: { body: { required: true, ...json(ConsentRequest) } },
  responses: {
    200: { description: "Recorded; the consents as stored.", ...json(ConsentsResponse) },
    400: errorContent("Validation failed."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
    409: errorContent("agreement_outdated: the wording has a newer version."),
    429: errorContent(
      "too_many_changes: the research opt-in was given and withdrawn more than the day allows.",
    ),
  },
});

const withdrawRoute = createRoute({
  method: "delete",
  path: "/consents/{kind}",
  summary: "Withdraw the research opt-in or the special-category consent",
  description:
    "The two consents a person withdraws; terms and privacy end with the account. Withdrawing special_category takes whom the person seeks and the politics and religion of the profile with it, and onboarding asks the seek question again. The rows stay as the record of what was agreed and when.",
  ...bearer,
  request: { params: z.object({ kind: WithdrawableConsentKind }).strict() },
  responses: {
    200: { description: "Withdrawn; the consents as stored.", ...json(ConsentsResponse) },
    400: errorContent("Validation failed: not a kind a person withdraws."),
    401: unauthenticated,
    404: errorContent("No live account (erased meanwhile)."),
  },
});

export function onboardingRoutes(deps: Deps, requireSession: MiddlewareHandler<AppEnv>) {
  const app = new OpenAPIHono<AppEnv>();
  const onboardingDeps: OnboardingDeps = {
    db: deps.db,
    logger: deps.logger,
    now: () => new Date(),
  };
  const routes = [statusRoute, genderRoute, consentsRoute, consentRoute, withdrawRoute];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) {
    app.use(path, requireSession);
  }

  app.openapi(statusRoute, async (c) => {
    return c.json(await onboardingStatus(onboardingDeps, callerOf(c).accountId), 200);
  });

  app.openapi(genderRoute, async (c) => {
    await declareGender(onboardingDeps, callerOf(c).accountId, c.req.valid("json").gender);
    return c.body(null, 204);
  });

  app.openapi(consentsRoute, async (c) => {
    return c.json(await consentsOf(onboardingDeps, callerOf(c).accountId), 200);
  });

  app.openapi(consentRoute, async (c) => {
    return c.json(
      await giveConsent(onboardingDeps, callerOf(c).accountId, c.req.valid("json")),
      200,
    );
  });

  app.openapi(withdrawRoute, async (c) => {
    const { kind } = c.req.valid("param");
    return c.json(await withdrawConsentOf(onboardingDeps, callerOf(c).accountId, kind), 200);
  });

  return app;
}
