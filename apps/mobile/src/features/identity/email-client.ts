import { AccountEmailResponse, ErrorResponse } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The optional e-mail's routes as the app calls them (#148, #385), through
// the typed client; the zod contracts guard the runtime (ADR-003). Each
// answers the address with whether it is confirmed and until when a code
// waits (ADR-043 §1), the removal's empty answer included.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** What is left once the address is removed: the removal answers 204, with no body. */
const NO_EMAIL: AccountEmailResponse = { email: null, confirmed: false, codeExpiresAt: null };

export async function fetchEmail(): Promise<AccountEmailResponse> {
  const { data, error, response } = await api.GET("/account/email");
  if (!data) throw failed(response, error, "email");
  return AccountEmailResponse.parse(data);
}

/** A different address comes back unconfirmed; the save itself sends nothing (ADR-043 §2). */
export async function saveEmail(email: string): Promise<AccountEmailResponse> {
  const { data, error, response } = await api.PUT("/account/email", { body: { email } });
  if (!data) throw failed(response, error, "email save");
  return AccountEmailResponse.parse(data);
}

export async function clearEmail(): Promise<AccountEmailResponse> {
  const { error, response } = await api.DELETE("/account/email");
  if (!response.ok) throw failed(response, error, "email removal");
  return NO_EMAIL;
}

/** A fresh code to the stored address; one that waited stops working (ADR-043 §3). */
export async function sendEmailCode(): Promise<AccountEmailResponse> {
  const { data, error, response } = await api.POST("/account/email/code");
  if (!data) throw failed(response, error, "email code");
  return AccountEmailResponse.parse(data);
}

export async function confirmEmailCode(code: string): Promise<AccountEmailResponse> {
  const { data, error, response } = await api.POST("/account/email/confirm", { body: { code } });
  if (!data) throw failed(response, error, "email confirmation");
  return AccountEmailResponse.parse(data);
}
