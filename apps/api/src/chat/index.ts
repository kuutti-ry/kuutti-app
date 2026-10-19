// The chat slice's public surface in apps/api (#348, ADR-031). Other slices import from here only.

// The night's archive of silent conversations (TD-13).
export { archiveJob } from "./archive.ts";
// The person's stored contacts for their export (#103, ADR-031 §11).
export { exportContacts } from "./contacts.ts";
// The ban's close, and the halves erasure and the export call (ADR-007 §4);
// a block's close, and what a report from a conversation reads, and its copy
// (#351, ADR-030 §12).
export {
  closeConversationsBetween,
  closeConversationsOf,
  copyConversation,
  eraseConversationsOf,
  exportConversations,
  lockReportedConversation,
  REPORT_AFTER_CLOSE_DAYS_KEY,
  reportWindowHolds,
} from "./conversations.ts";
// The measure for the automatic rules on first messages (#105, ADR-033):
// counts and times, never a word.
export { firstMessageCounts } from "./first-messages.ts";
export { startChatListener } from "./listen.ts";
// The live half (#349): the registry and hub, the listener, the socket's route.
export { createLive, type Live } from "./live.ts";
// A photo in a message (#350): its path, which app.ts lets past the app-wide
// body cap, and the send, which the demo's stories call as the route does.
export { PHOTO_MESSAGE_PATH, sendPhoto } from "./photos.ts";
export { chatRoutes } from "./routes.ts";
export { chatSocketRoutes, createSocketServer } from "./ws.ts";
