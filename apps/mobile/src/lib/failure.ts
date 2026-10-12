import { ApiError } from "./api";

/**
 * Why something did not load, in the terms a person can act on: the API could
 * not be reached, the API failed, the API answered with something this build
 * cannot read (an app older than the API), or none of these. A screen says
 * which, and offers the way out that fits: try again, or update the app.
 */
export type FailureKind = "offline" | "server" | "outdated" | "other";

// What React Native's fetch (and the web's) throws when no answer came back.
const NETWORK = /network request failed|failed to fetch|load failed|network ?error/i;

export function failureKind(error: unknown): FailureKind {
  if (error instanceof ApiError) {
    return error.status !== undefined && error.status >= 500 ? "server" : "other";
  }
  // A contract that refuses the answer: the API says something this build
  // does not know yet. By name, so a second copy of zod is recognised too.
  if (error instanceof Error && error.name === "ZodError") return "outdated";
  if (error instanceof TypeError && NETWORK.test(error.message)) return "offline";
  return "other";
}
