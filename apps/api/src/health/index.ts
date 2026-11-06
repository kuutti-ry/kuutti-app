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

/** How long one check of the database answers every /health asked meanwhile. */
const KEPT_MS = 1_000;

type DbState = Pick<HealthResponse, "db" | "migrations">;

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness and readiness in one answer",
  description:
    "200 when the database answers and committed migrations are applied; 503 with the same body when either fails. One check of the database answers every request within its second.",
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
  const now = deps.now ?? (() => new Date());

  // /health is outside every window (app.ts), and a request through somebody
  // else's distribution never meets the edge (ADR-066, ADR-067). So the
  // database's part of the answer is kept for a second and shared by every
  // request meanwhile, and a check still under way is shared however long it
  // takes: however many ask, the database is asked at most once a second, one
  // check at a time (ADR-026, History of 2026-11-06). A failed check is kept
  // the same way.
  let kept: { at: number; state: Promise<DbState>; settled: boolean } | undefined;
  const check = async (): Promise<DbState> => {
    const db = await checkDb(deps.db, DB_TIMEOUT_MS);
    const migrations =
      db === "ok" ? (await migrationsStatus(deps.db, migrationsDir)).state : "pending";
    return { db, migrations };
  };
  const dbState = (): Promise<DbState> => {
    const at = now().getTime();
    // A clock that went back starts a check rather than keeping one for good.
    if (kept && (!kept.settled || (at >= kept.at && at - kept.at < KEPT_MS))) return kept.state;
    const entry = { at, state: check(), settled: false };
    const settle = () => {
      entry.settled = true;
    };
    entry.state.then(settle, settle);
    kept = entry;
    return entry.state;
  };

  app.openapi(healthRoute, async (c) => {
    const { db, migrations } = await dbState();
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
