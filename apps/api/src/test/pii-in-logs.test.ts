import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { addressOf, TRUSTED_PROXIES, type TrustedProxy } from "../lib/rate-limit.ts";
import { signedInAccount, staffSession } from "./account.ts";
import {
  captureLogger,
  closeTestPool,
  type LogLine,
  test,
  testConfig,
  testPool,
} from "./harness.ts";
import { testMediaDeps } from "./media.ts";

/**
 * The enforcement behind "logs never carry hetu, message text or email"
 * (CLAUDE.md security defaults, rule 5, #11), nor the client's address
 * (ADR-026 §7). Every route the app registers is exercised with fixtures in
 * the body, the query string, the path and the headers, from an address in
 * every place an address can come from, and no fixture may reach a log line.
 * Routes come from the router, so a new route is covered the day it is added.
 */
const FIXTURES = {
  hetu: "010190-123A",
  email: "pii.probe@example.fi",
  message: "private message text 4711",
  // The shape of a session token, so the middleware's lookup path runs on it.
  token: `piitoken4711${"x".repeat(31)}`,
  ipv4: "203.0.113.47",
  ipv6: "2001:db8:4711::47",
  // The /64 the limiter counts that address by, however a key would write it.
  ipv6Prefix: "2001:db8:4711",
} as const;

/**
 * One client, its address wherever a proxy mode reads one (ADR-008 §5): the
 * last forwarded hop for Traefik, CloudFront's viewer header, the socket.
 * Every request carries all three, so the modes that do not read a place
 * still show that nothing logs it.
 */
type Client = { forwardedFor: string; viewer: string; socket: string };
const CLIENTS: Record<"ipv4" | "ipv6", Client> = {
  ipv4: {
    forwardedFor: `${FIXTURES.ipv6}, ${FIXTURES.ipv4}`,
    viewer: `${FIXTURES.ipv4}:4711`,
    // How a dual-stack socket reports an IPv4 client.
    socket: `::ffff:${FIXTURES.ipv4}`,
  },
  ipv6: {
    forwardedFor: `${FIXTURES.ipv4}, ${FIXTURES.ipv6}`,
    viewer: `${FIXTURES.ipv6}:4711`,
    socket: FIXTURES.ipv6,
  },
};

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
function requestFor(
  { method, path }: Route,
  client: Client,
  authorization = `Bearer ${FIXTURES.token}`,
): Request {
  const concrete = path.replace(/:[A-Za-z0-9_]+\??/g, encodeURIComponent(FIXTURES.hetu));
  const query = new URLSearchParams({
    hetu: FIXTURES.hetu,
    email: FIXTURES.email,
    text: FIXTURES.message,
  });
  const headers: Record<string, string> = {
    authorization,
    cookie: `session=${FIXTURES.token}`,
    "x-probe": FIXTURES.email,
    "x-forwarded-for": client.forwardedFor,
    "cloudfront-viewer-address": client.viewer,
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

/** What @hono/node-server hands a request: the socket it came in on. */
const socketOf = (client: Client) => ({
  incoming: { socket: { remoteAddress: client.socket, remotePort: 40000, remoteFamily: "IPv6" } },
});

/** Which fixture values appear anywhere in the captured lines. */
export function leakedFixtures(lines: LogLine[]): string[] {
  const out = JSON.stringify(lines);
  return Object.entries(FIXTURES)
    .filter(([, value]) => out.includes(value))
    .map(([name]) => name);
}

async function exercise(
  app: ReturnType<typeof createApp>,
  routes: Route[],
  client: Client,
  authorization?: string,
): Promise<number[]> {
  const statuses: number[] = [];
  for (const route of routes) {
    const res = await app.request(requestFor(route, client, authorization), {}, socketOf(client));
    statuses.push(res.status);
  }
  return statuses;
}

const MODES_AND_CLIENTS = TRUSTED_PROXIES.flatMap((mode) =>
  (["ipv4", "ipv6"] as const).map((family) => [mode, family] as const),
);

describe("PII in logs", () => {
  afterAll(closeTestPool);

  it.each(MODES_AND_CLIENTS)(
    "no fixture reaches a log line through any registered route, behind %s, from an %s client",
    async (mode, family) => {
      const { logger, lines } = await captureLogger();
      // Built with media, so the photo routes run their own code and not the 503 of a bare app (#49).
      const app = createApp({
        config: testConfig({ TRUSTED_PROXY: mode }),
        logger,
        db: testPool(),
        media: testMediaDeps().deps,
      });
      const routes = registeredRoutes(app);
      expect(routes.length).toBeGreaterThan(0);
      const statuses = await exercise(app, routes, CLIENTS[family]);
      // The sweep stays under every limit, so each route ran its own code.
      expect(statuses).not.toContain(429);
      expect(lines().length).toBeGreaterThanOrEqual(routes.length); // every request was logged
      expect(leakedFixtures(lines())).toEqual([]);
    },
  );

  // Every refusal of ADR-026 at least once in each mode, each from both
  // families; the statuses show that each limiter read the address and
  // refused, so the absence of the address in its lines is not for want of one.
  test.for(TRUSTED_PROXIES)(
    "no fixture reaches a log line through any refusal of the limits, behind %s",
    async (mode, { ctx }) => {
      const { logger, lines } = await captureLogger();
      const build = (overrides: Record<string, string>) =>
        createApp({
          config: testConfig({ TRUSTED_PROXY: mode, ...overrides }),
          logger,
          db: ctx.client,
        });
      const twice = async (
        app: ReturnType<typeof createApp>,
        route: Route,
        client: Client,
        authorization?: string,
      ) => exercise(app, [route, route], client, authorization);

      // The address's limit, on a route nobody signs in for, and on the two
      // starts it then sends back with a code.
      const byAddress = build({ RATE_LIMIT_PER_MINUTE: "1" });
      const waitlist = { method: "GET", path: "/waitlist" };
      const starts = [
        { method: "GET", path: "/auth/start" },
        { method: "GET", path: "/admin/auth/start" },
      ];
      for (const client of [CLIENTS.ipv4, CLIENTS.ipv6]) {
        expect(await twice(byAddress, waitlist, client)).toEqual([200, 429]);
        expect(await exercise(byAddress, starts, client)).toEqual([302, 302]);
      }

      // The person's limit, an account's and a member of staff's.
      const byPerson = build({ RATE_LIMIT_PER_MINUTE: "1" });
      const account = await signedInAccount(ctx.client, `pii-${mode}`);
      const staff = await staffSession(ctx.client, "moderator", `pii-${mode}`);
      expect(
        await twice(
          byPerson,
          { method: "GET", path: "/auth/session" },
          CLIENTS.ipv4,
          account.headers.authorization,
        ),
      ).toEqual([200, 429]);
      expect(
        await twice(
          byPerson,
          { method: "GET", path: "/admin/whoami" },
          CLIENTS.ipv6,
          staff.headers.authorization,
        ),
      ).toEqual([200, 429]);

      // The doors' window: the starts after the first sent back with a code.
      const doors = build({ SIGN_IN_RATE_LIMIT_PER_MINUTE: "1" });
      for (const client of [CLIENTS.ipv4, CLIENTS.ipv6]) {
        const statuses = await exercise(
          doors,
          [{ method: "GET", path: "/auth/start" }, ...starts],
          client,
        );
        expect(statuses.slice(1)).toEqual([302, 302]);
      }

      const requests = lines().filter((l) => l.msg === "request");
      const refusedFor = (who: Record<string, unknown>) =>
        requests.filter(
          (l) => l.status === 429 && Object.entries(who).every(([k, v]) => l[k] === v),
        );
      expect(refusedFor({ route: "/*", accountId: undefined })).toHaveLength(2);
      expect(refusedFor({ accountId: account.accountId })).toHaveLength(1);
      expect(refusedFor({ staffIdentityId: staff.identityId })).toHaveLength(1);
      const signIns = lines().filter((l) => l.msg === "sign-in refused");
      expect(signIns.map((l) => l.code)).toEqual(Array(8).fill("auth_rate_limited"));
      expect(signIns.every((l) => (l.detail as { limiter?: string }).limiter === "address")).toBe(
        true,
      );
      expect(leakedFixtures(lines())).toEqual([]);
    },
  );

  it("would catch a route that logs its request body", async () => {
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    app.post("/leak", async (c) => {
      // The mistake this test exists for: a stringified body under a key the
      // redaction list cannot know.
      logger.info({ payload: JSON.stringify(await c.req.json()) }, "debug");
      return c.json({ ok: true });
    });
    await exercise(app, [{ method: "POST", path: "/leak" }], CLIENTS.ipv4);
    expect(leakedFixtures(lines())).toEqual(["hetu", "email", "message"]);
  });

  it("would catch a route that logs the client's address, as sent or as the limiter counts it", async () => {
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: testPool() });
    const keyed =
      (mode: TrustedProxy) => async (c: Parameters<ReturnType<typeof addressOf>>[0]) => {
        logger.info({ key: addressOf(mode)(c) }, "debug");
        return c.json({ ok: true });
      };
    app.get("/leak/forwarded", (c) => {
      logger.info({ via: c.req.header("x-forwarded-for") }, "debug");
      return c.json({ ok: true });
    });
    app.get("/leak/viewer-key", keyed("cloudfront"));
    app.get("/leak/socket-key", keyed("none"));

    await exercise(app, [{ method: "GET", path: "/leak/forwarded" }], CLIENTS.ipv4);
    expect(leakedFixtures(lines())).toEqual(["ipv4", "ipv6", "ipv6Prefix"]);

    const before = lines().length;
    await exercise(app, [{ method: "GET", path: "/leak/viewer-key" }], CLIENTS.ipv6);
    // The /64 key, "2001:db8:4711:0::/64", is caught by its prefix.
    expect(leakedFixtures(lines().slice(before))).toEqual(["ipv6Prefix"]);

    const after = lines().length;
    await exercise(app, [{ method: "GET", path: "/leak/socket-key" }], CLIENTS.ipv4);
    expect(leakedFixtures(lines().slice(after))).toEqual(["ipv4"]);
  });
});
