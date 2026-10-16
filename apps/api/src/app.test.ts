import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AUDIT_PAGE_SIZE } from "@kuutti/schema";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, PUBLIC_ROUTES } from "./app.ts";
import { captureLogger, testConfig, testPool } from "./test/harness.ts";

type GuardedRoute = { key: string; path: string; guards: string[]; roles: string[][] };

/**
 * Every handler route with the guards that run before it. Registration order
 * is execution order: a guard counts only when it was registered on the
 * handler's exact path before the handler. Middleware is what takes (c, next);
 * everything else, on any method or pattern, is a route.
 */
function guardedRoutes(app: ReturnType<typeof createApp>): GuardedRoute[] {
  const guards: { name: string; path: string; index: number; roles: string[] }[] = [];
  const routes: { key: string; path: string; index: number }[] = [];
  app.routes.forEach(({ method, path, handler }, index) => {
    // The product guard or the staff guard (#49).
    if (handler.name === "requireSession" || handler.name === "requireAdmin") {
      const { roles } = handler as { roles?: readonly string[] };
      guards.push({ name: handler.name, path, index, roles: [...(roles ?? [])] });
      return;
    }
    if (handler.length === 2) return;
    routes.push({ key: `${method} ${path}`, path, index });
  });
  return routes.map(({ key, path, index }) => ({
    key,
    path,
    guards: guards.filter((g) => g.path === path && g.index < index).map((g) => g.name),
    roles: guards.filter((g) => g.path === path && g.index < index).map((g) => g.roles),
  }));
}

/** The staff routes that a product session could pass: no staff guard before them (#49). */
const adminRoutesWithoutStaffGuard = (routes: GuardedRoute[]) =>
  routes
    .filter(({ key, path }) => path.startsWith("/admin/") && !PUBLIC_ROUTES.has(key))
    .filter(({ guards }) => !guards.includes("requireAdmin"))
    .map(({ key }) => key);

async function bareApp() {
  const { logger } = await captureLogger();
  return createApp({ config: testConfig(), logger, db: testPool() });
}

/**
 * Rule 6's structural half (#35): a route that is not on the public list is
 * registered behind the session middleware, so no handler can read user data
 * without an account id on the context. Routes come from the router, so a new
 * route is checked the day it is added.
 */
describe("route table", () => {
  it("every route outside PUBLIC_ROUTES sits behind requireSession", async () => {
    const routes = guardedRoutes(await bareApp());
    expect(routes.length).toBeGreaterThan(0);
    const unguarded = routes
      .filter(({ key, guards }) => !PUBLIC_ROUTES.has(key) && guards.length === 0)
      .map(({ key }) => key);
    expect(unguarded).toEqual([]);
    // And the public list is not silently wider than the router.
    const keys = new Set(routes.map((r) => r.key));
    for (const key of PUBLIC_ROUTES) expect(keys.has(key)).toBe(true);
  });

  it("every staff route outside PUBLIC_ROUTES sits behind requireAdmin, not the product guard alone", async () => {
    const routes = guardedRoutes(await bareApp());
    expect(routes.some(({ path, guards }) => path.startsWith("/admin/") && guards.length > 0)).toBe(
      true,
    );
    expect(adminRoutesWithoutStaffGuard(routes)).toEqual([]);
  });

  it("holds a ban, its lift and its review to the admin role, and the other sanctions to moderators and admins (#307, ADR-024 §3)", async () => {
    const routes = guardedRoutes(await bareApp());
    const rolesOf = (key: string) => routes.find((r) => r.key === key)?.roles;
    for (const key of [
      "POST /admin/accounts/:id/bans",
      "POST /admin/bans/:id/lift",
      "POST /admin/bans/:id/review",
    ]) {
      expect(rolesOf(key), key).toEqual([["admin"]]);
    }
    for (const key of [
      "GET /admin/accounts/:id/sanctions",
      "POST /admin/accounts/:id/sanctions",
      "POST /admin/sanctions/:id/lift",
      "POST /admin/sanctions/:id/review",
    ]) {
      expect(rolesOf(key), key).toEqual([["moderator", "admin"]]);
    }
  });

  it("holds the audit log and the staff list to the admin role (#309, #310)", async () => {
    const routes = guardedRoutes(await bareApp());
    const rolesOf = (key: string) => routes.find((r) => r.key === key)?.roles;
    for (const key of ["GET /admin/audit", "GET /admin/staff"]) {
      expect(rolesOf(key), key).toEqual([["admin"]]);
    }
  });

  it("would catch a staff route behind the product guard alone", async () => {
    const app = await bareApp();
    // The mistake the check exists for: a product session admitted to staff data.
    const requireSession: MiddlewareHandler = async (_c, next) => next();
    app.use("/admin/probe", requireSession);
    app.get("/admin/probe", (c) => c.json({ ok: true }));
    expect(adminRoutesWithoutStaffGuard(guardedRoutes(app))).toEqual(["GET /admin/probe"]);
  });
});

/** The contract as the API serves it outside production. */
type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
};
type Operation = {
  parameters?: { schema?: unknown }[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
};

async function contract(): Promise<Contract> {
  const response = await (await bareApp()).request("/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as Contract;
}

/** Every node of a schema, following its $refs into the components, each component once. */
function* nodes(
  schema: unknown,
  schemas: Record<string, unknown>,
  seen = new Set<string>(),
): Generator<Record<string, unknown>> {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  yield node;
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return;
    seen.add(name);
    yield* nodes(schemas[name], schemas, seen);
    return;
  }
  for (const value of Object.values(node)) yield* nodes(value, schemas, seen);
}

const operations = (doc: Contract) =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
  );

/** The schemas of an audit row: the person's page's, and the reader's with the actor's role and the person (#309). */
const AUDIT_ROWS = new Set([
  "#/components/schemas/AdminAuditRow",
  "#/components/schemas/AuditEntry",
]);

/** Each array of audit rows any answer of the API can carry, with its bound; null when unbounded. */
function auditArrays(doc: Contract): { key: string; maxItems: number | null }[] {
  return operations(doc).flatMap(({ key, op }) =>
    Object.values(op.responses ?? {})
      .flatMap((response) => Object.values(response.content ?? {}))
      .flatMap(({ schema }) => [...nodes(schema, doc.components.schemas)])
      .filter(
        (node) =>
          node.type === "array" &&
          AUDIT_ROWS.has((node.items as { $ref?: string } | undefined)?.$ref ?? ""),
      )
      .map((node) => ({
        key,
        maxItems: typeof node.maxItems === "number" ? node.maxItems : null,
      })),
  );
}

const API_SOURCE = resolve(import.meta.dirname);

/** The API's own production sources: no test, no test helper. */
function* apiSources(path = API_SOURCE): Generator<string> {
  if (statSync(path).isFile()) {
    if (path.endsWith(".ts") && !path.endsWith(".test.ts")) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (path === API_SOURCE && name === "test") continue;
    yield* apiSources(join(path, name));
  }
}

const sourcesMatching = (pattern: RegExp) =>
  [...apiSources()]
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(API_SOURCE, file))
    .sort();

/**
 * Never a bulk export of the audit log (#309, rules/admin.md). What the route
 * table and the contract can hold: one route names the log, its page is
 * AUDIT_PAGE_SIZE rows in the contract, and every answer that carries audit
 * rows bounds them by a page; and the API's sources read the table in the
 * places named here. Not checkable from here: that a handler's query keeps to
 * its contract's bound (answers are not validated at run time; the routes'
 * own tests count the rows), a query assembled at run time, or audit rows
 * answered under a schema other than AdminAuditRow or AuditEntry.
 */
describe("the audit log, a page at a time", () => {
  it("one route names the log, and its page is AUDIT_PAGE_SIZE rows in the contract", async () => {
    const routes = guardedRoutes(await bareApp());
    expect(routes.filter(({ path }) => /audit/i.test(path)).map(({ key }) => key)).toEqual([
      "GET /admin/audit",
    ]);
    expect(AUDIT_PAGE_SIZE).toBe(50);
    expect(auditArrays(await contract()).filter(({ key }) => key === "GET /admin/audit")).toEqual([
      { key: "GET /admin/audit", maxItems: AUDIT_PAGE_SIZE },
    ]);
  });

  it("no route of the API answers more than one page of audit rows at a time", async () => {
    const arrays = auditArrays(await contract());
    expect(arrays.length).toBeGreaterThan(0);
    const over = arrays.filter(({ maxItems }) => maxItems === null || maxItems > AUDIT_PAGE_SIZE);
    expect(over).toEqual([]);
  });

  it("the API reads audit_log in two places: the reader and the person's page", () => {
    expect(sourcesMatching(/\b(FROM|JOIN)\s+(public\.)?audit_log\b/i)).toEqual([
      join("safety", "accounts.ts"),
      join("safety", "audit-routes.ts"),
    ]);
  });
});

/** The routes whose path names a role, staff, a moderator, a grant or a revocation. */
const roleRoutes = (routes: GuardedRoute[]) =>
  routes
    .filter(({ path }) => /role|staff|moderator|grant|revoke/i.test(path))
    .map(({ key }) => key);

/**
 * Granting and revoking a role stay the maintainer's tool (#310, ADR-006 §5:
 * "written by the maintainer, never by a route"). What the route table and the
 * contract can hold: one route names staff, and it only reads; nothing a
 * request sends names a role; and no source of the API writes moderator_roles.
 * Not checkable from here: a write assembled at run time, or one through
 * another package's code (packages/db's CLI writes the table, and no API
 * source may import it).
 */
describe("no route grants or revokes a role", () => {
  it("one route names staff or a role, and it is a GET", async () => {
    expect(roleRoutes(guardedRoutes(await bareApp()))).toEqual(["GET /admin/staff"]);
  });

  it("would catch a route that grants or revokes", async () => {
    const app = await bareApp();
    app.post("/admin/staff/:id", (c) => c.json({ ok: true }));
    app.delete("/admin/roles/:id", (c) => c.json({ ok: true }));
    expect(roleRoutes(guardedRoutes(app))).toEqual([
      "GET /admin/staff",
      "POST /admin/staff/:id",
      "DELETE /admin/roles/:id",
    ]);
  });

  it("nothing a request sends names a role", async () => {
    const doc = await contract();
    const roleNames = new Set(["moderator", "admin", "researcher"]);
    const naming = operations(doc).filter(({ op }) =>
      [
        ...(op.parameters ?? []).map((parameter) => parameter.schema),
        ...Object.values(op.requestBody?.content ?? {}).map((content) => content.schema),
      ]
        .flatMap((schema) => [...nodes(schema, doc.components.schemas)])
        .some(
          (node) =>
            node.$ref === "#/components/schemas/ModeratorRole" ||
            (Array.isArray(node.enum) && node.enum.some((value) => roleNames.has(value))),
        ),
    );
    expect(naming.map(({ key }) => key)).toEqual([]);
    // The walk does find a role where one is: in what the staff list answers.
    expect(
      operations(doc)
        .filter(({ key }) => key === "GET /admin/staff")
        .flatMap(({ op }) => Object.values(op.responses?.["200"]?.content ?? {}))
        .flatMap(({ schema }) => [...nodes(schema, doc.components.schemas)])
        .some((node) => node.$ref === "#/components/schemas/ModeratorRole"),
    ).toBe(true);
  });

  it("no source of the API writes moderator_roles", () => {
    expect(
      sourcesMatching(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.)?moderator_roles\b/i,
      ),
    ).toEqual([]);
    // The pattern finds the writes where they are: the maintainer's tool.
    const cli = readFileSync(
      resolve(API_SOURCE, "..", "..", "..", "packages", "db", "src", "cli", "moderator.ts"),
      "utf8",
    );
    expect(cli).toMatch(/\bINSERT\s+INTO\s+moderator_roles\b/i);
    expect(cli).toMatch(/\bDELETE\s+FROM\s+moderator_roles\b/i);
  });
});

/** Every handler route as a request a crawler could make: params filled with plausible values. */
function crawlable(app: ReturnType<typeof createApp>): { method: string; path: string }[] {
  return app.routes
    .filter(({ handler }) => handler.length !== 2)
    .map(({ method, path }) => ({
      method,
      path: path
        .replace(/:id\b/g, "00000000-0000-4000-8000-000000000001")
        .replace(/:variant\b/g, "thumb")
        .replace(/:[A-Za-z_]+/g, "x"),
    }));
}

/**
 * Rule 8 and the M3 half of TD-6 (#52): nothing a crawler reaches. A request
 * without a session is refused on every route the public list does not name,
 * a browser origin the configuration does not know gets no CORS answer on
 * any route, the public list carries no id, every response says noindex, and
 * the contract is not served in production.
 */
describe("no web surface", () => {
  it("a request without a session gets 401 on every route outside the public list", async () => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    const refused: string[] = [];
    for (const { method, path } of crawlable(app)) {
      if (PUBLIC_ROUTES.has(`${method} ${path}`)) continue;
      const response = await app.request(path, { method });
      if (response.status !== 401) refused.push(`${method} ${path} -> ${response.status}`);
    }
    expect(refused).toEqual([]);
  });

  it("no route answers a browser origin it does not know", async () => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    const origin = "https://scraper.example";
    const leaked: string[] = [];
    for (const { method, path } of crawlable(app)) {
      const direct = await app.request(path, { method, headers: { origin } });
      const preflight = await app.request(path, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": method },
      });
      for (const [kind, response] of [
        ["direct", direct],
        ["preflight", preflight],
      ] as const) {
        if (response.headers.get("access-control-allow-origin") !== null) {
          leaked.push(`${kind} ${method} ${path}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it("the public list names no route with an id in its path", () => {
    for (const key of PUBLIC_ROUTES) expect(key).not.toMatch(/[:{]/);
  });

  it("every response says noindex", async () => {
    const { logger } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    for (const path of ["/health", "/photos", "/nowhere"]) {
      expect((await app.request(path)).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("the contract is not served in production", async () => {
    const { logger } = await captureLogger();
    const production = testConfig({
      APP_ENV: "production",
      ADMIN_APP_URL: "https://admin.kuutti.app",
      CORS_ALLOWED_ORIGINS: "https://admin.kuutti.app",
    });
    const app = createApp({ config: production, logger, db: testPool() });
    expect((await app.request("/openapi.json")).status).toBe(404);
    expect(
      (await createApp({ config: testConfig(), logger, db: testPool() }).request("/openapi.json"))
        .status,
    ).toBe(200);
  });

  it("the Swagger UI is served in development and nowhere deployed", async () => {
    const { logger } = await captureLogger();
    const page = await createApp({
      config: testConfig({ APP_ENV: "development" }),
      logger,
      db: testPool(),
    }).request("/docs");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await page.text();
    expect(body).toContain("url: '/openapi.json'");
    expect(body).toContain("https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/");

    for (const deployed of [
      testConfig({ APP_ENV: "preview", PR_NUMBER: "125" }),
      testConfig({ APP_ENV: "staging" }),
      testConfig({
        APP_ENV: "production",
        ADMIN_APP_URL: "https://admin.kuutti.app",
        CORS_ALLOWED_ORIGINS: "https://admin.kuutti.app",
      }),
    ]) {
      const app = createApp({ config: deployed, logger, db: testPool() });
      expect((await app.request("/docs")).status, deployed.APP_ENV).toBe(404);
    }
  });
});
