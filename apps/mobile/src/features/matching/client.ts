import {
  type ApiComponents,
  ConversationList,
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

// The queue as the app calls it (#379, #502, ADR-034 §4, ADR-062), through the
// typed client; the zod contracts guard the runtime (ADR-003). A refusal keeps
// the envelope's code, which the screen says in words.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/**
 * The day and the next cards, undecided, in order, a page of them: a read with
 * none left adds the next people. Null entries before matching opens, an empty
 * list at the queue's end (ADR-062 §1).
 */
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

/**
 * How many conversations wait on the person's answer now (ADR-062 §5), for the
 * refusal that carries no number: the list without thumbs, which signs and spends
 * nothing, where a read of the queue would serve its cards again (ADR-008) and
 * count towards its alarm (ADR-041).
 */
export async function fetchYourTurn(): Promise<number> {
  const { data, error, response } = await api.GET("/conversations", {
    params: { query: { thumbs: "false" } },
  });
  if (!data) throw failed(response, error, "conversations");
  return ConversationList.parse(data).yourTurn.waiting;
}

/**
 * A like, a pass, a fish or a skip, replacing the day's earlier one; the answer
 * names a match's conversation (#100), and says whether a fish can still go
 * today (#475), the likes left (#524) and the conversations waiting (ADR-062 §5).
 */
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

/** What a short queue may relax today, and what is relaxed (#99, ADR-042 §4); counted when asked. */
export async function fetchRelaxations(day: string): Promise<RelaxationsResponse> {
  const { data, error, response } = await api.GET("/rounds/{day}/relaxations", {
    params: { path: { day } },
  });
  if (!data) throw failed(response, error, "relaxations");
  return RelaxationsResponse.parse(data);
}

/** One deal-breaker relaxed for today: the first cards it added, to append without a read (§5, ADR-062 §10). */
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
