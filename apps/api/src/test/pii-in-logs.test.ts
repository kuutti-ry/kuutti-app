import { createHash } from "node:crypto";
import type { Queryable } from "@kuutti/db";
import { generateHetu } from "@kuutti/tunnistus-oidc/hetu";
import type { QueryResultRow } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { IdentityBroker } from "../identity/index.ts";
import { type Mailer, type MailMessage, sesMailer } from "../lib/mail.ts";
import { addressOf, TRUSTED_PROXIES, type TrustedProxy } from "../lib/rate-limit.ts";
import { signedInAccount, staffSession, withMatchingConfig } from "./account.ts";
import { cardShown } from "./cards.ts";
import { conversationBetween, photoMessage } from "./chat.ts";
import {
  captureLogger,
  closeTestPool,
  type LogLine,
  test,
  testConfig,
  testPool,
} from "./harness.ts";
import { fixturePng, testMediaDeps } from "./media.ts";
import { accountOf } from "./reports.ts";

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

  // A report from a conversation (#351, ADR-030 §12): a thread whose words are
  // the fixture, copied into the report with a note that quotes it, then the
  // same report again, one the contract refuses, one past the window and one
  // over the day's cap. The words reach no log line, answer or research event.
  test("No message text reaches a log line, an answer or an event through a report's frozen copy", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const app = createApp({ config: testConfig(), logger, db: ctx.client });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const c = await signedInAccount(ctx.client);
    const words = [
      { from: "a" as const, body: FIXTURES.message },
      { from: "b" as const, body: FIXTURES.message },
    ];
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId, { messages: words });
    const late = await conversationBetween(ctx.client, c.accountId, b.accountId, {
      messages: words,
    });
    const full = await conversationBetween(ctx.client, b.accountId, c.accountId, {
      messages: words,
    });
    const report = (who: { headers: Record<string, string> }, at: string, note: string) =>
      app.request(`/conversations/${at}/report`, {
        method: "POST",
        headers: { ...who.headers, "content-type": "application/json" },
        body: JSON.stringify({ reason: "harassment", note }),
      });
    const answers: Response[] = [];
    answers.push(await report(a, id, `${FIXTURES.message} ${"x".repeat(500)}`));
    answers.push(await report(a, id, `He wrote: ${FIXTURES.message}`));
    answers.push(await report(a, id, `Again: ${FIXTURES.message}`));
    await ctx.client.query(
      "UPDATE conversation SET closed_at = now() - interval '400 days', closed_how = 'unmatch', closed_by = 'a' WHERE id = $1",
      [late],
    );
    answers.push(await report(c, late, FIXTURES.message));
    await withMatchingConfig(ctx.client, { reports_per_day: 0 });
    answers.push(await report(b, full, FIXTURES.message));
    expect(answers.map((answer) => answer.status)).toEqual([400, 204, 204, 409, 429]);
    for (const answer of answers) expect(await answer.text()).not.toContain(FIXTURES.message);
    // The copy holds the words: the moderators' to read, nobody's log.
    expect(
      Number(
        (
          await ctx.client.query<{ n: string }>(
            "SELECT count(*) AS n FROM report_message WHERE body = $1",
            [FIXTURES.message],
          )
        ).rows[0]?.n,
      ),
    ).toBe(2);
    expect(lines().length).toBeGreaterThan(0);
    expect(leakedFixtures(lines())).toEqual([]);
    const events = await ctx.client.query("SELECT props FROM events");
    expect(JSON.stringify(events.rows)).not.toContain(FIXTURES.message);
  });

  // A report worked by the moderators (#312): opened with its note and copy,
  // its photo asked for and the report dismissed, by a moderator; the same by
  // a member of staff who is a party and by a researcher. The moderator's
  // opened report carries the words, on purpose; nothing else does.
  test("No word of the note or the copy reaches a log line, an error answer or an event", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const media = testMediaDeps();
    const app = createApp({ config: testConfig(), logger, db: ctx.client, media: media.deps });
    const moderator = await staffSession(ctx.client, "moderator");
    const party = await staffSession(ctx.client, "moderator");
    const researcher = await staffSession(ctx.client, "researcher");
    const a = await signedInAccount(ctx.client);
    // The reported person is the party's own account.
    const b = await accountOf(ctx.client, party.identityId);
    const id = await conversationBetween(ctx.client, a.accountId, b, {
      messages: [
        { from: "a", body: FIXTURES.message },
        { from: "b", body: FIXTURES.message },
      ],
    });
    const sent = await photoMessage(ctx.client, {
      conversationId: id,
      accountId: b,
      side: "b",
      caption: FIXTURES.message,
      store: media.store,
    });
    const filed = await app.request(`/conversations/${id}/report`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ reason: "harassment", note: `He wrote: ${FIXTURES.message}` }),
    });
    expect(filed.status).toBe(204);
    const report = await ctx.client.query<{ id: string }>(
      "SELECT id FROM report WHERE conversation_id = $1",
      [id],
    );
    const reportId = report.rows[0]?.id as string;
    const work = (headers: Record<string, string>) => [
      () => app.request(`/admin/reports/${reportId}`, { headers }),
      () => app.request(`/admin/reports/${reportId}/copy/${sent.seq}/photo`, { headers }),
      () =>
        app.request(`/admin/reports/${reportId}/decision`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ outcome: "dismissed" }),
        }),
    ];
    const refused: Response[] = [];
    for (const who of [party, researcher]) {
      for (const send of work(who.headers)) refused.push(await send());
    }
    expect(refused.map((answer) => answer.status)).toEqual([404, 404, 404, 403, 403, 403]);
    for (const answer of refused) expect(await answer.text()).not.toContain(FIXTURES.message);
    const [openIt, photoIt, dismissIt] = work(moderator.headers);
    const opened = await (openIt as () => Promise<Response>)();
    expect(opened.status).toBe(200);
    // The moderators' to read: the note and both lines, the caption among them.
    expect(await opened.text()).toContain(FIXTURES.message);
    for (const send of [photoIt, dismissIt] as Array<() => Promise<Response>>) {
      const answer = await send();
      expect(answer.status).toBe(200);
      expect(await answer.text()).not.toContain(FIXTURES.message);
    }
    expect(lines().length).toBeGreaterThan(0);
    expect(leakedFixtures(lines())).toEqual([]);
    const events = await ctx.client.query("SELECT props FROM events");
    expect(JSON.stringify(events.rows)).not.toContain(FIXTURES.message);
  });

  // The automatic rules (#105, ADR-033): five openers of the fixture, the
  // fifth through the send route, which meets the same-first-message rule;
  // a moderator confirms the ban. The words are compared in memory and reach
  // no log line, answer, event, sanction column or audit detail.
  test("No word of a first message reaches a log line, an event or the rule's record", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    // A clock a second later at each reading, from a fixed instant.
    const start = Date.parse("2026-10-16T09:00:00.000Z");
    let tick = start;
    const app = createApp({
      config: testConfig(),
      logger,
      db: ctx.client,
      now: () => {
        tick += 1000;
        return new Date(tick);
      },
    });
    const moderator = await staffSession(ctx.client, "moderator");
    const a = await signedInAccount(ctx.client);
    const now = start;
    for (let i = 0; i < 4; i++) {
      const other = await signedInAccount(ctx.client);
      await conversationBetween(ctx.client, a.accountId, other.accountId, {
        openedAt: new Date(now - (5 - i) * 3_600_000),
        messages: [{ from: "a", body: FIXTURES.message, at: new Date(now - (4 - i) * 3_600_000) }],
      });
    }
    const fifth = await signedInAccount(ctx.client);
    const id = await conversationBetween(ctx.client, a.accountId, fifth.accountId, {
      openedAt: new Date(now - 60_000),
    });
    const sent = await app.request(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: JSON.stringify({ clientId: crypto.randomUUID(), body: FIXTURES.message }),
    });
    expect(sent.status).toBe(201);
    const ban = await ctx.client.query<{ id: string }>(
      "SELECT id FROM sanction WHERE account_id = $1 AND rule = 'same_first_message'",
      [a.accountId],
    );
    const banId = ban.rows[0]?.id;
    expect(banId).toBeDefined();
    const confirmed = await app.request(`/admin/sanctions/${banId}/review`, {
      method: "POST",
      headers: { ...moderator.headers, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "keep", note: "Five copies of one opener; it stands." }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).not.toContain(FIXTURES.message);
    expect(lines().length).toBeGreaterThan(0);
    expect(leakedFixtures(lines())).toEqual([]);
    const kept = await ctx.client.query("SELECT * FROM sanction WHERE account_id = $1", [
      a.accountId,
    ]);
    expect(JSON.stringify(kept.rows)).not.toContain(FIXTURES.message);
    const audit = await ctx.client.query("SELECT detail FROM audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain(FIXTURES.message);
    const events = await ctx.client.query("SELECT props FROM events");
    expect(JSON.stringify(events.rows)).not.toContain(FIXTURES.message);
  });

  // The velocity rules (#86, ADR-041): other people's photos fetched and the
  // round read until both rules are met, every request carrying the
  // fixtures. The checks' own lines carry the rule and its count, nothing
  // else; no line carries a fixture, nor the photos' owners, whose photos the
  // fetcher's lines name by id only.
  test("No line of a velocity check names a person or carries a fixture", async ({ ctx }) => {
    const { logger, lines } = await captureLogger();
    let tick = Date.parse("2026-10-16T09:00:00.000Z");
    const app = createApp({
      config: testConfig(),
      logger,
      db: ctx.client,
      now: () => new Date(tick),
      media: testMediaDeps().deps,
    });
    const a = await signedInAccount(ctx.client);
    const owner = await signedInAccount(ctx.client);
    const photo = await cardShown(
      ctx.client,
      a.accountId,
      owner.accountId,
      new Date(tick - 7_200_000),
    );
    await ctx.client.query(
      `INSERT INTO photo_access (account_id, photo_id, variant, at)
       SELECT $1, $2, 'card', $3::timestamptz - g * interval '1 second' FROM generate_series(1, 119) g`,
      [a.accountId, photo, new Date(tick)],
    );
    const probe = `?${new URLSearchParams({ hetu: FIXTURES.hetu, email: FIXTURES.email, text: FIXTURES.message })}`;
    const headers = { ...a.headers, "x-probe": FIXTURES.email, cookie: `note=${FIXTURES.message}` };
    expect((await app.request(`/photos/${photo}/card${probe}`, { headers })).status).toBe(200);
    // A second account whose reads meet the round's rule, so both checks write their line.
    const b = await signedInAccount(ctx.client);
    const bHeaders = { ...b.headers, "x-probe": FIXTURES.email };
    for (let i = 0; i < 30; i++) {
      tick += 1000;
      expect((await app.request(`/rounds/today${probe}`, { headers: bHeaders })).status).toBe(200);
    }
    const banned = lines().filter((line) => line.msg === "automatic shadow ban");
    expect(banned.map(({ rule, count }) => ({ rule, count }))).toEqual([
      { rule: "photo_fetches", count: 120 },
      { rule: "round_reads", count: 30 },
    ]);
    for (const line of banned) {
      expect(Object.keys(line).sort()).toEqual(
        ["count", "hostname", "level", "msg", "pid", "rule", "time"].sort(),
      );
    }
    expect(leakedFixtures(lines())).toEqual([]);
    expect(JSON.stringify(lines())).not.toContain(owner.accountId);
    const kept = await ctx.client.query("SELECT * FROM sanction");
    expect(JSON.stringify(kept.rows)).not.toContain(owner.accountId);
  });

  // A stored contact (#103, ADR-031 §11): a phone number and a username, kept,
  // refused by their kind's rule and by the contract, shared, read on both
  // sides (the detail and the contacts alone), stopped and removed, and a
  // keep interrupted by a fault.
  test("No contact reaches a log line, an error detail or an error report", async ({ ctx }) => {
    const PHONE = { typed: "040 471 1047", stored: "+358404711047" };
    const HANDLE = { typed: "@piiprobe_4711", stored: "piiprobe_4711" };
    const REFUSED = "piiprobe..4711";
    const reports: unknown[] = [];
    const { logger, lines } = await captureLogger();
    let failed = false;
    const db: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
        if (!failed && /INSERT INTO contact \(/.test(text)) {
          failed = true;
          throw new Error("Connection terminated unexpectedly");
        }
        return ctx.client.query<R>(text, values);
      },
    };
    const app = createApp({
      config: testConfig(),
      logger,
      db,
      report: (error, context) => reports.push({ error: String(error), context }),
    });
    const a = await signedInAccount(ctx.client);
    const b = await signedInAccount(ctx.client);
    const id = await conversationBetween(ctx.client, a.accountId, b.accountId);
    const json = { ...a.headers, "content-type": "application/json" };
    const keep = (kind: string, value: string) =>
      app.request(`/contacts/${kind}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ value }),
      });
    const statuses = [
      (await keep("phone", PHONE.typed)).status,
      (await keep("phone", PHONE.typed)).status,
      (await keep("telegram", HANDLE.typed)).status,
      (await keep("instagram", REFUSED)).status,
      (await keep("instagram", HANDLE.stored.repeat(5))).status,
      (
        await app.request(`/conversations/${id}/contacts/phone`, {
          method: "POST",
          headers: a.headers,
        })
      ).status,
      (
        await app.request(`/conversations/${id}/contacts/telegram`, {
          method: "POST",
          headers: a.headers,
        })
      ).status,
      (await app.request(`/conversations/${id}`, { headers: b.headers })).status,
      (await app.request(`/conversations/${id}/contacts`, { headers: b.headers })).status,
      (await app.request("/contacts", { headers: a.headers })).status,
      (
        await app.request(`/conversations/${id}/contacts/telegram`, {
          method: "DELETE",
          headers: a.headers,
        })
      ).status,
      (await app.request("/contacts/phone", { method: "DELETE", headers: a.headers })).status,
    ];
    expect(statuses).toEqual([500, 200, 200, 400, 400, 200, 200, 200, 200, 200, 200, 204]);
    expect(reports).toHaveLength(1);
    const out = JSON.stringify(lines());
    for (const value of [PHONE.typed, PHONE.stored, "4711047", HANDLE.stored, REFUSED]) {
      expect(out).not.toContain(value);
      expect(JSON.stringify(reports)).not.toContain(value);
    }
    // The refusal names the kind, and the request lines name the routes.
    expect(lines().find((l) => l.code === "contact_invalid")?.detail).toEqual({
      kind: "instagram",
    });
    expect(lines().filter((l) => l.msg === "request")).toHaveLength(statuses.length);
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

  // The sweep's fake session never reaches the e-mail's handlers (#385,
  // ADR-043 §7): a person's own address through a send SES refuses with the
  // address in its message, a send that works, a wrong code, the right one
  // and the removal. Neither the address nor the code reaches a log line.
  test("no address or code reaches a log line through the e-mail's confirmation", async ({
    ctx,
  }) => {
    const { logger, lines } = await captureLogger();
    const refused = Object.assign(
      new Error(
        `Email address is not verified. The following identities failed: ${FIXTURES.email}`,
      ),
      { name: "MessageRejected", $metadata: { httpStatusCode: 400 } },
    );
    const sent: MailMessage[] = [];
    const build = (mailer: Mailer) =>
      createApp({ config: testConfig(), logger, db: ctx.client, mailer });
    const failing = build(
      sesMailer({ send: () => Promise.reject(refused) } as Parameters<typeof sesMailer>[0], "x"),
    );
    const working = build({ send: async (message) => void sent.push(message) });
    const a = await signedInAccount(ctx.client);
    const call = (app: ReturnType<typeof createApp>, method: string, path: string, body?: object) =>
      app.request(path, {
        method,
        headers: { ...a.headers, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    expect((await call(working, "PUT", "/account/email", { email: FIXTURES.email })).status).toBe(
      200,
    );
    expect((await call(failing, "POST", "/account/email/code")).status).toBe(503);
    expect((await call(working, "POST", "/account/email/code")).status).toBe(200);
    const code = /\b\d{6}\b/.exec(sent[0]?.text ?? "")?.[0] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === "000000" ? "000001" : "000000";
    const confirm = (c: string) => call(working, "POST", "/account/email/confirm", { code: c });
    expect((await confirm(wrong)).status).toBe(400);
    expect((await confirm(code)).status).toBe(200);
    expect((await call(working, "DELETE", "/account/email")).status).toBe(204);

    // Each step left its line, so the absence below is not for want of lines.
    const said = lines().map((l) => l.msg);
    for (const msg of ["email set", "email code not sent", "email code sent", "email confirmed"]) {
      expect(said).toContain(msg);
    }
    expect(leakedFixtures(lines())).toEqual([]);
    // The code as a value anywhere in a line; a quoted match, since six digits
    // can occur by chance inside an id or a time.
    expect(JSON.stringify(lines())).not.toContain(`"${code}"`);
    expect(JSON.stringify(lines())).not.toContain(` ${code}`);
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
