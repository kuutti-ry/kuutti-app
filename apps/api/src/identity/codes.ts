import { createHash, randomBytes } from "node:crypto";

/** How long the app has to exchange the code the deep link carried. */
export const ONE_TIME_CODE_TTL_MS = 60_000;
/**
 * How long the person has from /auth/start to the callback, and the callback
 * from its claim of the attempt to the code (ADR-026 §8).
 */
export const AUTH_REQUEST_TTL_MS = 10 * 60_000;
/**
 * The most rows auth_request holds (ADR-026 §6): a guard for the disk, not a
 * limit a person meets. Real use opens a couple of hundred attempts in a
 * launch hour; fifty thousand rows are some twelve megabytes with their
 * indexes. At the ceiling a start deletes the expired rows and then the oldest
 * attempts the bank has not answered yet (login.ts), so a flood shortens how
 * long an unanswered attempt lives instead of refusing everybody's start.
 * What it bounds is the table; who fills it is the doors' window per address.
 */
export const AUTH_REQUEST_CAP = 50_000;

/** 32 random bytes, base64url: the code goes to the app, only its hash is stored. */
export function newOneTimeCode(): { code: string; hash: string } {
  const code = randomBytes(32).toString("base64url");
  return { code, hash: hashOneTimeCode(code) };
}

export function hashOneTimeCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Deep link the browser is sent to after the bank; the app's scheme is `kuutti`. */
export function appReturnUrl(code: string): string {
  return `kuutti://auth?code=${encodeURIComponent(code)}`;
}

/**
 * Where a refused login sends the browser: back into the app with the error's
 * code, which the app has a text for, rather than a JSON envelope left in a
 * browser tab. The code is one of ours (never text from the request); the
 * cooldown's date rides along for the message.
 */
export function appErrorUrl(code: string, until?: string): string {
  const url = new URL("kuutti://auth");
  url.searchParams.set("error", code);
  if (until) url.searchParams.set("until", until);
  return url.toString();
}
