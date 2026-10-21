import {
  type ApiComponents,
  type DealBreakerField,
  ErrorResponse,
  type Relaxation,
  RelaxationAnswer,
  RelaxationsResponse,
  RelaxationUndone,
  type RoundChoice,
  RoundDecisionAnswer,
  type RoundEntry,
  RoundResponse,
} from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// Today's round as the app calls it (#379, ADR-034 §4), through the typed
// client; the zod contracts guard the runtime (ADR-003). A refusal keeps the
// envelope's code, which the screen says in words, and its wait.

/** A refusal of the round's routes, with the wait a budget's 429 names (Retry-After, in seconds). */
export class RoundRefusal extends ApiError {
  constructor(
    message: string,
    status: number,
    code: string | undefined,
    readonly retryAfter: number | null,
  ) {
    super(message, status, code);
    this.name = "RoundRefusal";
  }
}

function failed(response: Response, error: unknown, what: string): RoundRefusal {
  const parsed = ErrorResponse.safeParse(error);
  const wait = Number(response.headers.get("retry-after") ?? Number.NaN);
  return new RoundRefusal(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
    Number.isFinite(wait) && wait >= 0 ? wait : null,
  );
}

/** The day and its cards in order; the first read of a day builds it once matching is open (ADR-035 §5). */
export async function fetchRound(): Promise<RoundResponse> {
  const { data, error, response } = await api.GET("/rounds/today");
  if (!data) throw failed(response, error, "round");
  return RoundResponse.parse(data);
}

/** The card was on the screen: the first report is recorded, a repeat writes nothing. */
export async function reportSeen(day: string, position: number): Promise<void> {
  const { error, response } = await api.POST("/rounds/{day}/entries/{position}/seen", {
    params: { path: { day, position } },
  });
  if (!response.ok) throw failed(response, error, "seen");
}

/** A like, a pass or a fish, replacing the day's earlier one; the answer names a match's conversation (#100). */
export async function decide(
  day: string,
  position: number,
  decision: RoundChoice,
): Promise<RoundDecisionAnswer> {
  const { data, error, response } = await api.PUT("/rounds/{day}/entries/{position}/decision", {
    params: { path: { day, position } },
    body: { decision },
  });
  if (!data) throw failed(response, error, "decision");
  return RoundDecisionAnswer.parse(data);
}

/** What a short round may relax today, and what is relaxed (#99, ADR-042 §4); counted when asked. */
export async function fetchRelaxations(day: string): Promise<RelaxationsResponse> {
  const { data, error, response } = await api.GET("/rounds/{day}/relaxations", {
    params: { path: { day } },
  });
  if (!data) throw failed(response, error, "relaxations");
  return RelaxationsResponse.parse(data);
}

/** One deal-breaker relaxed for today: the cards it added, to append without reading the round again (§5). */
export async function relaxToday(day: string, relaxation: Relaxation): Promise<RoundEntry[]> {
  const { data, error, response } = await api.POST("/rounds/{day}/relaxations", {
    params: { path: { day } },
    // The contract's field is the deal-breakers' enum; zod's type of it is the wider field key.
    body: relaxation as ApiComponents["schemas"]["Relaxation"],
  });
  if (!data) throw failed(response, error, "relax");
  return RelaxationAnswer.parse(data).entries;
}

/** Today's relaxation undone: the places of the undecided cards it took back (§6). */
export async function undoRelaxation(day: string, field: DealBreakerField): Promise<number[]> {
  const { data, error, response } = await api.DELETE("/rounds/{day}/relaxations/{field}", {
    params: { path: { day, field: field as ApiComponents["schemas"]["DealBreakerField"] } },
  });
  if (!data) throw failed(response, error, "undo relaxation");
  return RelaxationUndone.parse(data).removed;
}
