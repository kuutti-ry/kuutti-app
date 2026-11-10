import type { FeedbackRequest } from "@kuutti/schema";
import { api, failed } from "@/lib/api";

// The feedback route as the app calls it (#171, ADR-023), through the typed
// client; the zod contract guards the runtime (ADR-003).

export async function sendFeedback(body: FeedbackRequest): Promise<void> {
  const { error, response } = await api.POST("/feedback", { body });
  if (!response.ok) throw failed(response, error, "feedback");
}
