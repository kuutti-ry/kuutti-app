import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env.ts";
import {
  addressOf,
  personOf,
  rateLimit,
  TRUSTED_PROXIES,
  type TrustedProxy,
  viewerAddress,
} from "./rate-limit.ts";
import { serverRequestId } from "./request-id.ts";

function limitedApp(now?: () => number, trustedProxy: TrustedProxy = "traefik") {
  const app = new Hono<AppEnv>();
  app.use("*", serverRequestId());
  app.use(
    "*",
    rateLimit({
      limit: 2,
      windowMs: 1_000,
      keyOf: addressOf(trustedProxy),
      skip: (p) => p === "/free",
      now,
    }),
  );
  app.get("/", (c) => c.text("ok"));
  app.get("/free", (c) => c.text("ok"));
  return app;
}

const from = (headers: Record<string, string>) => ({ headers });

// What @hono/node-server hands a request: the socket it came in on.
const socket = (remoteAddress: string | undefined) => ({
  incoming: { socket: { remoteAddress, remotePort: 40000, remoteFamily: "IPv4" } },
});

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

  // ADR-026 §1: what does not parse as an address is no address, so it cannot
  // buy a bucket of its own by being written a new way each time.
  it("behind Traefik, a hop that is no address shares the one bucket with no hop at all", async () => {
    const app = limitedApp(() => 1_000, "traefik");
    await app.request("/", from({ "x-forwarded-for": "not-an-address" }));
    await app.request("/", from({ "x-forwarded-for": "203.0.113.256" }));
    expect((await app.request("/")).status).toBe(429);
    expect((await app.request("/", from({ "x-forwarded-for": "2001:db8::g" }))).status).toBe(429);
    expect((await app.request("/", from({ "x-forwarded-for": "203.0.113.7" }))).status).toBe(200);
  });

  it("skips exempt paths", async () => {
    const app = limitedApp(() => 1_000);
    for (let i = 0; i < 5; i += 1) expect((await app.request("/free")).status).toBe(200);
  });
});

describe("rate limit with nothing in front (development, tests)", () => {
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

/** The key addressOf gives a request that carries `address` where `trusted` reads it. */
async function keyOf(
  trusted: TrustedProxy,
  address: string,
  options: { ipv6Prefix?: number } = {},
): Promise<string | null> {
  const app = new Hono<AppEnv>();
  app.get("/", (c) => c.json({ key: addressOf(trusted, options)(c) }));
  const res =
    trusted === "none"
      ? await app.request("/", {}, socket(address))
      : await app.request(
          "/",
          from(
            trusted === "traefik"
              ? { "x-forwarded-for": address }
              : { "cloudfront-viewer-address": `${address}:4711` },
          ),
        );
  return ((await res.json()) as { key: string | null }).key;
}

describe("the address a request is counted by (ADR-026 §1)", () => {
  it.each(TRUSTED_PROXIES)("through %s, an IPv4 address counts as itself", async (trusted) => {
    expect(await keyOf(trusted, "203.0.113.47")).toBe("203.0.113.47");
  });

  it.each(TRUSTED_PROXIES)(
    "through %s, an IPv6 address counts by its /64, however it is written",
    async (trusted) => {
      const keys = await Promise.all(
        [
          "2001:db8:4711::47",
          "2001:0DB8:4711:0000:0000:0000:0000:0047",
          "2001:db8:4711:0:abcd:ef01:2345:6789",
          "2001:db8:4711::",
        ].map((address) => keyOf(trusted, address)),
      );
      expect(new Set(keys)).toEqual(new Set(["2001:db8:4711:0::/64"]));
      expect(await keyOf(trusted, "2001:db8:4712::47")).toBe("2001:db8:4712:0::/64");
    },
  );

  it("counts the /64 whether the zeros the address leaves out are inside it or after it", async () => {
    // The canonical form compresses the longest run of zeros: inside the
    // prefix for the first, after it for the second, and both are one /64.
    expect(await keyOf("traefik", "2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(await keyOf("traefik", "2001:db8:0:0:1::")).toBe("2001:db8:0:0::/64");
    expect(await keyOf("traefik", "2001:db8:0:1::")).toBe("2001:db8:0:1::/64");
  });

  // A dual-stack socket reports an IPv4 client so; it must not be a second
  // bucket for the same client.
  it.each(["::ffff:203.0.113.47", "::FFFF:CB00:712F", "0:0:0:0:0:ffff:203.0.113.47"])(
    "an IPv4-mapped address (%s) counts as the IPv4 it maps",
    async (mapped) => {
      expect(await keyOf("none", mapped)).toBe("203.0.113.47");
      expect(await keyOf("traefik", mapped)).toBe("203.0.113.47");
    },
  );

  it("drops a zone, which names the box's interface and not the client", async () => {
    expect(await keyOf("none", "fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(await keyOf("none", "fe80::2")).toBe("fe80:0:0:0::/64");
  });

  it.each(["not-an-address", "203.0.113.256", "1.2.3", "2001:db8::g", "2001:db8:::1"])(
    "%s is no address",
    async (written) => {
      expect(await keyOf("traefik", written)).toBeNull();
      expect(await keyOf("none", written)).toBeNull();
    },
  );

  it.each(TRUSTED_PROXIES)(
    "through %s, addresses of one /64 spend one budget and another /64 has its own",
    async (trusted) => {
      const app = limitedApp(() => 1_000, trusted);
      const carrying = (address: string) =>
        trusted === "none"
          ? app.request("/", {}, socket(address))
          : app.request(
              "/",
              from(
                trusted === "traefik"
                  ? { "x-forwarded-for": address }
                  : { "cloudfront-viewer-address": `${address}:443` },
              ),
            );
      expect((await carrying("2001:db8:4711::1")).status).toBe(200);
      expect((await carrying("2001:db8:4711:0:ffff:1:2:3")).status).toBe(200);
      expect((await carrying("2001:db8:4711::9")).status).toBe(429);
      expect((await carrying("2001:db8:4712::1")).status).toBe(200);
    },
  );
});

// The sign-in doors' key (ADR-026 §4): one subscriber is usually given a
// /56, so the doors count an IPv6 client by it; the other limits keep the /64.
describe("the address counted by a wider IPv6 prefix", () => {
  const AT_56 = { ipv6Prefix: 56 };
  /** The 256 /64s of 2001:db8:4711:ab00::/56, each with an address of its own. */
  const sixtyFours = Array.from(
    { length: 256 },
    (_, i) => `2001:db8:4711:ab${i.toString(16).padStart(2, "0")}:${i.toString(16)}::${i + 1}`,
  );

  it.each(TRUSTED_PROXIES)("through %s, the 256 /64s of one /56 are one key", async (trusted) => {
    const keys = await Promise.all(sixtyFours.map((address) => keyOf(trusted, address, AT_56)));
    expect(new Set(keys)).toEqual(new Set(["2001:db8:4711:ab00::/56"]));
    // By the default /64 they are 256.
    const narrow = await Promise.all(sixtyFours.map((address) => keyOf(trusted, address)));
    expect(new Set(narrow).size).toBe(256);
  });

  it("two /56s are two keys, however close", async () => {
    expect(await keyOf("traefik", "2001:db8:4711:abff::1", AT_56)).toBe("2001:db8:4711:ab00::/56");
    expect(await keyOf("traefik", "2001:db8:4711:ac00::1", AT_56)).toBe("2001:db8:4711:ac00::/56");
    expect(await keyOf("traefik", "2001:db8:4712:ab00::1", AT_56)).toBe("2001:db8:4712:ab00::/56");
    // The zeros the address leaves out, inside the prefix or after it.
    expect(await keyOf("traefik", "2001:db8::", AT_56)).toBe("2001:db8:0:0::/56");
    expect(await keyOf("traefik", "2001:db8:0:ff::", AT_56)).toBe("2001:db8:0:0::/56");
  });

  it("leaves an IPv4 address, a mapped one and no address as they are", async () => {
    expect(await keyOf("traefik", "203.0.113.47", AT_56)).toBe("203.0.113.47");
    expect(await keyOf("none", "::ffff:203.0.113.47", AT_56)).toBe("203.0.113.47");
    expect(await keyOf("traefik", "::FFFF:CB00:712F", AT_56)).toBe("203.0.113.47");
    expect(await keyOf("traefik", "not-an-address", AT_56)).toBeNull();
  });

  it("one /56 spends one budget across its /64s, and another /56 has its own", async () => {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        limit: 256,
        windowMs: 1_000,
        keyOf: addressOf("traefik", AT_56),
        now: () => 0,
      }),
    );
    app.get("/", (c) => c.text("ok"));
    const carrying = (address: string) => app.request("/", from({ "x-forwarded-for": address }));
    for (const address of sixtyFours) expect((await carrying(address)).status).toBe(200);
    expect((await carrying("2001:db8:4711:ab80::4711")).status).toBe(429);
    expect((await carrying("2001:db8:4711:ac00::1")).status).toBe(200);
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

  it("a window is over at its last millisecond, not before", async () => {
    let clock = 0;
    const app = limitedApp(() => clock);
    const client = from({ "x-forwarded-for": "203.0.113.7" });
    await app.request("/", client);
    await app.request("/", client);
    clock = 999;
    expect((await app.request("/", client)).status).toBe(429);
    clock = 1_000;
    expect((await app.request("/", client)).status).toBe(200);
  });

  it("answers in the envelope even where no request id was given, with an unknown one", async () => {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({ limit: 1, windowMs: 60_000, keyOf: addressOf("traefik"), now: () => 0 }),
    );
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

  it("answers with the refusal it was given, Retry-After set and the wait handed to it", async () => {
    const waits: number[] = [];
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        limit: 1,
        windowMs: 30_000,
        keyOf: () => "one",
        now: () => 0,
        refuse: (c, retryAfterSeconds) => {
          waits.push(retryAfterSeconds);
          return c.text("come back later", 503);
        },
      }),
    );
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
    const refused = await app.request("/");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("come back later");
    expect(refused.headers.get("retry-after")).toBe("30");
    expect(waits).toEqual([30]);
  });
});

describe("the key a limiter counts by", () => {
  function keyedApp() {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        limit: 1,
        windowMs: 1_000,
        keyOf: (c) => c.req.header("x-who") ?? null,
        now: () => 0,
      }),
    );
    app.get("/", (c) => c.text("ok"));
    return app;
  }

  it("is whatever its key function says, one budget per key", async () => {
    const app = keyedApp();
    const as = (who: string) => from({ "x-who": who });
    expect((await app.request("/", as("a"))).status).toBe(200);
    expect((await app.request("/", as("a"))).status).toBe(429);
    expect((await app.request("/", as("b"))).status).toBe(200);
  });

  it("a request with no key shares one budget with every other, rather than passing unlimited", async () => {
    const app = keyedApp();
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
    // A named key keeps its own budget meanwhile.
    expect((await app.request("/", from({ "x-who": "a" }))).status).toBe(200);
  });
});

describe("a count given back (ADR-026 §2)", () => {
  function refundingApp(now: () => number) {
    const app = new Hono<AppEnv>();
    app.use(
      "*",
      rateLimit({
        limit: 1,
        windowMs: 1_000,
        keyOf: () => "address",
        // As app.ts asks it: once the request is answered, did a guard admit somebody?
        refund: (c) => c.get("accountId") !== undefined,
        now,
      }),
    );
    app.get("/person", (c) => {
      c.set("accountId", "acc-1");
      return c.text("ok");
    });
    app.get("/anonymous", (c) => c.text("ok"));
    return app;
  }

  it("leaves the budget as it was, and is asked only once the request has been answered", async () => {
    const app = refundingApp(() => 0);
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request("/person");
      expect(res.status).toBe(200);
    }
    expect((await app.request("/anonymous")).status).toBe(200);
    expect((await app.request("/anonymous")).status).toBe(429);
  });

  it("goes back to the window it was taken from, never to the next one", async () => {
    let clock = 0;
    const app = refundingApp(() => clock);
    // A person's request held open across the end of its window, released by the test.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.get("/slow", async (c) => {
      c.set("accountId", "acc-1");
      entered();
      await gate;
      return c.text("ok");
    });
    const slow = app.request("/slow");
    await inside;
    clock = 1_000;
    expect((await app.request("/anonymous")).status).toBe(200);
    release();
    expect((await slow).status).toBe(200);
    // The new window spent its one request, and the old window's count did not reopen it.
    expect((await app.request("/anonymous")).status).toBe(429);
  });
});

describe("one request, counted once (ADR-026 §3)", () => {
  it("one limiter that runs twice on a request, as on routes whose patterns overlap, counts it once", async () => {
    const limiter = rateLimit({ limit: 2, windowMs: 1_000, keyOf: () => "one", now: () => 0 });
    const app = new Hono<AppEnv>();
    app.use("/photos/:id", limiter);
    app.use("/photos/order", limiter);
    app.put("/photos/order", (c) => c.text("ok"));
    const first = await app.request("/photos/order", { method: "PUT" });
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect((await app.request("/photos/order", { method: "PUT" })).status).toBe(200);
    expect((await app.request("/photos/order", { method: "PUT" })).status).toBe(429);
  });

  it("another limiter counts the same request again: the address's and the person's are two", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", rateLimit({ limit: 5, windowMs: 1_000, keyOf: () => "address", now: () => 0 }));
    app.use(
      "*",
      rateLimit({
        limit: 1,
        windowMs: 1_000,
        keyOf: () => "person",
        now: () => 0,
        refuse: (c) => c.text("the person's", 429),
      }),
    );
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
    const second = await app.request("/");
    expect(second.status).toBe(429);
    expect(await second.text()).toBe("the person's");
  });

  it("a request it skips is not counted", async () => {
    const limiter = rateLimit({
      limit: 1,
      windowMs: 1_000,
      keyOf: () => "one",
      skip: (path) => path === "/health",
      now: () => 0,
    });
    const app = new Hono<AppEnv>();
    app.use("*", limiter);
    app.get("/health", (c) => c.text("ok"));
    app.get("/", (c) => c.text("ok"));
    for (let i = 0; i < 3; i += 1) expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
  });
});

describe("how long a key is held (ADR-026 §7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The bucket map is the limiter's own; its sweep timer is armed exactly
  // while the map holds a key, so the pending timers say whether it does.
  it("drops a window once it is over, without another request, and keeps one that is not", async () => {
    vi.useFakeTimers({ now: 0 });
    const app = limitedApp();
    expect(vi.getTimerCount()).toBe(0);
    await app.request("/", from({ "x-forwarded-for": "203.0.113.7" }));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(500);
    const busy = from({ "x-forwarded-for": "198.51.100.9" });
    await app.request("/", busy);
    await app.request("/", busy);
    expect((await app.request("/", busy)).status).toBe(429);

    // At 1 000 the first window is over and dropped; the busy one's runs to 1 500.
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(1);
    expect((await app.request("/", busy)).status).toBe(429);
    expect((await app.request("/", from({ "x-forwarded-for": "203.0.113.7" }))).status).toBe(200);

    // By 2 000 both are over, both dropped, and nothing is left to sweep.
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect((await app.request("/", busy)).status).toBe(200);
  });

  it("holds a key two windows at most, even when it arrives just after the sweep was armed", async () => {
    vi.useFakeTimers({ now: 0 });
    const app = limitedApp();
    await app.request("/", from({ "x-forwarded-for": "203.0.113.7" }));
    vi.advanceTimersByTime(1);
    await app.request("/", from({ "x-forwarded-for": "203.0.113.8" }));
    // Its window ends at 1 001, just after the first sweep at 1 000.
    vi.advanceTimersByTime(1_998);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never holds the process open for its sweep", async () => {
    vi.useFakeTimers({ now: 0 });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const app = limitedApp();
    await app.request("/", from({ "x-forwarded-for": "203.0.113.7" }));
    const armed = timers.mock.results.map((r) => r.value as { hasRef(): boolean });
    expect(armed).toHaveLength(1);
    expect(armed[0]?.hasRef()).toBe(false);
  });
});

describe("personOf", () => {
  async function personAfter(set: { accountId?: string; adminIdentityId?: string }) {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => {
      if (set.accountId) c.set("accountId", set.accountId);
      if (set.adminIdentityId) c.set("adminIdentityId", set.adminIdentityId);
      return c.json({ person: personOf(c) });
    });
    return ((await (await app.request("/")).json()) as { person: string | null }).person;
  }

  it("is the account a session guard admitted", async () => {
    expect(await personAfter({ accountId: "acc-1" })).toBe("account:acc-1");
  });

  it("is the staff identity a staff guard admitted", async () => {
    expect(await personAfter({ adminIdentityId: "idn-1" })).toBe("staff:idn-1");
  });

  it("is nobody until a guard has admitted somebody", async () => {
    expect(await personAfter({})).toBeNull();
  });

  it("keeps an account and a staff identity with the same id apart", async () => {
    const same = "00000000-0000-0000-0000-000000000001";
    expect(await personAfter({ accountId: same })).not.toBe(
      await personAfter({ adminIdentityId: same }),
    );
  });
});

describe("the address given back only for what the person's limiter counted (ADR-026 §2)", () => {
  /**
   * The app's wiring in small: an address limiter that gives its count back
   * when the person's limiter counted the request, and two routes behind a
   * "guard" that names a person, one with the person's limiter and one without.
   */
  function wired() {
    const app = new Hono<AppEnv>();
    const counts: string[] = [];
    app.use(
      "*",
      rateLimit({
        limit: 2,
        windowMs: 60_000,
        keyOf: () => "address",
        refund: (c) => c.get("personCounted") === true,
      }),
    );
    const perPerson = rateLimit({
      limit: 100,
      windowMs: 60_000,
      keyOf: () => "person",
      skip: (path) => path === "/ends-session",
      onCount: (c) => {
        counts.push(c.req.path);
        c.set("personCounted", true);
      },
    });
    const admit: MiddlewareHandler<AppEnv> = async (c, next) => {
      c.set("accountId", "a");
      await next();
    };
    app.get("/limited", admit, perPerson, (c) => c.text("ok"));
    app.get("/ends-session", admit, perPerson, (c) => c.text("ok"));
    app.get("/unlimited-guard", admit, (c) => c.text("ok"));
    return { app, counts };
  }

  it("gives the address its count back for a request the person's limiter counted", async () => {
    const { app, counts } = wired();
    for (let n = 0; n < 5; n++) expect((await app.request("/limited")).status).toBe(200);
    expect(counts).toEqual(Array(5).fill("/limited"));
  });

  it("keeps a guard without the person's limiter on the address's count", async () => {
    const { app, counts } = wired();
    expect((await app.request("/unlimited-guard")).status).toBe(200);
    expect((await app.request("/unlimited-guard")).status).toBe(200);
    expect((await app.request("/unlimited-guard")).status).toBe(429);
    expect(counts).toEqual([]);
  });

  it("keeps a route the person's limiter skips on the address's count, and calls onCount for none of it", async () => {
    const { app, counts } = wired();
    expect((await app.request("/ends-session")).status).toBe(200);
    expect((await app.request("/ends-session")).status).toBe(200);
    expect((await app.request("/ends-session")).status).toBe(429);
    expect(counts).toEqual([]);
  });
});
