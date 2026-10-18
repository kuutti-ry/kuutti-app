import {
  ChatMessage,
  type ContactKind,
  ConversationContacts,
  ConversationDetail,
  ConversationList,
  ErrorResponse,
  MessagePage,
  type MessagesQuery,
  type SendMessageRequest,
  StoredContact,
  StoredContacts,
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

/** Ends the conversation for both, blocking nobody (#351); one ended before answers alike. */
export async function unmatchConversation(id: string): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/unmatch", {
    params: { path: { id } },
  });
  if (!response.ok) throw failed(response, error, "unmatch");
}

export async function markRead(id: string, upTo: number): Promise<void> {
  const { error, response } = await api.POST("/conversations/{id}/read", {
    params: { path: { id } },
    body: { upTo },
  });
  if (!response.ok) throw failed(response, error, "read");
}

// The contacts a person keeps and shares (#103, ADR-031 §11). A value goes in
// a body only, never in a path, so nothing logs it on the way.

/** The person's stored pieces, in the API's order (CONTACT_KINDS). */
export async function fetchContacts(): Promise<StoredContact[]> {
  const { data, error, response } = await api.GET("/contacts");
  if (!data) throw failed(response, error, "contacts");
  return StoredContacts.parse(data).contacts;
}

/** Keeps a piece; the answer is its one stored form (a number in E.164, a username without its @). */
export async function saveContact(kind: ContactKind, value: string): Promise<StoredContact> {
  const { data, error, response } = await api.PUT("/contacts/{kind}", {
    params: { path: { kind } },
    body: { value },
  });
  if (!data) throw failed(response, error, "contact save");
  return StoredContact.parse(data);
}

/** Removes a piece, and with it every share of it; alike when none was kept. */
export async function removeContact(kind: ContactKind): Promise<void> {
  const { error, response } = await api.DELETE("/contacts/{kind}", {
    params: { path: { kind } },
  });
  if (!response.ok) throw failed(response, error, "contact removal");
}

/**
 * What is shared in one conversation, the detail's contacts alone: what the
 * screen reads on a contacts frame and on a resume, which signs no thumb and
 * writes nothing.
 */
export async function fetchSharedContacts(id: string): Promise<ConversationContacts> {
  const { data, error, response } = await api.GET("/conversations/{id}/contacts", {
    params: { path: { id } },
  });
  if (!data) throw failed(response, error, "conversation contacts");
  return ConversationContacts.parse(data);
}

/** Shares a stored piece in the conversation; the answer is the person's fresh view of it. */
export async function shareContact(id: string, kind: ContactKind): Promise<ConversationDetail> {
  const { data, error, response } = await api.POST("/conversations/{id}/contacts/{kind}", {
    params: { path: { id, kind } },
  });
  if (!data) throw failed(response, error, "contact share");
  return ConversationDetail.parse(data);
}

/** Stops sharing a piece there; the answer is the person's fresh view of the conversation. */
export async function stopSharing(id: string, kind: ContactKind): Promise<ConversationDetail> {
  const { data, error, response } = await api.DELETE("/conversations/{id}/contacts/{kind}", {
    params: { path: { id, kind } },
  });
  if (!data) throw failed(response, error, "contact unshare");
  return ConversationDetail.parse(data);
}
