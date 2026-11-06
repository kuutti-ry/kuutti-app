import { resolve } from "node:path";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { migrationsStatus, type Queryable } from "@kuutti/db";
import { HealthResponse } from "@kuutti/schema";
import type { Deps } from "../app.ts";
import { checkDb } from "../lib/db.ts";
import type { AppEnv } from "../lib/env.ts";
import { ORIGIN_PROOF_HEADER, originProofOf } from "../lib/origin-proof.ts";
import { buildInfo } from "../lib/version.ts";

/** How long each of a check's two reads, SELECT 1 and the migrations', may take before it counts as no answer. */
const DB_TIMEOUT_MS = 500;

/** How long one check of the database answers every /health asked meanwhile. */
const KEPT_MS = 1_000;

type DbState = Pick<HealthResponse, "db" | "migrations">;

/**
 * The migrations' state, or pending when their read takes longer than
 * `timeoutMs`. A statement that never answers, on a connection whose server
 * went away, is left behind as checkDb leaves its SELECT 1, so every check
 * settles and no /health waits on it (#630).
 */
async function migrationsWithin(
  db: Queryable,
  folder: string,
  timeoutMs: number,
): Promise<DbState["migrations"]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), timeoutMs);
  });
  try {
    return await Promise.race([migrationsStatus(db, folder).then((status) => status.state), late]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // request meanwhile, and no check begins while another is under way, which
  // settles within its two reads' timeouts. However many ask, a check begins at
  // most once a second in this process (ADR-026, History of 2026-11-06). A
  // failed check is kept the same way.
  let kept: { at: number; state: Promise<DbState>; settled: boolean } | undefined;
  const check = async (): Promise<DbState> => {
    const db = await checkDb(deps.db, DB_TIMEOUT_MS);
    const migrations =
      db === "ok" ? await migrationsWithin(deps.db, migrationsDir, DB_TIMEOUT_MS) : "pending";
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
