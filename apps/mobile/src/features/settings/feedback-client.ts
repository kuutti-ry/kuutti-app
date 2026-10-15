import { ErrorResponse, type FeedbackRequest } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The feedback route as the app calls it (#171, ADR-023), through the typed
// client; the zod contract guards the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

export async function sendFeedback(body: FeedbackRequest): Promise<void> {
  const { error, response } = await api.POST("/feedback", { body });
  if (!response.ok) throw failed(response, error, "feedback");
}
