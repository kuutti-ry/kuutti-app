import type { Queryable } from "@kuutti/db";
import { type DemoPersona, personaClaims } from "@kuutti/db/demo";
import { AuthExchangeResponse, ErrorResponse, HealthResponse, Photo } from "@kuutti/schema";

/**
 * A persona's way through the bank and back, as a browser and the app walk it
 * (#73, ADR-014 §12): /auth/start sends to the mock bank, the bank's page is
 * answered with the persona's name and claims, the bank sends back to
 * /auth/callback, and the one-time code of the deep link is exchanged for a
 * session. Nothing here knows how an identity is made: that is the API's.
 */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type BankContext = {
  /** The API as this process reaches it, e.g. http://localhost:3000. */
  api: string;
  fetch: Fetch;
  now: () => Date;
  /** How to wait for the rate limit; a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether the address is on this computer: the only place a persona's claims are sent to. */
export const onThisComputer = (url: URL): boolean => LOOPBACK.has(url.hostname);

/**
 * Whether the address is this computer's own: `localhost`, a loopback
 * address, or one of the addresses of its network interfaces, which the
 * caller reads. The object store is named by the computer's address on the
 * network when a phone has to load photos from it (env.example), and that is
 * this computer still. Another machine on the same network is not, and
 * neither is any other name: what a name resolves to is decided elsewhere,
 * and can change between the question and the deletion.
 */
export function ofThisComputer(url: URL, addresses: readonly string[]): boolean {
  if (onThisComputer(url)) return true;
  // An IPv6 address stands in brackets in a URL and without them on an interface.
  return addresses.includes(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * Why the object store of a configuration is not the stand-in on this
 * computer, or null when it is. Three things decide where the client sends a
 * deletion, and all three are asked. The endpoint's address. The addressing:
 * without path style the client puts the bucket before the host and dials
 * `<bucket>.localhost`, a name that is looked up, where the endpoint is a
 * name. And the bucket: one given as an ARN names an endpoint of its own,
 * and the client goes there whatever the endpoint says.
 */
export function whyNotTheLocalStore(
  store: { endpoint: string; bucket: string; pathStyle: boolean },
  addresses: readonly string[],
): string | null {
  const url = URL.canParse(store.endpoint) ? new URL(store.endpoint) : null;
  if (!url) return "S3_ENDPOINT is no address";
  if (!ofThisComputer(url, addresses)) {
    return `it is at ${url.host}, not on this computer (S3_ENDPOINT is localhost, a loopback address or one of this computer's own)`;
  }
  if (!store.pathStyle) {
    return "S3_FORCE_PATH_STYLE is not true, so the bucket's name would be part of the host's";
  }
  if (/^arn:/i.test(store.bucket)) return "S3_BUCKET is an ARN, which names an endpoint of its own";
  return null;
}

/** The longest the walk waits for the rate limit's window, which is a minute. */
const RETRY_AFTER_MAX_SECONDS = 65;

/**
 * One request, and once more after the wait the API asks for when it answers
 * 429: the histories are some seventy requests against a limit of 120 a
 * minute, and a second reset within the minute would otherwise stop half way.
 */
async function patient(context: BankContext, input: URL, init?: RequestInit): Promise<Response> {
  const first = await context.fetch(input, init);
  if (first.status !== 429) return first;
  const asked = Number(first.headers.get("retry-after"));
  const seconds = Number.isFinite(asked) && asked > 0 ? asked : RETRY_AFTER_MAX_SECONDS;
  const sleep = context.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  await sleep(Math.min(seconds, RETRY_AFTER_MAX_SECONDS) * 1000);
  return context.fetch(input, init);
}

export type Login =
  | { kind: "session"; outcome: "created" | "resumed"; accessToken: string }
  | { kind: "refused"; error: string; until: string | null };

export class DemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoError";
  }
}

function locationOf(response: Response, what: string): URL {
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new DemoError(`${what}: expected a redirect, got ${response.status}`);
  }
  return new URL(location);
}

type Locale = "fi" | "sv" | "en";

/** Where the API sends a login: the bank's page, which must be on this computer. */
async function bankOf(context: BankContext, locale: Locale): Promise<URL> {
  const start = await patient(
    context,
    new URL(`/auth/start?platform=ios&locale=${locale}`, context.api),
    { redirect: "manual" },
  );
  if (start.status === 503) {
    throw new DemoError(
      "the API has no bank identification: is the mock bank running, and are OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI and HETU_HMAC_KEY set for it?",
    );
  }
  const bank = locationOf(start, "/auth/start");
  // The claims are artificial, and still they go to the mock bank on this
  // computer and nowhere else: an API configured for a real broker would
  // send this walk to somebody who never asked for it.
  if (!onThisComputer(bank)) {
    throw new DemoError(
      `the API's bank is ${bank.host}, not the mock bank on this computer: nothing was sent`,
    );
  }
  return bank;
}

/**
 * Asks the API what it is, before anybody is erased for a history that
 * could then not be given: something answers, it answers as Kuutti's API
 * does, its database is there with its migrations, the bank it sends a
 * login to is on this computer, and its database is this command's.
 *
 * The last is asked with the login that was begun for the question before
 * it: the API wrote a row for it, and the row is looked for through the
 * command's own connection. Found, the two have one database, and the row
 * is taken away again. Not found, the API serves another: the personas
 * would be erased here and given their histories there.
 */
export async function lookAtApi(
  context: BankContext & { db: Queryable },
): Promise<{ commit: string; bank: string }> {
  // Not followed anywhere: whoever answers here answers for itself.
  const health = await context
    .fetch(new URL("/health", context.api), { redirect: "manual" })
    .catch(() => null);
  if (!health) {
    throw new DemoError(
      `nothing answers at ${context.api}: the histories need the local environment (pnpm env:up)`,
    );
  }
  const answer = HealthResponse.safeParse(await health.json().catch(() => null));
  if (!answer.success) {
    throw new DemoError(`what answers at ${context.api} is not Kuutti's API`);
  }
  if (health.status !== 200 || answer.data.status !== "ok") {
    throw new DemoError(
      `the API at ${context.api} is not ready: database ${answer.data.db}, migrations ${answer.data.migrations}`,
    );
  }
  const bank = await bankOf(context, "fi");
  const state = bank.searchParams.get("state");
  if (!state) {
    throw new DemoError(
      `the API at ${context.api} began a login that names no state: whose database it serves cannot be told`,
    );
  }
  const begun = await context.db.query("DELETE FROM auth_request WHERE state = $1", [state]);
  if (begun.rowCount !== 1) {
    throw new DemoError(
      `the API at ${context.api} serves another database than this command's: the login it just began is not in the database of DATABASE_URL`,
    );
  }
  return { commit: answer.data.commit, bank: bank.origin };
}

export async function loginAs(
  persona: DemoPersona,
  context: BankContext,
  locale: Locale = "fi",
): Promise<Login> {
  const { api } = context;
  const bank = await bankOf(context, locale);

  const posted = await context.fetch(bank, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: persona.key,
      claims: JSON.stringify(personaClaims(persona, context.now())),
    }).toString(),
  });
  const back = locationOf(posted, `the bank, as ${persona.key}`);
  if (back.pathname !== "/auth/callback") {
    throw new DemoError(`the bank sent back to ${back.pathname}, not to /auth/callback`);
  }

  // The redirect URI is the API's own and may name a host this process does
  // not reach it by: the query is what matters.
  const callback = await patient(context, new URL(`/auth/callback${back.search}`, api), {
    redirect: "manual",
  });
  const link = locationOf(callback, "/auth/callback");
  const error = link.searchParams.get("error");
  if (error) return { kind: "refused", error, until: link.searchParams.get("until") };
  const code = link.searchParams.get("code");
  if (!code) throw new DemoError(`/auth/callback: no code and no error in ${link.protocol}`);

  const exchanged = await patient(context, new URL("/auth/exchange", api), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!exchanged.ok) throw new DemoError(`/auth/exchange: ${exchanged.status}`);
  const session = AuthExchangeResponse.parse(await exchanged.json());
  return { kind: "session", outcome: session.outcome, accessToken: session.accessToken };
}

/** One call of the API as the persona. Throws with the envelope's code, never with a body. */
export async function call(
  context: BankContext,
  accessToken: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await patient(context, new URL(path, context.api), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ErrorResponse.safeParse(answer);
    const code = envelope.success ? envelope.data.error.code : "unreadable";
    throw new DemoError(`${method} ${path}: ${response.status} ${code}`);
  }
  return answer;
}

/** One upload as the persona, as the app sends it (#142): multipart, the field the route reads. */
export async function upload(
  context: BankContext,
  accessToken: string,
  bytes: Uint8Array,
): Promise<Photo> {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "photo.jpg");
  const response = await patient(context, new URL("/photos", context.api), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ErrorResponse.safeParse(answer);
    const code = envelope.success ? envelope.data.error.code : "unreadable";
    throw new DemoError(`POST /photos: ${response.status} ${code}`);
  }
  return Photo.parse(answer);
}
