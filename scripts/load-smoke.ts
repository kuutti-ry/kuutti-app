/**
 * load:smoke: an environment driven the way five thousand people would drive it in a bad hour
 * (#200), by hand once per milestone. The procedure, the sessions file, what to watch on the
 * server meanwhile and the table its numbers go to are docs/runbooks/capacity.md.
 *
 *   pnpm load:smoke -- --target http://localhost:3000                      the public routes alone
 *   pnpm load:smoke -- --target <api> --sessions <file> --rates 0.5,1,2 [--stage 60]
 *                      [--concurrency 16] [--stop-p95 1000] [--confirm-staging]
 *   node scripts/load-smoke.ts --self-test     the command line, the refusals and the sums, and
 *                                              runs against a stand-in on this computer
 *
 * A visit is an assumption about a bad hour (capacity.md): a person opening the app (the onboarding
 * status, then the home's gate) and looking at their profile (the profile and the photo list); on
 * one visit in N they also open the photos screen, which reads the list again and asks a signed
 * URL for each thumbnail (ADR-008), N spread so an account's URLs last the run. The public part
 * goes out at the visit's start: every second visit asks for the waitlist counter (cacheable for an
 * hour), and every fourth sends the sign-in's last step, the exchange, with a code nobody holds:
 * its shape without the bank. Without sessions a visit is that public part alone. A stage offers
 * visits at a fixed rate, an open model: a visit that finds every request slot busy is counted as
 * dropped, never queued, so slow answers show instead of slowing the offer. A timed-out request
 * counts in the percentiles at the timeout. The run stops after the first stage that bends (its p95
 * over --stop-p95, more than 1 % errors or dropped visits), or that held back more than 1 % of its
 * visits' parts for a resting budget: that stage sent less than its rate, and is no measurement.
 *
 * Sessions come from the product's own sign-in, never from a door of the load's: a file of refresh
 * tokens, one a line, under a `# target <origin>` line naming the API they belong to, made by
 * signing test persons in by hand (capacity.md). Each is rotated once at the start and written back
 * at once, so the file serves the next milestone too; one the API refuses is commented out, not
 * deleted. An access token lives fifteen minutes, so a run lasts ten at most.
 *
 * What keeps it safe:
 * - The target is this computer or staging. Production by name, the previews (which share
 *   staging's box), any other host, APP_ENV=production and an APP_ENV that disagrees with the
 *   target are refused. Before any load the server is asked: /health must be ours and ready, and
 *   /openapi.json must be served, which production never does (app.ts).
 * - Staging needs --confirm-staging: it is the demo, and its address limit counts the CloudFront
 *   edge the team's phones share (ADR-008 History).
 * - The sessions file is refused inside any git work tree, readable by others, with a token twice,
 *   or naming another API than the target: an unknown token and a revoked one get the same 401.
 * - Hard caps no flag passes: 20 visits a second, 8 stages, 10 minutes, 64 requests in flight,
 *   50 sessions, 60 thumbnail URLs per account (a tenth of the day's budget), 10 s a request.
 * - ADR-026's budgets: never a sign-in start (the doors). The plan takes at most 40 % of the
 *   address's window and of each person's (from the RateLimit-Limit the API reports); as it goes,
 *   an answer with under half its window left rests that budget for a window. The first 429 of any
 *   kind or 401 of a session stops the run. At the third server error or unanswered request the
 *   run stops sending; the requests already in flight, up to --concurrency, still finish, so the
 *   5xx alarm (five in five minutes) may mail at the bend.
 * - Nothing personal out: routes by template, error codes from the envelope, sessions and
 *   accounts by count; never a token, an id, a URL the API handed out, or a body.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// By path: the root is no workspace of @kuutti/schema. The contracts are the API's (ADR-003).
import { ErrorResponse } from "../packages/schema/src/errors.ts";
import { HealthResponse } from "../packages/schema/src/health.ts";
import {
  AuthExchangeRequest,
  AuthRefreshRequest,
  SessionResponse,
  SessionTokens,
} from "../packages/schema/src/identity.ts";
import { PhotoList } from "../packages/schema/src/media.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STAGING = "https://api.staging.kuutti.app";
const PRODUCTION = "api.kuutti.app";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Hard caps: a flag may ask for less, never for more. */
const CAP = {
  rate: 20, // visits a second, some 150 requests a second
  stages: 8,
  // An access token lives fifteen minutes and is refreshed once, at the start.
  runSeconds: 600,
  sessions: 50,
} as const;
const NUMBERS = {
  "--stage": { min: 10, max: 300, fallback: 60 },
  "--concurrency": { min: 1, max: 64, fallback: 16 },
  "--stop-p95": { min: 50, max: 10_000, fallback: 1000 },
} as const;
const DEFAULT_RATES = [0.5];
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The share of a window the API counts, the address's or a person's, that the plan may take. Under
 * REST_SHARE, so a stage planned to the full ceiling does not trip its own rest: the gap is for the
 * sessions' opening requests and a persona's own phone.
 */
const PLAN_SHARE = 0.4;
/** An answer with less than this share of its window left rests that budget for a window. */
const REST_SHARE = 0.5;
/** A window of the API's limiters (ADR-026 §5): a budget seen under its share rests this long. */
const WINDOW_MS = 60_000;
/** Thumbnail URLs per account in one run: a tenth of the day's 600 (photo_fetches_per_day, ADR-008 §1). */
const URLS_PER_ACCOUNT = 60;
/**
 * The 5xx alarm fires at five in five minutes (infra/modules/observability); the run stops sending
 * at three, and what is in flight then still finishes.
 */
const SERVER_ERRORS_MAX = 3;
/** The share of errors, dropped visits or held-back parts past which a stage is not one that held. */
const BEND_SHARE = 0.01;
const WAITLIST_EVERY = 2;
// A launch evening's share of first sign-ins: an assumption, and the visit's cheapest request.
const EXCHANGE_EVERY = 4;
/** The signed-in requests of every visit: onboarding, gate, profile, photo list. */
const SIGNED_IN_PER_VISIT = 4;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const TARGET_LINE = /^# target (\S+)$/;

type Kind = "local" | "staging";
type Options = {
  target: URL;
  kind: Kind;
  sessions?: string;
  rates: number[];
  stageSeconds: number;
  concurrency: number;
  stopP95: number;
};
type Io = { log: (line: string) => void };

type Route = {
  name: string;
  method: "GET" | "POST";
  signedIn: boolean;
  expect: number;
  code?: string;
};
const ROUTES = {
  exchange: {
    name: "POST /auth/exchange",
    method: "POST",
    signedIn: false,
    expect: 401,
    code: "auth_code_used",
  },
  waitlist: { name: "GET /waitlist", method: "GET", signedIn: false, expect: 200 },
  onboarding: { name: "GET /onboarding", method: "GET", signedIn: true, expect: 200 },
  gate: { name: "GET /gate", method: "GET", signedIn: true, expect: 200 },
  profile: { name: "GET /profile", method: "GET", signedIn: true, expect: 200 },
  photos: { name: "GET /photos", method: "GET", signedIn: true, expect: 200 },
  thumb: { name: "GET /photos/{id}/thumb", method: "GET", signedIn: true, expect: 200 },
} satisfies Record<string, Route>;

type Outcome = "ok" | "unexpected" | "server" | "timeout" | "limited" | "signed-out";
type Sample = { route: string; ms: number | null; outcome: Outcome; label: string };
type Account = { access: string[]; visits: number; urlsLeft: number; restUntil: number };
/** Why the run stopped sending: a guard (2, no measurement) or the server's errors (0, a bend). */
type Stop = { why: string; status: 2 } | { status: 0 };
type Run = {
  base: URL;
  accounts: Account[];
  thumbEvery: number;
  slots: ReturnType<typeof slots>;
  anonymousRestUntil: number;
  samples: Sample[];
  parts: number;
  held: number;
  serverErrors: number;
  stop: Stop | null;
  visits: number;
};
type Summary = {
  requests: number;
  errors: number;
  timeouts: number;
  urls: number;
  rps: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  byRoute: string[];
  problems: string[];
};
type StageResult = Summary & {
  rate: number;
  planned: number;
  started: number;
  dropped: number;
  /** A visit's parts: each public request, and its signed-in run of requests. */
  parts: number;
  held: number;
};

if (process.argv.includes("--self-test")) await selfTest();
let options: Options;
try {
  options = parseArgs(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`load-smoke: ${(error as Error).message}`);
  process.exit(1);
}
process.exit(await execute(options, { log: (line) => console.log(line) }));

/**
 * The command line, every refusal it can make without asking anybody (the house rule of #235: a
 * flag without a usable value, given twice or unknown is refused, never read as absent). Nothing
 * a refusal prints is a value it was handed but the host and the numbers.
 */
function parseArgs(argv: string[], env: Record<string, string | undefined>): Options {
  const args = argv.filter((arg) => arg !== "--");
  const values = new Map<string, string>();
  let confirmed = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    if (flag === "--self-test") throw new Error("--self-test takes no value");
    if (flag === "--confirm-staging") {
      if (inline !== undefined) throw new Error("--confirm-staging takes no value");
      if (confirmed) throw new Error("--confirm-staging is given twice");
      confirmed = true;
      continue;
    }
    if (flag !== "--target" && flag !== "--sessions" && flag !== "--rates" && !(flag in NUMBERS)) {
      if (!flag.startsWith("-")) {
        throw new Error(
          "unexpected argument: every option is named (--target, --sessions, --rates, --stage, --concurrency, --stop-p95, --confirm-staging)",
        );
      }
      throw new Error(`unknown option ${flag}`);
    }
    let value = inline;
    if (value === undefined) {
      at += 1;
      value = args[at];
    }
    if (value === undefined || value.trim() === "" || value.startsWith("-")) {
      throw new Error(`${flag} takes a value`);
    }
    if (values.has(flag)) throw new Error(`${flag} is given twice`);
    values.set(flag, value.trim());
  }

  if (env.APP_ENV === "production") {
    throw new Error("APP_ENV is production: the load smoke never runs there");
  }
  const raw = values.get("--target");
  if (raw === undefined) {
    throw new Error(
      `--target is required: http://localhost:3000, or ${STAGING} with --confirm-staging`,
    );
  }
  const { target, kind } = targetOf(raw);
  if (env.APP_ENV) {
    const agrees =
      kind === "staging"
        ? env.APP_ENV === "staging"
        : env.APP_ENV === "development" || env.APP_ENV === "test";
    if (!agrees) {
      throw new Error(
        `APP_ENV says ${env.APP_ENV}, and the target is ${kind === "staging" ? "staging" : "this computer"}`,
      );
    }
  }
  if (kind === "staging" && !confirmed) {
    throw new Error(
      "staging is the demo, and its address limit is the team's phones' too: add --confirm-staging once the run is announced (docs/runbooks/capacity.md)",
    );
  }
  if (kind === "local" && confirmed) {
    throw new Error("--confirm-staging is for staging; the target is this computer");
  }

  const parts = values.get("--rates")?.split(",") ?? DEFAULT_RATES.map(String);
  if (parts.length > CAP.stages) {
    throw new Error(`--rates names ${parts.length} stages; at most ${CAP.stages}`);
  }
  const rates = parts.map((part) => {
    const rate = Number(part.trim());
    if (part.trim() === "" || !Number.isFinite(rate) || rate <= 0 || rate > CAP.rate) {
      throw new Error(
        `--rates wants visits a second, each above 0 and at most ${CAP.rate}, not ${part.trim() || "nothing"}`,
      );
    }
    return rate;
  });
  const whole = (flag: keyof typeof NUMBERS): number => {
    const { min, max, fallback } = NUMBERS[flag];
    const given = values.get(flag);
    if (given === undefined) return fallback;
    const number = Number(given);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${flag} wants a whole number from ${min} to ${max}, not ${given}`);
    }
    return number;
  };
  const stageSeconds = whole("--stage");
  if (rates.length * stageSeconds > CAP.runSeconds) {
    throw new Error(
      `the run would last ${rates.length * stageSeconds} s; at most ${CAP.runSeconds} (an access token lives fifteen minutes and is refreshed once, at the start)`,
    );
  }
  return {
    target,
    kind,
    sessions: values.get("--sessions"),
    rates,
    stageSeconds,
    concurrency: whole("--concurrency"),
    stopP95: whole("--stop-p95"),
  };
}

/** This computer or staging, by the address alone; production and every other host by name. */
function targetOf(raw: string): { target: URL; kind: Kind } {
  if (!URL.canParse(raw)) throw new Error("--target is no address");
  const target = new URL(raw);
  if (target.username || target.password) {
    throw new Error("--target carries credentials; the load smoke takes none in an address");
  }
  if (target.pathname !== "/" || target.search || target.hash) {
    throw new Error("--target is the API's origin alone, with no path");
  }
  if (target.hostname === PRODUCTION) {
    throw new Error(`${PRODUCTION} is production: the load smoke never runs there`);
  }
  if (LOOPBACK.has(target.hostname) && /^https?:$/.test(target.protocol)) {
    return { target, kind: "local" };
  }
  if (target.origin === STAGING) return { target, kind: "staging" };
  throw new Error(
    `${target.host} is neither this computer nor staging (${STAGING}): the load smoke drives nothing else`,
  );
}

/** The p-th percentile by nearest rank: the smallest value with at least p % of them at or below it. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Less a hair before rounding up: 0.999 * 1000 is 999.0000000000001 in binary, which would
  // take the 1000th value for the 999th.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length - 1e-9));
  return sorted[rank - 1] ?? null;
}

/**
 * What the budgets allow (ADR-026 §1, §2, §5), the plan taking PLAN_SHARE of each window: the
 * address's counts the public requests and holds a signed-in one until it is answered, so the
 * requests in flight count against it too; each account's counts its signed-in requests, the
 * visits going round its accounts. The photos screen comes on one visit in thumbEvery, spread so
 * an account's URLs last the whole run: ADR-008's budget, not the app, sets how often.
 */
function planOf(
  options: Pick<Options, "rates" | "stageSeconds" | "concurrency">,
  budgets: { addressLimit: number; personLimit: number; accounts: number; photosMax: number },
): { thumbEvery: number; ceiling: number; neededLimit: number } {
  const { accounts, photosMax } = budgets;
  const visits = options.rates.reduce((sum, rate) => sum + rate * options.stageSeconds, 0);
  const thumbEvery =
    accounts === 0 || photosMax === 0
      ? 1
      : Math.max(1, Math.ceil(((visits / accounts) * photosMax) / URLS_PER_ACCOUNT));
  const publicPerVisit = 1 / WAITLIST_EVERY + 1 / EXCHANGE_EVERY;
  // The photos screen reads the list again, then a URL a photo.
  const personPerVisit = SIGNED_IN_PER_VISIT + (1 + photosMax) / thumbEvery;
  const held = accounts > 0 ? options.concurrency : 0;
  const byAddress = (PLAN_SHARE * budgets.addressLimit - held) / (publicPerVisit * 60);
  const byPerson =
    accounts > 0
      ? (accounts * PLAN_SHARE * budgets.personLimit) / (personPerVisit * 60)
      : Number.POSITIVE_INFINITY;
  const top = Math.max(...options.rates);
  const neededLimit = Math.ceil(
    Math.max(
      (top * publicPerVisit * 60 + held) / PLAN_SHARE,
      accounts > 0 ? ((top / accounts) * personPerVisit * 60) / PLAN_SHARE : 0,
    ),
  );
  return { thumbEvery, ceiling: Math.max(0, Math.min(byAddress, byPerson)), neededLimit };
}

/** What an answer means for the run; the expected refusal of nobody's code is a success. */
function outcomeOf(route: Route, status: number, code: string): Outcome {
  if (status === 429) return "limited";
  if (status >= 500) return "server";
  if (status === route.expect && (route.code === undefined || code === route.code)) return "ok";
  if (status === 401 && route.signedIn) return "signed-out";
  return "unexpected";
}

/** Why a finished stage has bent, or null: where it bends is the ceiling's other side. */
function bendOf(result: StageResult, stopP95: number): string | null {
  if (result.p95 !== null && result.p95 > stopP95) {
    return `p95 ${Math.round(result.p95)} ms is over ${stopP95}`;
  }
  if (result.errors > BEND_SHARE * result.requests) {
    return `${result.errors} of ${result.requests} answers were errors`;
  }
  if (result.dropped > BEND_SHARE * result.planned) {
    return `${result.dropped} of ${result.planned} visits were dropped: every request slot was busy`;
  }
  return null;
}

/**
 * Why a finished stage is no measurement at its rate, or null: a resting budget held back parts
 * of its visits, so it sent less than its rate, and neither held nor bent there.
 */
function shortOf(result: StageResult): string | null {
  return result.held > BEND_SHARE * result.parts
    ? `${result.held} of ${result.parts} parts of its visits were held back for a resting budget`
    : null;
}

/** The numbers of a stage's answers; a timed-out request counts at the timeout, a lower bound. */
function summarise(samples: readonly Sample[], seconds: number): Summary {
  const timed = (some: readonly Sample[]) =>
    some.flatMap((sample) => (sample.ms === null ? [] : [sample.ms]));
  const all = timed(samples);
  const routes = [...new Set(samples.map((sample) => sample.route))];
  const problems = new Map<string, number>();
  for (const sample of samples) {
    if (sample.outcome !== "ok") problems.set(sample.label, (problems.get(sample.label) ?? 0) + 1);
  }
  return {
    requests: samples.length,
    errors: samples.filter((sample) => sample.outcome !== "ok").length,
    timeouts: samples.filter((sample) => sample.outcome === "timeout").length,
    urls: samples.filter((sample) => sample.route === ROUTES.thumb.name).length,
    // Answered a second: a timeout was not.
    rps: samples.filter((s) => s.ms !== null && s.outcome !== "timeout").length / seconds,
    p50: percentile(all, 50),
    p95: percentile(all, 95),
    p99: percentile(all, 99),
    max: percentile(all, 100),
    byRoute: routes.map(
      (route) => `${route} ${ms(percentile(timed(samples.filter((s) => s.route === route)), 95))}`,
    ),
    problems: [...problems].map(([label, count]) => `${label} ×${count}`),
  };
}

/** The same API: one origin, or this computer by any of its names on one port. */
function sameApi(a: URL, b: URL): boolean {
  if (a.origin === b.origin) return true;
  return (
    LOOPBACK.has(a.hostname) &&
    LOOPBACK.has(b.hostname) &&
    a.protocol === b.protocol &&
    a.port === b.port
  );
}

/** The envelope's code, or "unreadable": only a code's shape is ever printed. */
function codeOf(json: unknown): string {
  const envelope = ErrorResponse.safeParse(json);
  return envelope.success && ERROR_CODE.test(envelope.data.error.code)
    ? envelope.data.error.code
    : "unreadable";
}

function budgetOf(headers: Headers): { limit: number; remaining: number } | null {
  const limit = Number(headers.get("ratelimit-limit"));
  const remaining = Number(headers.get("ratelimit-remaining"));
  return Number.isInteger(limit) && limit > 0 && Number.isInteger(remaining) && remaining >= 0
    ? { limit, remaining }
    : null;
}

/** A code and a verifier of the right shape that no attempt holds: the exchange's refusal path. */
function nobodysCode(): { code: string; verifier: string } {
  return { code: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("hex") };
}

/** Request slots: a request waits for one; a visit that finds none free is dropped. */
function slots(size: number) {
  let busy = 0;
  const waiting: Array<() => void> = [];
  return {
    free: () => size - busy,
    take: async (): Promise<void> => {
      if (busy < size) {
        busy += 1;
        return;
      }
      await new Promise<void>((resolveTake) => waiting.push(resolveTake));
    },
    give: (): void => {
      const next = waiting.shift();
      if (next) next();
      else busy -= 1;
    },
  };
}

type Answer = { status: number; headers: Headers; json: unknown; ms: number };

/** One request, never following a redirect: whoever answers here answers for itself. */
async function ask(
  base: URL,
  path: string,
  init: { method?: "GET" | "POST"; token?: string; body?: unknown } = {},
): Promise<Answer | "timeout" | "unreachable"> {
  const headers: Record<string, string> = { "user-agent": "kuutti-load-smoke" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const started = performance.now();
  try {
    const response = await fetch(new URL(path, base), {
      method: init.method ?? "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const ms = performance.now() - started;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: read as no envelope.
    }
    return { status: response.status, headers: response.headers, json, ms };
  } catch (error) {
    return (error as Error).name === "TimeoutError" ? "timeout" : "unreachable";
  }
}

/** One request of a visit, counted, with the guards of the header applied to what it answered. */
async function call(
  run: Run,
  route: Route,
  path: string,
  extra: { token?: string; account?: Account; body?: unknown } = {},
): Promise<unknown> {
  if (run.stop) return null;
  await run.slots.take();
  let answer: Answer | "timeout" | "unreachable";
  try {
    if (run.stop) return null;
    answer = await ask(run.base, path, {
      method: route.method,
      token: extra.token,
      body: extra.body,
    });
  } finally {
    run.slots.give();
  }
  if (typeof answer === "string") {
    run.samples.push(unanswered(route, answer));
    countServerError(run);
    return null;
  }
  const code = answer.status >= 400 ? codeOf(answer.json) : "";
  const outcome = outcomeOf(route, answer.status, code);
  const label = `${route.name} ${answer.status}${code ? ` ${code}` : ""}`;
  run.samples.push({ route: route.name, ms: answer.ms, outcome, label });
  if (outcome === "limited") {
    run.stop = {
      why: `${label}: a budget the run keeps under half is spent, by somebody else as well or by a wrong plan`,
      status: 2,
    };
  } else if (outcome === "signed-out") {
    run.stop = { why: `${label}: a session ended during the run`, status: 2 };
  } else if (outcome === "server") {
    countServerError(run);
  }
  // Under its share, a budget rests for a window: the person's on a signed-in route (its limiter
  // speaks last), the address's on a public one.
  const budget = budgetOf(answer.headers);
  if (budget && budget.remaining < budget.limit * REST_SHARE) {
    const rested = performance.now() + WINDOW_MS;
    if (route.signedIn && extra.account) extra.account.restUntil = rested;
    else if (!route.signedIn) run.anonymousRestUntil = rested;
  }
  return outcome === "ok" ? answer.json : null;
}

/** A request nobody answered: a timeout counts at the timeout, a lower bound of what it took. */
function unanswered(route: Route, failure: "timeout" | "unreachable"): Sample {
  const timedOut = failure === "timeout";
  return {
    route: route.name,
    ms: timedOut ? REQUEST_TIMEOUT_MS : null,
    outcome: timedOut ? "timeout" : "server",
    label: `${route.name} ${failure}`,
  };
}

/** The run stops sending at the third; what is already in flight still finishes, and counts. */
function countServerError(run: Run): void {
  run.serverErrors += 1;
  if (run.serverErrors >= SERVER_ERRORS_MAX && !run.stop) run.stop = { status: 0 };
}

/**
 * A person opening the app and looking at their profile (useOnboardingGate and HomeScreen, then
 * ProfileScreen); the photos screen on one visit in thumbEvery. The public part goes out at the
 * start, where the app asks the waitlist alongside the gate: one request's place in a visit.
 */
async function visit(run: Run, n: number): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const offer = (resting: boolean, job: () => Promise<unknown>) => {
    run.parts += 1;
    if (resting) run.held += 1;
    else jobs.push(job());
  };
  const publicly = (route: Route, path: string, body?: unknown) =>
    offer(performance.now() < run.anonymousRestUntil, () => call(run, route, path, { body }));
  if (n % EXCHANGE_EVERY === 0) publicly(ROUTES.exchange, "/auth/exchange", nobodysCode());
  if (n % WAITLIST_EVERY === 0) publicly(ROUTES.waitlist, "/waitlist");
  const account = run.accounts[n % run.accounts.length];
  if (account) offer(performance.now() < account.restUntil, () => signedIn(run, account));
  await Promise.all(jobs);
}

async function signedIn(run: Run, account: Account): Promise<void> {
  const token = account.access[account.visits % account.access.length];
  const thumbs = account.visits % run.thumbEvery === 0;
  account.visits += 1;
  const get = (route: Route, path: string) => call(run, route, path, { token, account });
  await get(ROUTES.onboarding, "/onboarding");
  await get(ROUTES.gate, "/gate");
  await Promise.all([get(ROUTES.profile, "/profile"), get(ROUTES.photos, "/photos")]);
  if (!thumbs) return;
  // The photos screen reads the list itself (usePhotos), then a URL for each thumbnail.
  const list = await get(ROUTES.photos, "/photos");
  if (list === null) return;
  const photos = PhotoList.safeParse(list);
  if (!photos.success) {
    run.samples.push({
      route: ROUTES.photos.name,
      ms: null,
      outcome: "unexpected",
      label: `${ROUTES.photos.name} 200 outside the contract`,
    });
    return;
  }
  const ids = photos.data.photos.map((photo) => photo.id).slice(0, account.urlsLeft);
  account.urlsLeft -= ids.length;
  await Promise.all(ids.map((id) => get(ROUTES.thumb, `/photos/${id}/thumb`)));
}

/** Sleeps until the moment, or until the run is stopped. */
async function until(run: Run, at: number): Promise<void> {
  for (let left = at - performance.now(); left > 0 && !run.stop; left = at - performance.now()) {
    await new Promise((done) => setTimeout(done, Math.min(left, 250)));
  }
}

async function stage(run: Run, rate: number, seconds: number): Promise<StageResult> {
  run.samples = [];
  run.parts = 0;
  run.held = 0;
  const visits: Promise<void>[] = [];
  const planned = Math.max(1, Math.round(rate * seconds));
  let dropped = 0;
  const start = performance.now();
  for (let i = 0; i < planned && !run.stop; i++) {
    await until(run, start + (i * 1000) / rate);
    if (run.stop) break;
    if (run.slots.free() === 0) {
      dropped += 1;
      continue;
    }
    visits.push(visit(run, run.visits));
    run.visits += 1;
  }
  await until(run, start + seconds * 1000);
  await Promise.all(visits);
  const elapsed = (performance.now() - start) / 1000;
  return {
    ...summarise(run.samples, elapsed),
    rate,
    planned,
    started: visits.length,
    dropped,
    parts: run.parts,
    held: run.held,
  };
}

function ms(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)} ms`;
}

function perSecond(value: number): string {
  return value.toFixed(1);
}

/**
 * The nearest directory at or above `dir` with a .git in it, a repository's or a work tree's
 * link to one (this repository works from several), or null.
 */
function workTreeOf(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

type Sessions = { lines: string[]; tokens: Array<{ line: number; token: string }> };

/** The sessions file, read and checked before anybody is asked anything. */
function readSessions(file: string, target: URL): Sessions | string {
  const path = resolve(file);
  const tree = workTreeOf(dirname(path));
  if (tree !== null) {
    return `the sessions file is inside the git work tree ${tree}; keep it outside every one, where git cannot take it`;
  }
  let mode: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `${file} is not a file`;
    mode = stat.mode;
  } catch {
    return `no sessions file at ${file}`;
  }
  if ((mode & 0o077) !== 0) return `${file} can be read by others: chmod 600 it`;
  const lines = readFileSync(path, "utf8").split("\n");
  const tokens: Array<{ line: number; token: string }> = [];
  const seen = new Map<string, number>();
  let named: URL | null = null;
  for (const [line, text] of lines.entries()) {
    const token = text.trim();
    const api = TARGET_LINE.exec(token)?.[1];
    if (api !== undefined) {
      if (named !== null) return `line ${line + 1} of ${file} names a second API`;
      if (!URL.canParse(api)) return `line ${line + 1} of ${file} names no API`;
      named = new URL(api);
      continue;
    }
    if (token === "" || token.startsWith("#")) continue;
    // Never the line itself in a refusal: it may be a token with a character too many.
    if (!AuthRefreshRequest.shape.refreshToken.safeParse(token).success) {
      return `line ${line + 1} of ${file} is not a refresh token`;
    }
    const first = seen.get(token);
    if (first !== undefined) {
      return `line ${line + 1} of ${file} repeats line ${first + 1}: a refresh token presented twice ends its session (reuse, #35)`;
    }
    seen.set(token, line);
    tokens.push({ line, token });
  }
  // An API answers another's token as it answers an ended one (session_revoked): read against
  // the wrong one, the file would lose every session.
  if (named === null) {
    return `${file} names no API: its first line is "# target <origin>" (docs/runbooks/capacity.md)`;
  }
  if (!sameApi(named, target)) {
    return `${file} holds sessions of ${named.host}, and the target is ${target.host}`;
  }
  if (tokens.length === 0) return `${file} holds no refresh token`;
  if (tokens.length > CAP.sessions) {
    return `${file} holds ${tokens.length} sessions; at most ${CAP.sessions}`;
  }
  return { lines, tokens };
}

/** Written whole and renamed into place, so a crash leaves the old file or the new one. */
function writeSessions(file: string, lines: string[]): void {
  const path = resolve(file);
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, lines.join("\n"), { mode: 0o600 });
  renameSync(next, path);
}

/**
 * Every session rotated once, the new refresh token written back before the next is asked for;
 * one the API refuses is commented out with the day, not deleted. Then grouped by account, whose
 * budget its sessions share (ADR-026 §1). The account ids stay in this function's map.
 */
async function openSessions(
  base: URL,
  file: string,
  read: Sessions,
  io: Io,
  now: Date,
): Promise<
  { accounts: Account[]; sessions: number; personLimit: number; photosMax: number } | string
> {
  const live: string[] = [];
  for (const { line, token } of read.tokens) {
    const answer = await ask(base, "/auth/refresh", {
      method: "POST",
      body: { refreshToken: token },
    });
    if (typeof answer === "string") return `/auth/refresh: ${answer}`;
    if (answer.status === 401) {
      read.lines[line] = `# ended ${now.toISOString().slice(0, 10)}: ${token}`;
      writeSessions(file, read.lines);
      io.log(
        `load-smoke: the session on line ${line + 1} has ended and is commented out; sign that person in again (capacity.md)`,
      );
      continue;
    }
    const tokens = SessionTokens.safeParse(answer.json);
    if (answer.status !== 200 || !tokens.success) {
      return `/auth/refresh answered ${answer.status} ${codeOf(answer.json)}`;
    }
    read.lines[line] = tokens.data.refreshToken;
    writeSessions(file, read.lines);
    live.push(tokens.data.accessToken);
  }
  if (live.length === 0) return "no session in the file is live: sign the test persons in again";

  const byAccount = new Map<string, Account>();
  let personLimit = Number.POSITIVE_INFINITY;
  for (const access of live) {
    const answer = await ask(base, "/auth/session", { token: access });
    if (typeof answer === "string") return `/auth/session: ${answer}`;
    const session = SessionResponse.safeParse(answer.json);
    const budget = budgetOf(answer.headers);
    if (answer.status !== 200 || !session.success) {
      return `/auth/session answered ${answer.status} ${codeOf(answer.json)}`;
    }
    if (!budget) return "/auth/session sent no RateLimit-Limit: a budget unseen cannot be kept";
    personLimit = Math.min(personLimit, budget.limit);
    const account = byAccount.get(session.data.accountId) ?? {
      access: [],
      visits: 0,
      urlsLeft: URLS_PER_ACCOUNT,
      restUntil: 0,
    };
    account.access.push(access);
    byAccount.set(session.data.accountId, account);
  }

  const accounts = [...byAccount.values()];
  let photosMax = 0;
  for (const account of accounts) {
    const answer = await ask(base, "/photos", { token: account.access[0] });
    if (typeof answer === "string") return `/photos: ${answer}`;
    const list = PhotoList.safeParse(answer.json);
    if (answer.status !== 200 || !list.success) {
      return `/photos answered ${answer.status} ${codeOf(answer.json)}`;
    }
    photosMax = Math.max(photosMax, list.data.photos.length);
  }
  io.log(
    `load-smoke: ${live.length} session${live.length === 1 ? "" : "s"} of ${accounts.length} account${accounts.length === 1 ? "" : "s"}, each account's budget ${personLimit} a minute, up to ${photosMax} photos each`,
  );
  return { accounts, sessions: live.length, personLimit, photosMax };
}

/** The whole run: 0 when it ran (bent or not), 1 when refused before any load, 2 when a guard stopped it. */
async function execute(options: Options, io: Io, now: Date = new Date()): Promise<number> {
  const refuse = (why: string): number => {
    io.log(`load-smoke: ${why}`);
    return 1;
  };
  const base = options.target;
  const host = base.host;

  // Before anybody is asked anything: the file is the run's own.
  const read = options.sessions === undefined ? null : readSessions(options.sessions, base);
  if (typeof read === "string") return refuse(read);

  const health = await ask(base, "/health");
  if (typeof health === "string") return refuse(`nothing answers at ${host} (${health})`);
  const status = HealthResponse.safeParse(health.json);
  if (!status.success) return refuse(`what answers at ${host} is not Kuutti's API`);
  if (health.status !== 200 || status.data.status !== "ok") {
    return refuse(
      `the API at ${host} is not ready: database ${status.data.db}, migrations ${status.data.migrations}`,
    );
  }
  const contract = await ask(base, "/openapi.json");
  if (typeof contract === "string" || contract.status !== 200) {
    return refuse(
      `the API at ${host} does not serve /openapi.json, which production alone withholds (app.ts): nothing was sent`,
    );
  }
  const version = `${status.data.version} (${status.data.commit})`;
  io.log(`load-smoke: ${host} answers as Kuutti's API ${version}, and not as production`);

  let people: Awaited<ReturnType<typeof openSessions>> = {
    accounts: [],
    sessions: 0,
    personLimit: 0,
    photosMax: 0,
  };
  if (read && options.sessions) {
    people = await openSessions(base, options.sessions, read, io, now);
    if (typeof people === "string") return refuse(people);
  } else {
    io.log("load-smoke: no sessions: the public part of each visit alone");
  }

  const waitlist = await ask(base, "/waitlist");
  if (typeof waitlist === "string") return refuse(`/waitlist: ${waitlist}`);
  const address = budgetOf(waitlist.headers);
  if (waitlist.status !== 200) {
    return refuse(`/waitlist answered ${waitlist.status} ${codeOf(waitlist.json)}`);
  }
  if (!address) return refuse("/waitlist sent no RateLimit-Limit: a budget unseen cannot be kept");
  const accounts = people.accounts.length;
  const plan = planOf(options, {
    addressLimit: address.limit,
    personLimit: people.personLimit,
    accounts,
    photosMax: people.photosMax,
  });
  const over = options.rates.filter((rate) => rate > plan.ceiling);
  if (over.length > 0) {
    return refuse(
      `${over.join(", ")} visits a second is more than the budgets allow: at most ${plan.ceiling.toFixed(2)} with ${accounts} account${accounts === 1 ? "" : "s"} under a limit of ${address.limit} a minute, the plan taking ${PLAN_SHARE * 100} % of each window (ADR-026). More accounts (another test person signed in), or a rate-limit-per-minute of at least ${plan.neededLimit} for the run (the maintainer's, ADR-026 §5), lift it`,
    );
  }

  const run: Run = {
    base,
    accounts: people.accounts,
    thumbEvery: plan.thumbEvery,
    slots: slots(options.concurrency),
    anonymousRestUntil: 0,
    samples: [],
    parts: 0,
    held: 0,
    serverErrors: 0,
    stop: null,
    visits: 0,
  };
  // The photos screen's share is ADR-008's budget spread over the run, not the app's: say it.
  const urlsPerVisit = (people.photosMax / plan.thumbEvery).toFixed(2);
  const grid = accounts > 0 ? `1 in ${plan.thumbEvery} · ${urlsPerVisit}` : "-";
  io.log(
    `load-smoke: ${options.rates.length} stage${options.rates.length === 1 ? "" : "s"} of ${options.stageSeconds} s; the budgets allow ${plan.ceiling.toFixed(2)} visits a second${accounts > 0 ? `; the photos screen on ${plan.thumbEvery === 1 ? "every visit" : `one visit in ${plan.thumbEvery}`}, ${urlsPerVisit} signed URLs a visit` : ""}`,
  );
  const results: StageResult[] = [];
  let end: { result: StageResult; why: string; bent: boolean } | null = null;
  for (const [i, rate] of options.rates.entries()) {
    io.log(
      `load-smoke: stage ${i + 1} of ${options.rates.length} from ${new Date().toISOString()}: ${rate} visits a second for ${options.stageSeconds} s`,
    );
    const result = await stage(run, rate, options.stageSeconds);
    io.log(
      `  ${result.started} visits, ${result.dropped} dropped, ${result.held} of ${result.parts} parts held back for a resting budget; ${result.requests} requests, ${perSecond(result.rps)} answered a second, ${result.urls} of them thumbnail URLs; p50 ${ms(result.p50)}, p95 ${ms(result.p95)}, p99 ${ms(result.p99)}, max ${ms(result.max)}; ${result.errors} errors, ${result.timeouts} timed out`,
    );
    if (result.byRoute.length > 0) io.log(`  p95 by route: ${result.byRoute.join(", ")}`);
    if (result.problems.length > 0) io.log(`  not as expected: ${result.problems.join(", ")}`);
    results.push(result);
    if (run.stop?.status === 2) {
      io.log(`load-smoke: stopped: ${run.stop.why}. These numbers are not a measurement.`);
      return 2;
    }
    // The server's errors are the box's answer, whatever else the stage did; a stage that sent
    // less than its rate neither held nor bent there.
    const stopped = run.stop
      ? `${run.serverErrors} server errors or unanswered requests (the run stops sending at the third; what was in flight still finished)`
      : null;
    const short = stopped ? null : shortOf(result);
    const why = stopped ?? short ?? bendOf(result, options.stopP95);
    if (why) {
      end = { result, why, bent: short === null };
      break;
    }
  }

  const held = results.filter((result) => result !== end?.result).at(-1);
  const cell = (result: StageResult) => {
    const notes = [
      result.held > 0 ? `${result.held} parts held back` : "",
      result.timeouts > 0 ? `${result.timeouts} timed out` : "",
    ].filter(Boolean);
    return `${result.rate} · ${perSecond(result.rps)} · ${ms(result.p95).replace(" ms", "")}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
  };
  const verdict = !end
    ? `did not bend up to ${options.rates.at(-1)} visits a second`
    : end.bent
      ? `bent at ${end.result.rate}: ${end.why}`
      : `the stage at ${end.result.rate} is no measurement: ${end.why}`;
  io.log(
    `load-smoke: held ${held ? `at ${held.rate} visits a second` : "at no stage"}; ${verdict}`,
  );
  io.log("load-smoke: the row for docs/runbooks/capacity.md (the server's columns are yours):");
  const endCell = !end
    ? "-"
    : end.bent
      ? `${cell(end.result)} (${end.why})`
      : `not measured at ${end.result.rate} (${end.why})`;
  io.log(
    `| ${now.toISOString().slice(0, 10)} | | ${version} | ${options.kind} | ${accounts} · ${people.sessions} · ${address.limit} | ${grid} | ${held ? cell(held) : "-"} | ${endCell} | | | | | |`,
  );
  return 0;
}

/** The command line, the refusals and the sums, then runs against a stand-in API on this computer. */
async function selfTest(): Promise<never> {
  const failures: string[] = [];
  let checks = 0;
  const expect = (what: string, got: unknown, want: unknown) => {
    checks += 1;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    }
  };

  const outcome = (argv: string[], env: Record<string, string> = {}) => {
    try {
      const o = parseArgs(argv, env);
      return `${o.kind} ${o.target.origin} ${o.rates.join(",")} ${o.stageSeconds} ${o.concurrency} ${o.stopP95} ${o.sessions ?? "-"}`;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const local = "http://localhost:3000";
  // Built from its parts: a password written out in an address fails the secret scan.
  const credentialed = Object.assign(new URL(local), { username: "user", password: "secret" }).href;
  const neither = (host: string) =>
    `${host} is neither this computer nor staging (${STAGING}): the load smoke drives nothing else`;
  const confirm =
    "staging is the demo, and its address limit is the team's phones' too: add --confirm-staging once the run is announced (docs/runbooks/capacity.md)";
  const rates = (what: string) =>
    `--rates wants visits a second, each above 0 and at most 20, not ${what}`;
  const lines: Array<[string[], string, Record<string, string>?]> = [
    [[], `--target is required: http://localhost:3000, or ${STAGING} with --confirm-staging`],
    [["--target", local], `local ${local} 0.5 60 16 1000 -`],
    [
      ["--", "--target=http://127.0.0.1:3000", "--rates", "0.5, 1,2", "--stage", "30"],
      "local http://127.0.0.1:3000 0.5,1,2 30 16 1000 -",
    ],
    [
      ["--target", "http://[::1]:3000", "--concurrency=8", "--stop-p95", "800", "--sessions", "s"],
      "local http://[::1]:3000 0.5 60 8 800 s",
    ],
    [["--target", `${STAGING}/`, "--confirm-staging"], `staging ${STAGING} 0.5 60 16 1000 -`],
    [["--target", STAGING], confirm],
    [
      ["--target", local, "--confirm-staging"],
      "--confirm-staging is for staging; the target is this computer",
    ],
    [
      ["--target", "https://api.kuutti.app", "--confirm-staging"],
      "api.kuutti.app is production: the load smoke never runs there",
    ],
    [
      ["--target", "https://API.kuutti.app/"],
      "api.kuutti.app is production: the load smoke never runs there",
    ],
    [
      ["--target", "http://api.staging.kuutti.app", "--confirm-staging"],
      neither("api.staging.kuutti.app"),
    ],
    [
      ["--target", "https://pr-12.preview.api.staging.kuutti.app"],
      neither("pr-12.preview.api.staging.kuutti.app"),
    ],
    [["--target", "http://localhost.example.com:3000"], neither("localhost.example.com:3000")],
    [
      ["--target", `${STAGING}/health`, "--confirm-staging"],
      "--target is the API's origin alone, with no path",
    ],
    [
      ["--target", credentialed],
      "--target carries credentials; the load smoke takes none in an address",
    ],
    [["--target", "nonsense"], "--target is no address"],
    [["--target"], "--target takes a value"],
    [["--target", "--rates", "1"], "--target takes a value"],
    [["--target="], "--target takes a value"],
    [["--target", " "], "--target takes a value"],
    [["--target", local, "--target", local], "--target is given twice"],
    [
      ["--target", local, "--confirm-staging", "--confirm-staging"],
      "--confirm-staging is given twice",
    ],
    [["--target", local, "--confirm-staging=yes"], "--confirm-staging takes no value"],
    [["--self-test=1"], "--self-test takes no value"],
    [["--target", local, "--rates", "0"], rates("0")],
    [["--target", local, "--rates", "1,,2"], rates("nothing")],
    [["--target", local, "--rates", "21"], rates("21")],
    [["--target", local, "--rates", "fast"], rates("fast")],
    [["--target", local, "--rates", "-1"], "--rates takes a value"],
    [
      ["--target", local, "--rates", "1,2,3,4,5,6,7,8,9", "--stage", "10"],
      "--rates names 9 stages; at most 8",
    ],
    [["--target", local, "--stage", "9"], "--stage wants a whole number from 10 to 300, not 9"],
    [
      ["--target", local, "--stage", "60.5"],
      "--stage wants a whole number from 10 to 300, not 60.5",
    ],
    [
      ["--target", local, "--rates", "1,2,3", "--stage", "300"],
      "the run would last 900 s; at most 600 (an access token lives fifteen minutes and is refreshed once, at the start)",
    ],
    [
      ["--target", local, "--concurrency", "65"],
      "--concurrency wants a whole number from 1 to 64, not 65",
    ],
    [
      ["--target", local, "--stop-p95", "fast"],
      "--stop-p95 wants a whole number from 50 to 10000, not fast",
    ],
    [["--target", local, "--sessions"], "--sessions takes a value"],
    [["--target", local, "--verbose=1"], "unknown option --verbose"],
    [
      ["--target", local, "extra"],
      "unexpected argument: every option is named (--target, --sessions, --rates, --stage, --concurrency, --stop-p95, --confirm-staging)",
    ],
    [
      ["--target", local],
      "APP_ENV is production: the load smoke never runs there",
      { APP_ENV: "production" },
    ],
    [[], "APP_ENV is production: the load smoke never runs there", { APP_ENV: "production" }],
    [
      ["--target", STAGING, "--confirm-staging"],
      "APP_ENV says development, and the target is staging",
      { APP_ENV: "development" },
    ],
    [
      ["--target", local],
      "APP_ENV says staging, and the target is this computer",
      { APP_ENV: "staging" },
    ],
    [["--target", local], `local ${local} 0.5 60 16 1000 -`, { APP_ENV: "test" }],
    [
      ["--target", STAGING, "--confirm-staging"],
      `staging ${STAGING} 0.5 60 16 1000 -`,
      { APP_ENV: "staging" },
    ],
  ];
  for (const [argv, want, env] of lines)
    expect(`parseArgs ${JSON.stringify(argv)}`, outcome(argv, env), want);
  if (outcome(["--target", credentialed]).includes("secret")) {
    failures.push("a refusal printed the password of an address");
  }

  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  const unsorted = [30, 10, 20];
  const sums: Array<[string, number | null, number | null]> = [
    ["p95 of nothing", percentile([], 95), null],
    ["p50 of one", percentile([7], 50), 7],
    ["p99 of one", percentile([7], 99), 7],
    ["p50 of 1..100", percentile(hundred, 50), 50],
    ["p95 of 1..100", percentile(hundred, 95), 95],
    ["p99 of 1..100", percentile(hundred, 99), 99],
    ["p100 of 1..100", percentile(hundred, 100), 100],
    ["p95 of 1..20", percentile(hundred.slice(0, 20), 95), 19],
    ["p50 unsorted", percentile(unsorted, 50), 20],
    ["p95 of one slow in four", percentile([10, 10, 10, 1000], 95), 1000],
    ["p50 of one slow in four", percentile([10, 10, 10, 1000], 50), 10],
    [
      "p99.9 of 1..1000",
      percentile(
        Array.from({ length: 1000 }, (_, i) => i + 1),
        99.9,
      ),
      999,
    ],
  ];
  for (const [what, got, want] of sums) expect(what, got, want);
  expect("percentile leaves its input alone", unsorted, [30, 10, 20]);

  const shape = (plan: ReturnType<typeof planOf>) => [
    plan.thumbEvery,
    plan.ceiling.toFixed(3),
    plan.neededLimit,
  ];
  // Public only: 0.75 public requests a visit, 40 % of 120 a minute: 48 / 45.
  expect(
    "plan without sessions",
    shape(
      planOf(
        { rates: [0.5], stageSeconds: 60, concurrency: 16 },
        { addressLimit: 120, personLimit: 0, accounts: 0, photosMax: 0 },
      ),
    ),
    [1, "1.067", 57],
  );
  // Seven accounts of six photos over 90 visits: the photos screen every second visit, 7.5
  // signed-in requests a visit; the address holds sixteen in flight and binds, (48 - 16) / 45
  // against 7 * 48 / 450; one visit a second needs 64.3 a minute of each person, / 0.4.
  expect(
    "plan with seven accounts",
    shape(
      planOf(
        { rates: [0.5, 1], stageSeconds: 60, concurrency: 16 },
        { addressLimit: 120, personLimit: 120, accounts: 7, photosMax: 6 },
      ),
    ),
    [2, "0.711", 161],
  );
  // The limit raised to 1000 for the run: 720 visits, the photos screen on every eleventh; the
  // address binds, (400 - 32) / 45, and six visits a second need (270 + 32) / 0.4.
  expect(
    "plan with a raised limit",
    shape(
      planOf(
        { rates: [2, 4, 6], stageSeconds: 60, concurrency: 32 },
        { addressLimit: 1000, personLimit: 1000, accounts: 7, photosMax: 6 },
      ),
    ),
    [11, "8.178", 755],
  );
  // One account without photos: five requests a visit (the photos screen's list on each) against
  // its 40 % of 120, 48 / 300.
  expect(
    "plan of an account without photos",
    shape(
      planOf(
        { rates: [1], stageSeconds: 60, concurrency: 16 },
        { addressLimit: 120, personLimit: 120, accounts: 1, photosMax: 0 },
      ),
    ),
    [1, "0.160", 750],
  );

  const outcomes: Array<[Route, number, string, Outcome]> = [
    [ROUTES.exchange, 401, "auth_code_used", "ok"],
    [ROUTES.exchange, 401, "unreadable", "unexpected"],
    [ROUTES.exchange, 200, "", "unexpected"],
    [ROUTES.gate, 200, "", "ok"],
    [ROUTES.gate, 401, "session_expired", "signed-out"],
    [ROUTES.waitlist, 401, "unauthenticated", "unexpected"],
    [ROUTES.waitlist, 429, "rate_limited", "limited"],
    [ROUTES.thumb, 429, "photo_budget_exceeded", "limited"],
    [ROUTES.gate, 503, "unreadable", "server"],
    [ROUTES.thumb, 404, "not_found", "unexpected"],
  ];
  for (const [route, status, code, want] of outcomes) {
    expect(`outcomeOf ${route.name} ${status} ${code}`, outcomeOf(route, status, code), want);
  }
  expect(
    "codeOf an envelope",
    codeOf({ error: { code: "auth_code_used", message: "m", requestId: "r" } }),
    "auth_code_used",
  );
  expect("codeOf something else", codeOf({ token: "x" }), "unreadable");
  expect(
    "codeOf a code of another shape",
    codeOf({ error: { code: "Bearer abc", message: "m", requestId: "r" } }),
    "unreadable",
  );
  expect(
    "nobody's code has the exchange's shape",
    AuthExchangeRequest.safeParse(nobodysCode()).success,
    true,
  );

  const result = (over: Partial<StageResult>): StageResult => ({
    rate: 1,
    planned: 100,
    started: 100,
    dropped: 0,
    parts: 175,
    held: 0,
    requests: 500,
    errors: 0,
    timeouts: 0,
    urls: 0,
    rps: 8,
    p50: 20,
    p95: 100,
    p99: 200,
    max: 300,
    byRoute: [],
    problems: [],
    ...over,
  });
  expect("a stage that holds", bendOf(result({}), 1000), null);
  expect("a stage at its p95", bendOf(result({ p95: 1000 }), 1000), null);
  expect("a slow stage", bendOf(result({ p95: 1000.6 }), 1000), "p95 1001 ms is over 1000");
  expect("a stage at 1 % errors", bendOf(result({ errors: 5 }), 1000), null);
  expect("a stage of errors", bendOf(result({ errors: 6 }), 1000), "6 of 500 answers were errors");
  expect(
    "a stage of dropped visits",
    bendOf(result({ dropped: 2 }), 1000),
    "2 of 100 visits were dropped: every request slot was busy",
  );
  expect("a stage that held a part back", shortOf(result({ held: 1 })), null);
  expect(
    "a stage that held parts back",
    shortOf(result({ held: 2 })),
    "2 of 175 parts of its visits were held back for a resting budget",
  );

  const sample = (route: Route, ms: number): Sample => ({
    route: route.name,
    ms,
    outcome: "ok",
    label: `${route.name} 200`,
  });
  // Nine quick answers, a timeout and a refused connection: the timeout is the p95, counted at
  // the timeout, and was not answered; the refused connection took no time.
  const summary = summarise(
    [
      ...Array.from({ length: 8 }, () => sample(ROUTES.gate, 10)),
      sample(ROUTES.thumb, 20),
      unanswered(ROUTES.thumb, "timeout"),
      unanswered(ROUTES.profile, "unreachable"),
    ],
    2,
  );
  expect(
    "a stage's summary",
    [
      summary.requests,
      summary.errors,
      summary.timeouts,
      summary.urls,
      summary.rps,
      summary.p50,
      summary.p95,
      summary.max,
    ],
    [11, 2, 1, 2, 4.5, 10, REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS],
  );
  expect("a stage's p95 by route", summary.byRoute, [
    "GET /gate 10 ms",
    "GET /photos/{id}/thumb 10000 ms",
    "GET /profile -",
  ]);
  expect("a stage's problems", summary.problems, [
    "GET /photos/{id}/thumb timeout ×1",
    "GET /profile unreachable ×1",
  ]);

  const api = (raw: string) => new URL(raw);
  const apis: Array<[string, string, boolean]> = [
    [STAGING, `${STAGING}/`, true],
    ["http://localhost:3000", "http://127.0.0.1:3000", true],
    ["http://[::1]:3000", "http://localhost:3000", true],
    ["http://localhost:3000", "http://localhost:3001", false],
    ["http://localhost:3000", STAGING, false],
    ["https://localhost:3000", "http://localhost:3000", false],
  ];
  for (const [a, b, want] of apis) expect(`sameApi ${a} ${b}`, sameApi(api(a), api(b)), want);

  const runs = await standInRuns(expect);
  for (const failure of failures) console.error(`✖ self-test: ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log(
    `✔ load-smoke self-test: ${checks} checks, ${lines.length} of them command lines, ${runs} runs against a stand-in`,
  );
  process.exit(0);
}

/**
 * Runs of execute against a stand-in API on 127.0.0.1, each guard by what it answers and what the
 * stand-in was asked: a whole run, the refusals before any load, the stops, the rests. Nothing
 * leaves this computer.
 */
async function standInRuns(
  expect: (what: string, got: unknown, want: unknown) => void,
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "kuutti-load-smoke-"));
  let runs = 0;
  const token = () => randomBytes(32).toString("base64url");
  const sessionsFile = (name: string, text: string, mode = 0o600) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    chmodSync(path, mode);
    return path;
  };
  const ours = (target: URL, ...lines: string[]) =>
    [`# target ${target.origin}`, ...lines, ""].join("\n");
  /** One run: its exit, what it printed, and the file it was given after it. */
  const drive = async (
    target: URL,
    sessions: string | undefined,
    over: Partial<Options> = {},
  ): Promise<{ status: number; out: string[]; printed: string }> => {
    runs += 1;
    const out: string[] = [];
    const status = await execute(
      {
        target,
        kind: "local",
        sessions,
        rates: [4],
        stageSeconds: 1,
        concurrency: 4,
        stopP95: 1000,
        ...over,
      },
      { log: (line) => out.push(line) },
    );
    return { status, out, printed: out.join("\n") };
  };
  const times = (seen: string[], route: string) => seen.filter((r) => r === route).length;
  try {
    // A whole run: one live session, a comment, one that has ended and is commented out.
    const live = token();
    const ended = token();
    const a = await standIn([live]);
    const fileA = sessionsFile("a", ours(a.url, live, "# a comment", ended));
    const runA = await drive(a.url, fileA);
    await a.close();
    const rotated = readFileSync(fileA, "utf8").split("\n");
    expect("a whole run's exit", runA.status, 0);
    expect(
      "the file after the run",
      [
        rotated.length,
        rotated[0],
        a.refresh.has(rotated[1] ?? ""),
        rotated[2],
        rotated[3] === `# ended ${new Date().toISOString().slice(0, 10)}: ${ended}`,
      ],
      [5, `# target ${a.url.origin}`, true, "# a comment", true],
    );
    expect("the file's mode after the run", statSync(fileA).mode & 0o777, 0o600);
    expect(
      "an ended session is named by its line",
      runA.out.includes(
        "load-smoke: the session on line 4 has ended and is commented out; sign that person in again (capacity.md)",
      ),
      true,
    );
    const secrets = [live, ended, ...a.refresh, ...a.access, a.accountId, ...a.photoIds];
    expect(
      "a token or an id in the output",
      secrets.filter((secret) => runA.printed.includes(secret)).length,
      0,
    );
    expect("the routes of a whole run", [...new Set(a.seen)].sort(), [
      "GET /auth/session",
      "GET /gate",
      "GET /health",
      "GET /onboarding",
      "GET /openapi.json",
      "GET /photos",
      "GET /photos/{id}/thumb",
      "GET /profile",
      "GET /waitlist",
      "POST /auth/exchange",
      "POST /auth/refresh",
    ]);
    // Four visits, each with the photos screen (two photos, 4 * 2 / 60 rounds up to every visit):
    // the profile's list and the screen's own, after the one that counted the photos.
    expect(
      "the photo lists and URLs of a whole run",
      [times(a.seen, "GET /photos"), times(a.seen, "GET /photos/{id}/thumb")],
      [9, 8],
    );
    expect(
      "the row of a whole run",
      runA.out.some((line) =>
        /^\| \d{4}-\d{2}-\d{2} \| \| 0\.0\.0-test \(abc1234\) \| local \| 1 · 1 · 60000 \| 1 in 1 · 2\.00 \| 4 · [\d.]+ · \d+ \| - \| /.test(
          line,
        ),
      ),
      true,
    );

    // Production withholds its contract: nothing past the two questions, the file untouched.
    const kept = token();
    const b = await standIn([kept], { production: true });
    const fileB = sessionsFile("b", ours(b.url, kept));
    expect("production's exit", (await drive(b.url, fileB)).status, 1);
    await b.close();
    expect("what production was asked", b.seen, ["GET /health", "GET /openapi.json"]);
    expect("the file production left", readFileSync(fileB, "utf8"), ours(b.url, kept));

    // What answers is not Kuutti's API: refused after the one question.
    const n = await standIn([], {
      twist: (route) =>
        route === "GET /health" ? { status: 200, json: { status: "ok" } } : undefined,
    });
    const runN = await drive(n.url, undefined);
    await n.close();
    expect(
      "a stranger's refusal",
      [runN.status, n.seen, runN.out],
      [1, ["GET /health"], [`load-smoke: what answers at ${n.url.host} is not Kuutti's API`]],
    );

    // A limit too small for the rate: refused once the address's budget is read, before a stage.
    const e = await standIn([token()], { twist: () => ({ limit: 10, remaining: 9 }) });
    const fileE = sessionsFile("e", ours(e.url, [...e.refresh][0] ?? ""));
    const runE = await drive(e.url, fileE);
    await e.close();
    expect("an over-budget run's exit", runE.status, 1);
    expect("what an over-budget run asked", e.seen, [
      "GET /health",
      "GET /openapi.json",
      "POST /auth/refresh",
      "GET /auth/session",
      "GET /photos",
      "GET /waitlist",
    ]);
    expect(
      "an over-budget run's refusal",
      [
        runE.out
          .at(-1)
          ?.startsWith(
            "load-smoke: 4 visits a second is more than the budgets allow: at most 0.00 with 1 account under a limit of 10 a minute",
          ),
        runE.out.some((line) => line.startsWith("load-smoke: stage")),
      ],
      [true, false],
    );

    // A 429 in the middle stops the run, and says its numbers are no measurement.
    const c = await standIn([token()], {
      twist: (route) => (route === "GET /gate" ? { status: 429, code: "rate_limited" } : undefined),
    });
    const fileC = sessionsFile("c", ours(c.url, [...c.refresh][0] ?? ""));
    const runC = await drive(c.url, fileC);
    await c.close();
    expect(
      "a refused run",
      [
        runC.status,
        runC.out.some((line) => line.startsWith("load-smoke: stopped: GET /gate 429 rate_limited")),
      ],
      [2, true],
    );

    // A session that ends during the run stops it at its first 401.
    const f = await standIn([token()], {
      twist: (route) =>
        route === "GET /profile" ? { status: 401, code: "session_expired" } : undefined,
    });
    const fileF = sessionsFile("f", ours(f.url, [...f.refresh][0] ?? ""));
    const runF = await drive(f.url, fileF);
    await f.close();
    expect(
      "a signed-out run",
      [
        runF.status,
        times(f.seen, "GET /profile"),
        runF.out.some((line) =>
          line.startsWith(
            "load-smoke: stopped: GET /profile 401 session_expired: a session ended during the run",
          ),
        ),
      ],
      [2, 1, true],
    );

    // Server errors: the run stops sending at the third, and the stage has bent there.
    const g = await standIn([token()], {
      twist: (route) => (route === "GET /gate" ? { status: 500, code: "internal" } : undefined),
    });
    const fileG = sessionsFile("g", ours(g.url, [...g.refresh][0] ?? ""));
    const runG = await drive(g.url, fileG, { rates: [8] });
    await g.close();
    expect(
      "a run of server errors",
      [
        runG.status,
        times(g.seen, "GET /gate") < 8,
        runG.out.some((line) =>
          /^load-smoke: held at no stage; bent at 8: \d+ server errors or unanswered requests \(the run stops sending at the third/.test(
            line,
          ),
        ),
      ],
      [0, true, true],
    );

    // The address's budget under half on a public answer rests the public parts for a window:
    // the stage sent less than its rate, and is no measurement.
    const h = await standIn([], {
      twist: (route, nth) =>
        route === "GET /waitlist" && nth >= 1 ? { remaining: 10 } : undefined,
    });
    const runH = await drive(h.url, undefined, { rates: [8] });
    await h.close();
    expect(
      "a run whose address rests",
      [
        runH.status,
        times(h.seen, "GET /waitlist"),
        times(h.seen, "POST /auth/exchange"),
        runH.out.some((line) =>
          /^load-smoke: held at no stage; the stage at 8 is no measurement: \d+ of \d+ parts of its visits were held back/.test(
            line,
          ),
        ),
      ],
      [0, 2, 1, true],
    );

    // A person's budget under half rests that account: the same, and the row says so.
    const i = await standIn([token()], {
      twist: (route) => (route === "GET /onboarding" ? { remaining: 10 } : undefined),
    });
    const fileI = sessionsFile("i", ours(i.url, [...i.refresh][0] ?? ""));
    const runI = await drive(i.url, fileI);
    await i.close();
    expect(
      "a run whose person rests",
      [
        runI.status,
        times(i.seen, "GET /onboarding"),
        runI.out.some((line) => /\| - \| not measured at 4 \(\d+ of \d+ parts/.test(line)),
      ],
      [0, 1, true],
    );

    // Refused before anybody is asked: each file a run must not take.
    const idle = await standIn([]);
    const one = token();
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "sub"), { recursive: true });
    writeFileSync(join(tree, ".git"), "gitdir: elsewhere\n");
    const refusals: Array<[string, string, string]> = [
      [
        "a file others can read",
        sessionsFile("d", ours(idle.url, one), 0o644),
        "can be read by others: chmod 600 it",
      ],
      [
        "a token twice",
        sessionsFile("j", ours(idle.url, one, one)),
        "repeats line 2: a refresh token presented twice ends its session (reuse, #35)",
      ],
      [
        "a line that is no token",
        sessionsFile("k", ours(idle.url, "not-a-token")),
        "is not a refresh token",
      ],
      [
        "another API's file",
        sessionsFile("o", ["# target http://127.0.0.1:1", one, ""].join("\n")),
        `holds sessions of 127.0.0.1:1, and the target is ${idle.url.host}`,
      ],
      [
        "a file without its API",
        sessionsFile("p", `${one}\n`),
        'names no API: its first line is "# target <origin>" (docs/runbooks/capacity.md)',
      ],
      [
        "a file in this checkout",
        join(ROOT, "load-sessions"),
        `inside the git work tree ${ROOT}; keep it outside every one, where git cannot take it`,
      ],
      [
        "a file in another work tree",
        join(tree, "sub", "sessions"),
        `inside the git work tree ${tree}; keep it outside every one, where git cannot take it`,
      ],
    ];
    for (const [what, file, refusal] of refusals) {
      const before = existsSync(file) ? readFileSync(file, "utf8") : null;
      const run = await drive(idle.url, file);
      expect(
        `${what}: refused`,
        [run.status, run.out.length, run.out[0]?.endsWith(refusal)],
        [1, 1, true],
      );
      expect(`${what}: the file`, existsSync(file) ? readFileSync(file, "utf8") : null, before);
    }
    await idle.close();
    expect("what the refused files asked", idle.seen, []);
    return runs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Twist = { status?: number; code?: string; json?: unknown; limit?: number; remaining?: number };

/**
 * Kuutti's API as far as a run asks it: every answer from the contract, the budgets roomy, unless
 * a twist answers a route (by template, and how many times it was asked before) otherwise.
 */
async function standIn(
  refreshTokens: string[],
  behaviour: {
    production?: boolean;
    twist?: (route: string, nth: number) => Twist | undefined;
  } = {},
) {
  const refresh = new Set(refreshTokens);
  const access = new Set<string>();
  const accountId = randomUUID();
  const photos = [0, 1].map((position) => ({
    id: randomUUID(),
    blurhash: "LEHV6nWB",
    width: 1600,
    height: 1200,
    state: "approved",
    rejectionReason: null,
    appealable: false,
    position,
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const later = "2026-12-31T00:00:00.000Z";
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const route = `${req.method} ${new URL(req.url ?? "/", "http://stand-in").pathname}`.replace(
      /^GET \/photos\/[^/]+\/thumb$/,
      "GET /photos/{id}/thumb",
    );
    const twist = behaviour.twist?.(route, seen.filter((r) => r === route).length);
    seen.push(route);
    const answer = (status: number, json: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "ratelimit-limit": String(twist?.limit ?? 60_000),
        "ratelimit-remaining": String(twist?.remaining ?? 59_990),
      });
      res.end(JSON.stringify(json));
    };
    const refused = (status: number, code: string) =>
      answer(status, { error: { code, message: "refused", requestId: "stand-in" } });
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (twist?.status !== undefined) {
      return twist.json === undefined
        ? refused(twist.status, twist.code ?? "internal")
        : answer(twist.status, twist.json);
    }
    if (route === "GET /health") {
      return answer(200, {
        status: "ok",
        version: "0.0.0-test",
        commit: "abc1234",
        builtAt: later,
        source: "https://github.com/kuutti-ry/kuutti-app",
        db: "ok",
        migrations: "current",
      });
    }
    if (route === "GET /openapi.json") {
      return behaviour.production ? refused(404, "not_found") : answer(200, { openapi: "3.1.0" });
    }
    if (route === "GET /waitlist") return answer(200, {});
    if (route === "POST /auth/exchange") return refused(401, "auth_code_used");
    if (route === "POST /auth/refresh") {
      const presented = (JSON.parse(body) as { refreshToken?: string }).refreshToken ?? "";
      if (!refresh.delete(presented)) return refused(401, "session_revoked");
      const next = {
        access: randomBytes(32).toString("base64url"),
        refresh: randomBytes(32).toString("base64url"),
      };
      refresh.add(next.refresh);
      access.add(next.access);
      return answer(200, {
        sessionId: randomUUID(),
        accessToken: next.access,
        accessExpiresAt: later,
        refreshToken: next.refresh,
        refreshExpiresAt: later,
      });
    }
    if (!access.has(bearer)) return refused(401, "unauthenticated");
    if (route === "GET /auth/session") {
      return answer(200, {
        sessionId: randomUUID(),
        accountId,
        platform: "ios",
        createdAt: later,
        refreshExpiresAt: later,
      });
    }
    if (route === "GET /photos")
      return answer(200, { photos, maxPhotos: 6, tips: [], fishSpecies: null });
    if (route === "GET /photos/{id}/thumb") {
      return answer(200, {
        url: "https://media.example/thumb",
        variant: "thumb",
        expiresAt: later,
      });
    }
    if (["GET /onboarding", "GET /gate", "GET /profile"].includes(route)) return answer(200, {});
    return refused(404, "not_found");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    seen,
    refresh,
    access,
    accountId,
    photoIds: photos.map((photo) => photo.id),
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}
