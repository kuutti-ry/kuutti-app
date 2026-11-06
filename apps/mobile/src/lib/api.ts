import { type ApiPaths, HealthResponse } from "@kuutti/schema";
import createClient, { type Middleware } from "openapi-fetch";
import { apiBaseUrl } from "./api-url";
import {
  accessTokenIsStale,
  currentSession,
  isCurrentSession,
  refreshSession,
  sessionGeneration,
} from "./session";

export { apiBaseUrl } from "./api-url";

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

/** Routes that never carry a session: the login itself and the probe. */
const ANONYMOUS = new Set(["/health", "/auth/exchange", "/auth/refresh"]);

const retryable = new WeakMap<Request, { copy: Request; generation: number }>();

/**
 * The session on every request (#35): the access token goes in the header,
 * refreshed ahead of its expiry. A 401 on a request that carried a token
 * means the token is stale (clock skew, or a rotation on another request) or
 * the session is over: one refresh decides which. A refresh that succeeds
 * replays the request from the copy taken before it was sent; one the API
 * refuses clears the store, and the app is back at the sign-in screen.
 */
export const sessionMiddleware: Middleware = {
  async onRequest({ request, schemaPath }) {
    if (ANONYMOUS.has(schemaPath)) return undefined;
    const generation = sessionGeneration();
    let session = currentSession();
    if (session && accessTokenIsStale(session)) session = await refreshSession();
    if (!session || !isCurrentSession(generation)) return undefined;
    retryable.set(request, { copy: request.clone(), generation });
    request.headers.set("authorization", `Bearer ${session.accessToken}`);
    return request;
  },
  async onResponse({ request, response }) {
    if (response.status !== 401) return undefined;
    const retry = retryable.get(request);
    if (!retry) return undefined;
    retryable.delete(request);
    if (!isCurrentSession(retry.generation)) return undefined;
    const session = await refreshSession();
    if (!session || !isCurrentSession(retry.generation)) return undefined;
    retry.copy.headers.set("authorization", `Bearer ${session.accessToken}`);
    return globalThis.fetch(retry.copy);
  },
};

/**
 * Typed client over the generated OpenAPI paths (ADR-003). Types come from
 * packages/schema/src/api.generated.ts; the zod contracts guard the runtime.
 */
export const api = createClient<ApiPaths>({
  baseUrl: apiBaseUrl(),
  // Resolve fetch at call time: React Native may install it after this module loads, and tests mock it.
  fetch: (request) => globalThis.fetch(request),
});
api.use(sessionMiddleware);

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const { data, error, response } = await api.GET("/health", { signal });
  if (error !== undefined || data === undefined) {
    throw new ApiError(`API answered ${response.status}`, response.status);
  }
  return HealthResponse.parse(data);
}
