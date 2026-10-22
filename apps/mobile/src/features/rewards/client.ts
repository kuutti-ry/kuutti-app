import { ErrorResponse, InvitationCreated, Invitations } from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The invitations as the app calls them (#107, ADR-044), through the typed
// client; the zod contracts guard the runtime (ADR-003). A refusal carries the
// envelope's code, for the screens to say it in their words.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** The caller's own: whether they may invite and still type a code, the open ones, what they earned. */
export async function fetchInvitations(): Promise<Invitations> {
  const { data, error, response } = await api.GET("/invitations");
  if (!data) throw failed(response, error, "invitations");
  return Invitations.parse(data);
}

/** A new invitation; its code is in this answer and nowhere else, ever. */
export async function makeInvitation(): Promise<InvitationCreated> {
  const { data, error, response } = await api.POST("/invitations");
  if (!data) throw failed(response, error, "invitation");
  return InvitationCreated.parse(data);
}

/** Withdraws an open invitation of the caller's; its code works no more. */
export async function withdrawInvitation(id: string): Promise<void> {
  const { error, response } = await api.DELETE("/invitations/{id}", {
    params: { path: { id } },
  });
  if (!response.ok) throw failed(response, error, "withdrawal");
}

/** A code from a friend, as typed: the API reads case, spaces and hyphens away. */
export async function redeemInvitation(code: string): Promise<void> {
  const { error, response } = await api.POST("/invitations/redeem", { body: { code } });
  if (!response.ok) throw failed(response, error, "redeem");
}
