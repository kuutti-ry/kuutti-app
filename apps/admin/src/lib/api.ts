import { type ApiPaths, ErrorResponse } from "@kuutti/schema";
import createClient, { type Middleware } from "openapi-fetch";

/**
 * Set at build time for a deployed panel. Only a development server falls back
 * to the local API: a production build without the variable asks nobody, so
 * this constant can never send a moderator's browser to localhost.
 */
export function apiUrl(env: { VITE_API_URL?: string; PROD: boolean }): string | undefined {
  return env.VITE_API_URL ?? (env.PROD ? undefined : "http://localhost:3000");
}

export const API_URL = apiUrl(import.meta.env);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The envelope's stable code, when the API answered with one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** What the middleware reads the admin token from; the session module owns the value. */
let tokenSource: () => string | null = () => null;
export function setTokenSource(source: () => string | null): void {
  tokenSource = source;
}

/** What a 401 to a request that carried the token calls; the session module ends the session there. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

const bearer: Middleware = {
  async onRequest({ request }) {
    const token = tokenSource();
    if (token) request.headers.set("authorization", `Bearer ${token}`);
    return request;
  },
  // A session the API no longer honours (revoked, expired) ends wherever it
  // is found out, so every screen goes back to the sign-in instead of saying
  // that its own request failed (#250).
  async onResponse({ request, response }) {
    if (response.status === 401 && request.headers.has("authorization")) onUnauthorized();
    return response;
  },
};

/**
 * Typed client over the generated OpenAPI paths (ADR-003), same contracts as
 * the app. Without an API address (a production build missing VITE_API_URL)
 * the client has no base: the session provider then never sends a request,
 * and the panel says it cannot sign in, rather than talking to anything else.
 */
export const api = createClient<ApiPaths>({
  baseUrl: API_URL ?? "",
  // Resolve fetch at call time: tests stub it after this module loads.
  fetch: (request) => globalThis.fetch(request),
});
api.use(bearer);

/** The one error shape every route answers with, as an exception the screens can read. */
export function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}
