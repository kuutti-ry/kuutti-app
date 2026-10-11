import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
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
  limit: number;
  windowMs: number;
  trustedProxy: TrustedProxy;
  skip?: (path: string) => boolean;
  now?: () => number;
};

type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window limiter, in process (TD-3: no Redis; one box), keyed by the
 * client address as the trusted proxy reports it. A request whose address
 * cannot be determined shares one bucket rather than bypassing the limit,
 * which is the fail-closed choice. Velocity rules for scraping (TD-6) are
 * separate and slice-level; the exposure budget is media/budget.ts.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;

  return async (c, next) => {
    if (options.skip?.(c.req.path)) return next();
    const at = now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= at) buckets.delete(key);
    }
    const key = clientAddress(c, options.trustedProxy) ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    c.header("RateLimit-Limit", String(options.limit));
    c.header("RateLimit-Remaining", String(Math.max(0, options.limit - bucket.count)));
    if (bucket.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
      c.header("Retry-After", String(retryAfter));
      const requestId: unknown = c.get("requestId");
      return c.json(
        envelope(
          "rate_limited",
          tOf(c)("errors.rate_limited", { seconds: retryAfter }),
          typeof requestId === "string" ? requestId : "unknown",
        ),
        429,
      );
    }
    return next();
  };
}

/** The client's address by the trusted proxy's account, or null when it left none. */
export function clientAddress(c: Context, trusted: TrustedProxy): string | null {
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
