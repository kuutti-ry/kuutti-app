import { z } from "zod";

/**
 * The bank login (#33, docs/vendors/telia.md). The API is the OIDC client; the
 * app opens the system browser at /auth/start with the SHA-256 of a verifier it
 * keeps for the attempt, and receives a one-time code by deep link, which it
 * exchanges here with that verifier, so that only the app that started the
 * attempt can exchange its code (ADR-027). Nothing about the broker, the tokens
 * or the person's claims ever crosses this boundary (rules/mobile.md Auth).
 */

/** Where the browser is sent back to after the bank: the app's own scheme, or nothing yet for web. */
export const AuthPlatform = z.enum(["ios", "android"]).meta({ id: "AuthPlatform" });
export type AuthPlatform = z.infer<typeof AuthPlatform>;

/** The standing staff set on the identity row (TD-7), never on an account. */
export const IdentityStanding = z
  .enum(["ok", "suspended", "banned"])
  .meta({ id: "IdentityStanding" });
export type IdentityStanding = z.infer<typeof IdentityStanding>;

/** What a device calls itself at login, kept this long: the person's own list of devices, and their export. */
export const USER_AGENT_MAX = 200;

/** 256 bits as lowercase hex: the app's attempt verifier, and its SHA-256 (ADR-027). */
const HEX_256 = /^[0-9a-f]{64}$/;

export const AuthStartQuery = z
  .object({
    platform: AuthPlatform.meta({
      description: "The app that will receive the one-time code by deep link.",
    }),
    locale: z.enum(["fi", "sv", "en"]).optional().meta({
      description: "The language of the bank chooser (ui_locales); defaults to the request's.",
    }),
    code_challenge: z.string().regex(HEX_256).meta({
      description:
        "SHA-256 of this attempt's verifier, lowercase hex (ADR-027): only the app holding the verifier can exchange the code.",
    }),
  })
  .meta({ id: "AuthStartQuery" });
export type AuthStartQuery = z.infer<typeof AuthStartQuery>;

export const AuthCallbackQuery = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().max(64).optional(),
    error_description: z.string().max(256).optional(),
  })
  .meta({ id: "AuthCallbackQuery" });
export type AuthCallbackQuery = z.infer<typeof AuthCallbackQuery>;

/** 32 random bytes as base64url: 43 characters, single use, 60 seconds. */
const ONE_TIME_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const AuthExchangeRequest = z
  .object({
    code: z.string().regex(ONE_TIME_CODE_PATTERN).meta({
      description: "The one-time code the deep link carried.",
    }),
    verifier: z.string().regex(HEX_256).meta({
      description: "The verifier whose SHA-256 /auth/start carried (ADR-027).",
    }),
  })
  .strict()
  .meta({ id: "AuthExchangeRequest" });
export type AuthExchangeRequest = z.infer<typeof AuthExchangeRequest>;

/** 32 random bytes as base64url, like the one-time code: the shape of both session tokens. */
const SESSION_TOKEN_PATTERN = ONE_TIME_CODE_PATTERN;
/** An access or refresh token's shape; the chat's socket takes the access token in its first frame (#349). */
export const SessionToken = z.string().regex(SESSION_TOKEN_PATTERN);

/**
 * What a login hands the device (#35): a short-lived access token for the
 * Authorization header, a long-lived refresh token the app keeps in secure
 * storage, and the session's id, which names this device to the person.
 */
export const SessionTokens = z
  .object({
    sessionId: z
      .uuid()
      .meta({ description: "This device's session; the app keeps it with the tokens." }),
    accessToken: SessionToken.meta({ description: "Bearer token; valid until accessExpiresAt." }),
    accessExpiresAt: z.iso.datetime(),
    refreshToken: SessionToken.meta({
      description: "Single use: /auth/refresh answers with a new pair and retires this one.",
    }),
    refreshExpiresAt: z.iso.datetime().meta({
      description: "After this the device logs in through the bank again.",
    }),
  })
  .meta({ id: "SessionTokens" });
export type SessionTokens = z.infer<typeof SessionTokens>;

export const AuthExchangeResponse = SessionTokens.extend({
  outcome: z.enum(["created", "resumed", "unpaused"]).meta({
    description:
      "created: a fresh account (first login or after a cooldown); resumed: the live account; unpaused: the live account, back from a break (#170).",
  }),
}).meta({ id: "AuthExchangeResponse" });
export type AuthExchangeResponse = z.infer<typeof AuthExchangeResponse>;

export const AuthRefreshRequest = z
  .object({ refreshToken: SessionToken })
  .strict()
  .meta({ id: "AuthRefreshRequest" });
export type AuthRefreshRequest = z.infer<typeof AuthRefreshRequest>;

/** What the app may know about its own session. Never another account's. */
export const SessionResponse = z
  .object({
    sessionId: z.uuid(),
    accountId: z.uuid(),
    platform: AuthPlatform,
    createdAt: z.iso.datetime(),
    refreshExpiresAt: z.iso.datetime(),
  })
  .meta({ id: "SessionResponse" });
export type SessionResponse = z.infer<typeof SessionResponse>;
