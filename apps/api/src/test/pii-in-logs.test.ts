import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { captureLogger, closeTestPool, type LogLine, testConfig, testPool } from "./harness.ts";
import { testMediaDeps } from "./media.ts";

/**
 * The enforcement behind "logs never carry hetu, message text or email"
 * (CLAUDE.md security defaults, rule 5, #11). Every route the app registers
 * is exercised with fixtures in the body, the query string, the path and the
 * headers, and no fixture may reach a log line. Routes come from the router,
 * so a new route is covered the day it is added.
 */
const FIXTURES = {
  hetu: "010190-123A",
  email: "pii.probe@example.fi",
  message: "private message text 4711",
  // The shape of a session token, so the middleware's lookup path runs on it.
  token: `piitoken4711${"x".repeat(31)}`,
} as const;

type Route = { method: string; path: string };

function registeredRoutes(app: ReturnType<typeof createApp>): Route[] {
  const seen = new Set<string>();
  const routes: Route[] = [];
  for (const { method, path } of app.routes) {
    if (method === "ALL" || path.includes("*")) continue; // middleware, not a route
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path });
  }
  return routes;
}

/** Path parameters become the hetu, the query string carries everything, so do the body and the headers. */
function requestFor({ method, path }: Route): Request {
  const concrete = path.replace(/:[A-Za-z0-9_]+\??/g, encodeURIComponent(FIXTURES.hetu));
  const query = new URLSearchParams({
    hetu: FIXTURES.hetu,
    email: FIXTURES.email,
    text: FIXTURES.message,
  });
  const headers: Record<string, string> = {
    authorization: `Bearer ${FIXTURES.token}`,
    cookie: `session=${FIXTURES.token}`,
    "x-probe": FIXTURES.email,
  };
  const withBody = method !== "GET" && method !== "HEAD";
  if (withBody) headers["content-type"] = "application/json";
  return new Request(`http://api.test${concrete}?${query}`, {
    method,
    headers,
    ...(withBody
      ? {
          body: JSON.stringify({
            hetu: FIXTURES.hetu,
            personal_identity_code: FIXTURES.hetu,
            email: FIXTURES.email,
            message: FIXTURES.message,
            text: FIXTURES.message,
            note: FIXTURES.message,
            nested: { hetu: FIXTURES.hetu, body: FIXTURES.message },
          }),
        }
      : {}),
  });
}

/** Which fixture values appear anywhere in the captured lines. */
export function leakedFixtures(lines: LogLine[]): string[] {
  const out = JSON.stringify(lines);
  return Object.entries(FIXTURES)
    .filter(([, value]) => out.includes(value))
    .map(([name]) => name);
}

async function exercise(app: ReturnType<typeof createApp>, routes: Route[]): Promise<void> {
  for (const route of routes) {
    await app.request(requestFor(route));
  }
}

describe("PII in logs", () => {
  afterAll(closeTestPool);

  it("no fixture reaches a log line through any registered route", async () => {
    const { logger, lines } = await captureLogger();
    // Built with media, so the photo routes run their own code and not the 503 of a bare app (#49).
    const app = createApp({
      config: testConfig(),
      logger,
      db: testPool(),
      media: testMediaDeps().deps,
    });
    const routes = registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(0);
    await exercise(app, routes);
    expect(lines().length).toBeGreaterThanOrEqual(routes.length); // every request was logged
    expect(leakedFixtures(lines())).toEqual([]);
  });

  it("would catch a route that logs its request body", async () => {
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    app.post("/leak", async (c) => {
      // The mistake this test exists for: a stringified body under a key the
      // redaction list cannot know.
      logger.info({ payload: JSON.stringify(await c.req.json()) }, "debug");
      return c.json({ ok: true });
    });
    await exercise(app, [{ method: "POST", path: "/leak" }]);
    expect(leakedFixtures(lines())).toEqual(["hetu", "email", "message"]);
  });
});
