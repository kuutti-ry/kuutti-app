import {
  ChatMessage,
  ConversationDetail,
  ConversationList,
  ErrorResponse,
  MessagePage,
  type MessagesQuery,
  type SendMessageRequest,
} from "@kuutti/schema";
import { ApiError, api } from "@/lib/api";

// The chat's routes as the app calls them (#348, ADR-031), through the typed
// client; the zod contracts guard the runtime (ADR-003).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

/** The list; without thumbs for a count alone (the home screen), so nothing is signed or spent. */
export async function fetchConversations(thumbs = true): Promise<ConversationList> {
  const { data, error, response } = await api.GET("/conversations", {
    params: { query: { thumbs: thumbs ? "true" : "false" } },
  });
  if (!data) throw failed(response, error, "conversations");
  return ConversationList.parse(data);
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const { data, error, response } = await api.GET("/conversations/{id}", {
    params: { path: { id } },
  });
  if (!data) throw failed(response, error, "conversation");
  return ConversationDetail.parse(data);
}

/** A page: back from `before` newest first, onward from `after` oldest first, or the newest. */
export async function fetchMessages(
  id: string,
  query: Partial<MessagesQuery>,
): Promise<ChatMessage[]> {
  const { data, error, response } = await api.GET("/conversations/{id}/messages", {
    params: { path: { id }, query },
  });
  if (!data) throw failed(response, error, "messages");
  return MessagePage.parse(data).messages;
}

/** Sends; a resend with the same client id answers the message stored the first time. */
export async function sendMessage(id: string, body: SendMessageRequest): Promise<ChatMessage> {
  const { data, error, response } = await api.POST("/conversations/{id}/messages", {
    params: { path: { id } },
    body,
  });
  if (!data) throw failed(response, error, "send");
  return ChatMessage.parse(data);
}

export async function markRead(id: string, upTo: number): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/read", {
    params: { path: { id } },
    body: { upTo },
  });
  if (!response.ok) throw failed(response, error, "read");
}
