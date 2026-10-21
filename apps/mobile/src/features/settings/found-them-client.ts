import { ErrorResponse, type FoundReason, FoundThemStatus } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// "Löysin hänet" as the app calls it (#83, ADR-040), through the typed client;
// the zod contract guards the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** Whether this account told Kuutti already; never which reason. */
export async function readFoundThem(): Promise<boolean> {
  const { data, error, response } = await api.GET("/account/found-them");
  if (!response.ok || !data) throw failed(response, error, "found-them read");
  return FoundThemStatus.parse(data).answered;
}

/** The answer; a second one is refused as found_them_answered, which the screen reads as done. */
export async function tellFoundThem(reason: FoundReason): Promise<void> {
  const { error, response } = await api.POST("/account/found-them", { body: { reason } });
  if (!response.ok) throw failed(response, error, "found-them");
}
