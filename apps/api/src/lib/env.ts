import type { Locale, TFunction } from "@kuutti/i18n";
import type { ModeratorRole } from "@kuutti/schema";
import type { RequestIdVariables } from "hono/request-id";

/**
 * Hono environment shared by every route and middleware: the request id, the
 * request's locale with a t() fixed to it (#13), and, after the session
 * middleware, the caller's account and session (#35, rule 6).
 */
export type AppEnv = {
  Variables: RequestIdVariables & {
    locale: Locale;
    t: TFunction;
    accountId?: string;
    /** The person's limiter counted this request (ADR-026 §2): only then does the address give its count back. */
    personCounted?: boolean;
    sessionId?: string;
    /** After the admin guard (#49): the member of staff, by identity, and their current role. */
    adminIdentityId?: string;
    adminRole?: ModeratorRole;
    adminSessionId?: string;
    adminExpiresAt?: string;
  };
};

/** The caller the session middleware established; a route reads it through this, never a header. */
export type Caller = { accountId: string; sessionId: string };
