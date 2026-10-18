import { type ConversationReportRequest, ErrorResponse, type ReportRequest } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The block and report routes as the app calls them (#84, ADR-030), from a
// card and from a conversation (#351), through the typed client; the zod
// contracts guard the runtime (ADR-003). Each answers 204 whatever stood
// before, so the app learns nothing about the other person.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** Blocks the person of a card the caller was shown: from then on neither is shown to the other. */
export async function blockPerson(accountId: string): Promise<void> {
  const { error, response } = await api.POST("/blocks", { body: { accountId } });
  if (!response.ok) throw failed(response, error, "block");
}

/** Reports the person of a card the caller was shown, which blocks them too. */
export async function reportPerson(body: ReportRequest): Promise<void> {
  const { error, response } = await api.POST("/reports", { body });
  if (!response.ok) throw failed(response, error, "report");
}

/** Blocks the other person of a conversation, which ends it for both (#351). */
export async function blockConversation(id: string): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/block", {
    params: { path: { id } },
  });
  if (!response.ok) throw failed(response, error, "block");
}

/** Reports the other person of a conversation with a copy of it, which blocks them too (#351). */
export async function reportConversation(
  id: string,
  body: ConversationReportRequest,
): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/report", {
    params: { path: { id } },
    body,
  });
  if (!response.ok) throw failed(response, error, "report");
}
