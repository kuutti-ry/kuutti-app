import { resolve } from "node:path";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { migrationsStatus } from "@kuutti/db";
import { HealthResponse } from "@kuutti/schema";
import type { Deps } from "../app.ts";
import { checkDb } from "../lib/db.ts";
import type { AppEnv } from "../lib/env.ts";
import { ORIGIN_PROOF_HEADER, originProofOf } from "../lib/origin-proof.ts";
import { buildInfo } from "../lib/version.ts";

const DB_TIMEOUT_MS = 500;

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness and readiness in one answer",
  description:
    "200 when the database answers and committed migrations are applied; 503 with the same body when either fails.",
  responses: {
    200: {
      description: "Every dependency answers.",
      content: { "application/json": { schema: HealthResponse } },
    },
    503: {
      description: "Database unreachable or migrations pending.",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export function healthRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppEnv>();
  const migrationsDir = resolve(deps.config.MIGRATIONS_DIR);
  const info = buildInfo(deps.config);
  // How the store and the function are seen from the box, before and after
  // the limiter trusts them (ADR-066): a valid proof on the answer to a
  // request through Kuutti's distribution means the two agree.
  const proof = originProofOf(deps.config.originSecrets);

  app.openapi(healthRoute, async (c) => {
    const db = await checkDb(deps.db, DB_TIMEOUT_MS);
    const migrations =
      db === "ok" ? (await migrationsStatus(deps.db, migrationsDir)).state : "pending";
    const healthy = db === "ok" && migrations === "current";
    const body: HealthResponse = {
      status: healthy ? "ok" : "degraded",
      version: info.version,
      commit: info.commit,
      builtAt: info.builtAt,
      source: deps.config.SOURCE_URL,
      db,
      migrations,
      trustedProxy: deps.config.TRUSTED_PROXY,
      originProof: proof(c.req.header(ORIGIN_PROOF_HEADER)),
    };
    return healthy ? c.json(body, 200) : c.json(body, 503);
  });

  return app;
}
