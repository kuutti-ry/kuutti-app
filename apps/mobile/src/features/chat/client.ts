import {
  ChatMessage,
  ConversationDetail,
  ConversationList,
  ErrorResponse,
  MessagePage,
  type MessagesQuery,
  type SendMessageRequest,
} from "@kuutti/schema";
import { type PickedPhoto, uploadPicture, uploadRefusal } from "@/features/media";
import { ApiError, api } from "@/lib/api";
import { messageWithKnownDescription } from "./known";

// The chat's routes as the app calls them (#348, ADR-031), through the typed
// client; the zod contracts guard the runtime (ADR-003). A photo goes through
// the media slice's upload, the one transport that reports progress (#350).

function failed(response: Response, error: unknown, what: string): ApiError {
  const parsed = ErrorResponse.safeParse(error);
  return new ApiError(
    `${what} answered ${response.status}`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

const readMessage = (data: unknown): ChatMessage =>
  ChatMessage.parse(messageWithKnownDescription(data));

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
  const { messages } = data as { messages?: unknown };
  return MessagePage.parse(
    Array.isArray(messages)
      ? { ...data, messages: messages.map(messageWithKnownDescription) }
      : data,
  ).messages;
}

/** Sends; a resend with the same client id answers the message stored the first time. */
export async function sendMessage(id: string, body: SendMessageRequest): Promise<ChatMessage> {
  const { data, error, response } = await api.POST("/conversations/{id}/messages", {
    params: { path: { id } },
    body,
  });
  if (!data) throw failed(response, error, "send");
  return readMessage(data);
}

/**
 * Sends a photo (#350): one request that uploads and sends, the picture as
 * prepared on the phone, the phone's id for the message (a resend with it
 * answers the message stored the first time), and the words in the field as
 * its caption, none when blank. The answer carries the photo signed for the
 * sender.
 */
export async function sendPhoto(
  id: string,
  { photo, clientId, caption }: { photo: PickedPhoto; clientId: string; caption: string },
  onProgress?: (fraction: number) => void,
): Promise<ChatMessage> {
  const words = caption.trim();
  const answer = await uploadPicture(
    `/conversations/${encodeURIComponent(id)}/photos`,
    photo,
    words ? { clientId, caption: words } : { clientId },
    onProgress,
  );
  if (answer.status === 200 || answer.status === 201) return readMessage(answer.body);
  throw uploadRefusal(answer);
}

export async function markRead(id: string, upTo: number): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/read", {
    params: { path: { id } },
    body: { upTo },
  });
  if (!response.ok) throw failed(response, error, "read");
}
