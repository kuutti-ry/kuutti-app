import { AccountEmailResponse, ErrorResponse } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The optional e-mail's routes as the app calls them (#148), through the
// typed client; the zod contracts guard the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

export async function fetchEmail(): Promise<string | null> {
  const { data, error, response } = await api.GET("/account/email");
  if (!data) throw failed(response, error, "email");
  return AccountEmailResponse.parse(data).email;
}

export async function saveEmail(email: string): Promise<string | null> {
  const { error, response } = await api.PUT("/account/email", { body: { email } });
  if (!response.ok) throw failed(response, error, "email save");
  return email;
}

export async function clearEmail(): Promise<string | null> {
  const { error, response } = await api.DELETE("/account/email");
  if (!response.ok) throw failed(response, error, "email removal");
  return null;
}
