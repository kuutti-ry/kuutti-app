import { isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.ts";
import { envelope } from "./errors.ts";
import { tOf } from "./i18n.ts";

/**
 * Whose word the API takes for the client address (#52, audit F19). A hop a
 * client can write is never trusted: `traefik` reads the last X-Forwarded-For
 * entry, the one Traefik itself appends on the box; `cloudfront` reads the
 * viewer address CloudFront adds, and is only right once the box admits
 * CloudFront alone (cloudfront_only_ingress), because until then anyone
 * reaching the origin could send that header; `none` is the socket, for a
 * process nothing fronts (development, tests).
 */
export const TRUSTED_PROXIES = ["none", "traefik", "cloudfront"] as const;
export type TrustedProxy = (typeof TRUSTED_PROXIES)[number];

export type RateLimitOptions = {
  /**
   * Requests per window: a number, or a function asked on each request, so a
   * limit that is a `matching_config` row holds from the request after an
   * admin's edit (#348, #305).
   */
  limit: number | ((c: Context<AppEnv>) => number | Promise<number>);
  windowMs: number;
  /** Whose budget a request spends; null shares one bucket rather than bypassing the limit (fail closed). */
  keyOf: (c: Context<AppEnv>) => string | null;
  /** Asked once the request has been answered: true gives its count back (ADR-026 §2). */
  refund?: (c: Context<AppEnv>) => boolean;
  /** Called once for each request this limiter counts (not for a skipped one). */
  onCount?: (c: Context<AppEnv>) => void;
  /** The answer over the limit, Retry-After already set; `limited` when absent. */
  refuse?: (c: Context<AppEnv>, retryAfterSeconds: number) => Response | Promise<Response>;
  skip?: (path: string) => boolean;
  now?: () => number;
};

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window limiter, in process (TD-3: no Redis; one box). What differs
 * between instances is the key (ADR-026 §1): the client address before a guard
 * knows who is asking (ADR-008 §5), the person once a guard has admitted the
 * request. A request whose key cannot be determined shares one bucket rather
 * than bypassing the limit, which is the fail-closed choice. Velocity rules
 * for scraping (TD-6) are separate and slice-level; the exposure budget is
 * media/budget.ts. Nothing here logs, and no answer carries a key (ADR-026 §7).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? (() => Date.now());
  const refuse = options.refuse ?? limited;
  // One instance counts a request once, even where two guards run on it (the
  // media routes whose patterns overlap, ADR-026 §3).
  const counted = new WeakSet<Context<AppEnv>>();
  // Windows that are over are dropped once a window, whether or not more
  // requests come, so a key is held for two windows at most (ADR-026 §7). The
  // timer runs only while there is something to drop and never holds the
  // process open.
  let sweeping = false;
  const sweepLater = () => {
    sweeping = true;
    setTimeout(dropExpired, options.windowMs).unref();
  };
  const dropExpired = () => {
    const at = now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
    sweeping = false;
    if (buckets.size > 0) sweepLater();
  };

  return async (c, next) => {
    if (options.skip?.(c.req.path) || counted.has(c)) return next();
    counted.add(c);
    options.onCount?.(c);
    const at = now();
    const key = options.keyOf(c) ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + options.windowMs };
      buckets.set(key, bucket);
      if (!sweeping) sweepLater();
    }
    bucket.count += 1;
    const limit = typeof options.limit === "function" ? await options.limit(c) : options.limit;
    c.header("RateLimit-Limit", String(limit));
    c.header("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
      c.header("Retry-After", String(retryAfter));
      return refuse(c, retryAfter);
    }
    await next();
    // Given back to the window it was taken from: after a rollover that
    // bucket is no longer in the map, and the next window is untouched.
    if (options.refund?.(c)) bucket.count -= 1;
  };
}

/** The refusal in the envelope, in the request's language; the limiter has set Retry-After. */
export function limited(c: Context<AppEnv>, retryAfterSeconds: number): Response {
  return c.json(
    envelope(
      "rate_limited",
      tOf(c)("errors.rate_limited", { seconds: retryAfterSeconds }),
      // Typed as always set, but a limiter mounted before serverRequestId sees none.
      c.get("requestId") ?? "unknown",
    ),
    429,
  );
}

/**
 * The person a guard admitted (ADR-026 §1): the account on the app's routes,
 * the staff identity on the panel's; null until a guard has.
 */
export function personOf(c: Context<AppEnv>): string | null {
  const accountId = c.get("accountId");
  if (accountId) return `account:${accountId}`;
  const staffId = c.get("adminIdentityId");
  return staffId ? `staff:${staffId}` : null;
}

/**
 * The client's address as the trusted proxy reports it, as ADR-026 §1 counts
 * it: an IPv6 address by its first `ipv6Prefix` bits, a /64 unless a limiter
 * asks for a wider prefix (the sign-in doors count a /56, §4).
 */
export function addressOf(
  trusted: TrustedProxy,
  options: { ipv6Prefix?: number } = {},
): (c: Context<AppEnv>) => string | null {
  const ipv6Prefix = options.ipv6Prefix ?? 64;
  return (c) => {
    const address = clientAddress(c, trusted);
    return address === null ? null : addressKey(address, ipv6Prefix);
  };
}

/**
 * An IPv4 address counts as itself, an IPv4-mapped IPv6 one as the IPv4 it maps
 * (a dual-stack socket reports an IPv4 client so), any other IPv6 address by
 * the prefix of `prefix` bits it lies in, since one host may take any address
 * of its /64 at will and one subscriber is usually given a /56 (ADR-026 §1).
 * Anything else is no address.
 */
function addressKey(address: string, prefix: number): string | null {
  if (isIPv4(address)) return address;
  // A zone names the box's own interface, never the client.
  const bare = address.replace(/%.*$/, "");
  if (!isIPv6(bare)) return null;
  // The URL parser writes the canonical form: lower case, no leading zeros,
  // the longest run of zero groups as "::", a mapped IPv4 tail as two groups.
  const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const [head = "", tail = ""] = canonical.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    return groups
      .slice(6)
      .flatMap((g) => {
        const n = Number.parseInt(g, 16);
        return [n >> 8, n & 255];
      })
      .join(".");
  }
  // The groups the prefix reaches, the last one cut to the bits it keeps.
  const kept = groups.slice(0, Math.ceil(prefix / 16)).map((g, i) => {
    const bits = Math.min(16, prefix - 16 * i);
    return (Number.parseInt(g, 16) & ((0xffff << (16 - bits)) & 0xffff)).toString(16);
  });
  return `${kept.join(":")}::/${prefix}`;
}

/** The client's address by the trusted proxy's account, or null when it left none. */
function clientAddress(c: Context<AppEnv>, trusted: TrustedProxy): string | null {
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  switch (trusted) {
    case "cloudfront": {
      // CloudFront-Viewer-Address is "ip:port", the port after the last colon
      // (IPv6 included); any other shape is no address. Without the header
      // there is no guess: the origin request policy forwards it
      // (infra/modules/media), and its absence is a misconfiguration that
      // must show as everyone sharing one bucket, not hide behind a hop.
      const viewer = c.req.header("cloudfront-viewer-address");
      return viewer ? viewerAddress(viewer) : null;
    }
    case "traefik":
      return hops.at(-1) ?? null;
    case "none":
      try {
        return getConnInfo(c).remote.address ?? null;
      } catch {
        return null;
      }
  }
}

const VIEWER_ADDRESS = /^((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{2,45}):\d{1,5}$/;

/** The address out of CloudFront's "ip:port", or null for a shape CloudFront never sends. */
export function viewerAddress(header: string): string | null {
  return VIEWER_ADDRESS.exec(header)?.[1] ?? null;
}
