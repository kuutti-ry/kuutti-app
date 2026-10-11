import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit, type TrustedProxy, viewerAddress } from "./rate-limit.ts";
import { serverRequestId } from "./request-id.ts";

function limitedApp(now: () => number, trustedProxy: TrustedProxy = "traefik") {
  const app = new Hono();
  app.use("*", serverRequestId());
  app.use(
    "*",
    rateLimit({ limit: 2, windowMs: 1_000, trustedProxy, skip: (p) => p === "/free", now }),
  );
  app.get("/", (c) => c.text("ok"));
  app.get("/free", (c) => c.text("ok"));
  return app;
}

const from = (headers: Record<string, string>) => ({ headers });

describe("rate limit", () => {
  it("allows the limit, then answers 429 with Retry-After, then resets", async () => {
    let clock = 1_000;
    const app = limitedApp(() => clock);
    const client = from({ "x-forwarded-for": "203.0.113.7" });
    expect((await app.request("/", client)).status).toBe(200);
    expect((await app.request("/", client)).status).toBe(200);
    const blocked = await app.request("/", client);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    clock += 1_001;
    expect((await app.request("/", client)).status).toBe(200);
  });

  // Audit F19 (#52): the first hop is whatever the client wrote before Traefik
  // appended the address it saw. Forging it must not buy a fresh bucket.
  it("behind Traefik, keys on the last forwarded hop, so a forged first hop changes nothing", async () => {
    const app = limitedApp(() => 1_000, "traefik");
    const forgedA = from({ "x-forwarded-for": "198.51.100.1, 203.0.113.9" });
    const forgedB = from({ "x-forwarded-for": "198.51.100.2, 203.0.113.9" });
    const other = from({ "x-forwarded-for": "203.0.113.10" });
    await app.request("/", forgedA);
    await app.request("/", forgedA);
    expect((await app.request("/", forgedB)).status).toBe(429);
    expect((await app.request("/", other)).status).toBe(200);
  });

  it("behind CloudFront, keys on the viewer address CloudFront adds, port dropped, forwarded hops ignored", async () => {
    const app = limitedApp(() => 1_000, "cloudfront");
    const viewer = (port: number, forged: string) =>
      from({ "cloudfront-viewer-address": `198.51.100.7:${port}`, "x-forwarded-for": forged });
    await app.request("/", viewer(4711, "10.0.0.1"));
    await app.request("/", viewer(4712, "10.0.0.2"));
    expect((await app.request("/", viewer(4713, "10.0.0.3"))).status).toBe(429);
    const ipv6 = from({ "cloudfront-viewer-address": "2001:db8::1:40000" });
    expect((await app.request("/", ipv6)).status).toBe(200);
  });

  it("behind CloudFront, a missing or malformed viewer header shares the one bucket, forwarded hops notwithstanding", async () => {
    const app = limitedApp(() => 1_000, "cloudfront");
    await app.request("/", from({ "x-forwarded-for": "1.1.1.1, 198.51.100.7, 130.176.0.1" }));
    await app.request("/", from({ "cloudfront-viewer-address": "not an address" }));
    expect((await app.request("/", from({ "x-forwarded-for": "2.2.2.2" }))).status).toBe(429);
  });

  it("reads only the shapes CloudFront sends", () => {
    expect(viewerAddress("198.51.100.7:4711")).toBe("198.51.100.7");
    expect(viewerAddress("2001:db8::1:40000")).toBe("2001:db8::1");
    expect(viewerAddress("198.51.100.7")).toBeNull();
    expect(viewerAddress("[2001:db8::1]:40000")).toBeNull();
    expect(viewerAddress("bucket-of-my-choosing")).toBeNull();
  });

  it("shares one bucket when the trusted proxy left no address, rather than skipping the limit", async () => {
    const app = limitedApp(() => 1_000, "traefik");
    await app.request("/");
    await app.request("/");
    expect((await app.request("/")).status).toBe(429);
  });

  it("skips exempt paths", async () => {
    const app = limitedApp(() => 1_000);
    for (let i = 0; i < 5; i += 1) expect((await app.request("/free")).status).toBe(200);
  });
});

describe("rate limit with nothing in front (development, tests)", () => {
  // What @hono/node-server hands a request: the socket it came in on.
  const socket = (remoteAddress: string | undefined) => ({
    incoming: { socket: { remoteAddress, remotePort: 40000, remoteFamily: "IPv4" } },
  });

  it("keys on the socket's address and takes no forwarded hop for it", async () => {
    const app = limitedApp(() => 1_000, "none");
    const forged = (hop: string) => ({ headers: { "x-forwarded-for": hop } });
    await app.request("/", forged("198.51.100.1"), socket("192.0.2.1"));
    await app.request("/", forged("198.51.100.2"), socket("192.0.2.1"));
    expect((await app.request("/", forged("198.51.100.3"), socket("192.0.2.1"))).status).toBe(429);
    expect((await app.request("/", {}, socket("192.0.2.2"))).status).toBe(200);
  });

  it("a request with no socket, or a socket with no address, shares the one bucket", async () => {
    const app = limitedApp(() => 1_000, "none");
    await app.request("/");
    await app.request("/", {}, socket(undefined));
    const third = await app.request("/");
    expect(third.status).toBe(429);
    expect(third.headers.get("ratelimit-remaining")).toBe("0");
  });
});

describe("rate limit bookkeeping", () => {
  it("says the limit and what is left on every answer", async () => {
    const app = limitedApp(() => 1_000);
    const client = from({ "x-forwarded-for": "203.0.113.7" });
    const first = await app.request("/", client);
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    await app.request("/", client);
    const blocked = await app.request("/", client);
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    // The window began at 1 000 ms and lasts 1 000: one second left, never zero.
    expect(blocked.headers.get("retry-after")).toBe("1");
  });

  it("answers in the envelope even where no request id was given, with an unknown one", async () => {
    const app = new Hono();
    app.use("*", rateLimit({ limit: 1, windowMs: 60_000, trustedProxy: "traefik", now: () => 0 }));
    app.get("/", (c) => c.text("ok"));
    const client = from({ "x-forwarded-for": "203.0.113.7" });
    await app.request("/", client);
    const blocked = await app.request("/", client);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again in 60 seconds.",
        requestId: "unknown",
      },
    });
  });

  it("past ten thousand clients forgets the windows that are over, and only those", async () => {
    let clock = 0;
    const app = limitedApp(() => clock);
    for (let i = 0; i <= 10_000; i += 1) {
      const address = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await app.request("/", from({ "x-forwarded-for": address }));
    }
    // A client still inside its window when the old ones are forgotten.
    clock = 900;
    const busy = from({ "x-forwarded-for": "198.51.100.9" });
    await app.request("/", busy);
    await app.request("/", busy);
    expect((await app.request("/", busy)).status).toBe(429);
    // The first windows are over; the next request forgets them, and not the busy one's.
    clock = 1_500;
    expect((await app.request("/", from({ "x-forwarded-for": "198.51.100.10" }))).status).toBe(200);
    expect((await app.request("/", busy)).status).toBe(429);
    expect((await app.request("/", from({ "x-forwarded-for": "10.0.0.0" }))).status).toBe(200);
  });
});
