import { cors } from "hono/cors";

/**
 * Browser origins are refused by default (rule 8). The allowlist names exactly
 * the admin SPA, the public site, and a preview's own origin; development
 * allows the Metro web target. Values come from the validated config.
 */
export function corsAllowlist(allowed: ReadonlySet<string>) {
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    // The admin panel sends its bearer token and JSON bodies from its own
    // origin (#49): both headers must pass the preflight, or nothing does.
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
}
