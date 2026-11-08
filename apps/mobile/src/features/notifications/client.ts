import {
  ErrorResponse,
  Notices,
  NotificationChoices,
  type NotificationKind,
  type PushTokenRequest,
} from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The notification choices, the notices and this phone's push token as the
// app calls them (#176, ADR-032; #102, ADR-055), through the typed client;
// the zod contracts guard the runtime.

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** Every kind and whether it is on. */
export async function fetchChoices(): Promise<NotificationChoices> {
  const { data, error, response } = await api.GET("/account/notifications");
  if (!data) throw failed(response, error, "notifications");
  return NotificationChoices.parse(data);
}

/** Switches one kind; answered with every kind as it now stands. */
export async function saveChoice(
  kind: NotificationKind,
  enabled: boolean,
): Promise<NotificationChoices> {
  const { data, error, response } = await api.PUT("/account/notifications/{kind}", {
    params: { path: { kind } },
    body: { enabled },
  });
  if (!data) throw failed(response, error, "notification");
  return NotificationChoices.parse(data);
}

/** The newest notices, read and unread. */
export async function fetchNotices(): Promise<Notices> {
  const { data, error, response } = await api.GET("/notices");
  if (!data) throw failed(response, error, "notices");
  return Notices.parse(data);
}

export async function markNoticeRead(id: string): Promise<void> {
  const { error, response } = await api.POST("/notices/{id}/read", { params: { path: { id } } });
  if (!response.ok) throw failed(response, error, "notice");
}

/**
 * This phone's push token for the caller's session (ADR-055 §2). The API
 * words the pushes in the request's language, so it is named here: the app's
 * own, which the person may have chosen over the phone's.
 */
export async function savePushToken(body: PushTokenRequest, locale: string): Promise<void> {
  const { error, response } = await api.PUT("/push-token", {
    body,
    headers: { "accept-language": locale },
  });
  if (!response.ok) throw failed(response, error, "push token");
}
