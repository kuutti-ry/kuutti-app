import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, PUBLIC_ROUTES } from "./app.ts";
import { captureLogger, testConfig, testPool } from "./test/harness.ts";

type GuardedRoute = { key: string; path: string; guards: string[] };

/**
 * Every handler route with the guards that run before it. Registration order
 * is execution order: a guard counts only when it was registered on the
 * handler's exact path before the handler. Middleware is what takes (c, next);
 * everything else, on any method or pattern, is a route.
 */
function guardedRoutes(app: ReturnType<typeof createApp>): GuardedRoute[] {
  const guards: { name: string; path: string; index: number }[] = [];
  const routes: { key: string; path: string; index: number }[] = [];
  app.routes.forEach(({ method, path, handler }, index) => {
    // The product guard or the staff guard (#49).
    if (handler.name === "requireSession" || handler.name === "requireAdmin") {
      guards.push({ name: handler.name, path, index });
      return;
    }
    if (handler.length === 2) return;
    routes.push({ key: `${method} ${path}`, path, index });
  });
  return routes.map(({ key, path, index }) => ({
    key,
    path,
    guards: guards.filter((g) => g.path === path && g.index < index).map((g) => g.name),
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

  it("would catch a staff route behind the product guard alone", async () => {
    const app = await bareApp();
    // The mistake the check exists for: a product session admitted to staff data.
    const requireSession: MiddlewareHandler = async (_c, next) => next();
    app.use("/admin/probe", requireSession);
    app.get("/admin/probe", (c) => c.json({ ok: true }));
    expect(adminRoutesWithoutStaffGuard(guardedRoutes(app))).toEqual(["GET /admin/probe"]);
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
