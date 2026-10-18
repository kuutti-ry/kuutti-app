import { createHash } from "node:crypto";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { IdentityBroker } from "../identity/index.ts";
import { addressOf, TRUSTED_PROXIES, type TrustedProxy } from "../lib/rate-limit.ts";
import { signedInAccount, staffSession } from "./account.ts";
import { conversationBetween } from "./chat.ts";
import {
  captureLogger,
  closeTestPool,
  type LogLine,
  test,
  testConfig,
  testPool,
} from "./harness.ts";
import { fixturePng, testMediaDeps } from "./media.ts";

/** The verifier of a sign-in attempt, as the app makes one (ADR-027): 256 bits as lowercase hex. */
const VERIFIER_PROBE = "4711beef".repeat(8);

/**
 * The enforcement behind "logs never carry hetu, message text or email"
 * (CLAUDE.md security defaults, rule 5, #11), nor the client's address
 * (ADR-026 §7), nor what binds a sign-in code to its phone (ADR-027). Every
 * route the app registers is exercised with fixtures in the body, the query
 * string, the path and the headers, from an address in every place an
 * address can come from, and no fixture may reach a log line.
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
  verifier: VERIFIER_PROBE,
  // Its SHA-256, which the start carries in the query.
  challenge: createHash("sha256").update(VERIFIER_PROBE).digest("hex"),
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
            // A message's text (#348), under the name the send takes it by, and a photo's caption (#350).
            body: FIXTURES.message,
            caption: FIXTURES.message,
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

  // The sweep above sends JSON, which the photo route refuses before its
  // handler (#350): a multipart send of its own, sent and refused.
  test("no caption reaches a log line through a photo sent in a conversation", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    const app = createApp({
      config: testConfig(),
      logger,
      db: ctx.client,
      media: testMediaDeps().deps,
    });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const send = async (caption: string) => {
      const form = new FormData();
      const bytes = await fixturePng(320, 240);
      form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "p.png");
      form.append("clientId", crypto.randomUUID());
      form.append("caption", caption);
      return app.request(`/conversations/${id}/photos`, {
        method: "POST",
        headers: a.headers,
        body: form,
      });
    };
    expect((await send(FIXTURES.message)).status).toBe(201);
    expect((await send(`${FIXTURES.message} ${FIXTURES.email}`)).status).toBe(400);
    expect(lines().length).toBeGreaterThan(0);
    expect(leakedFixtures(lines())).toEqual([]);
  });

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

  test("no fixture reaches a log line through a bank login, its verifier and its challenge refused and taken", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    let x = 4711;
    const hetu = generateHetu(
      () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      },
      { minAge: 25, maxAge: 40 },
    );
    const bank: IdentityBroker = {
      issuer: "https://broker.test/uas",
      async startLogin(input) {
        const url = new URL("https://broker.test/uas/oauth2/authorization");
        url.searchParams.set("state", input.state);
        return url;
      },
      async completeLogin() {
        return {
          hetu,
          subject: "PII-PROBE-SUBJECT",
          sessionIndex: null,
          tokenId: null,
          authenticatedAt: new Date(),
          acr: "http://ftn.ficora.fi/2017/loatest2",
          amr: [],
        };
      },
    };
    const app = createApp({
      config: testConfig({ HETU_HMAC_KEY: "47".repeat(32) }),
      logger,
      db: ctx.client,
      broker: bank,
    });
    const start = (challenge: string) =>
      app.request(`/auth/start?platform=ios&locale=fi&code_challenge=${challenge}`);
    const exchange = (code: string, verifier: string) =>
      app.request("/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier }),
      });
    const unknown = "A".repeat(43);

    // Each malformed, with the fixture whole inside it: refused at the validation.
    expect((await start(`${FIXTURES.challenge}0`)).status).toBe(400);
    expect((await exchange(unknown, `${FIXTURES.verifier}0`)).status).toBe(400);
    // A code nobody issued, with the verifier.
    expect((await exchange(unknown, FIXTURES.verifier)).status).toBe(401);
    // A login started with the challenge: a wrong verifier, its own, then its own again.
    const started = await start(FIXTURES.challenge);
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const back = await app.request(`/auth/callback?code=good&state=${encodeURIComponent(state)}`);
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await exchange(code, "0".repeat(64))).status).toBe(401);
    const own = await exchange(code, FIXTURES.verifier);
    expect(own.status).toBe(200);
    const tokens = (await own.json()) as { accessToken: string; refreshToken: string };
    expect((await exchange(code, FIXTURES.verifier)).status).toBe(401);

    // The login left its line, so the absence below is not for want of lines.
    expect(lines().some((l) => l.msg === "bank login")).toBe(true);
    expect(leakedFixtures(lines())).toEqual([]);
    const out = JSON.stringify(lines());
    for (const secret of [hetu, code, tokens.accessToken, tokens.refreshToken]) {
      expect(out).not.toContain(secret);
    }
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
