# chat

Conversations, presence, contact release, auto-archive. TD-3.

- A photo in a message (#350): the composer's Add photo runs the media slice's chain before an upload (`pickPrepared`) and sends through its upload (`uploadPicture`) to `POST /conversations/{id}/photos`, with the field's words as the caption. `PhotoBubble.tsx` shows the thumb by `photoId/thumb`, the blurhash first, or "Photo removed"; a socket frame carries no URLs (rules/api.md), so the screen reads that one message again over HTTP, as it does for an expired URL, and `merged` never lets a socket's copy take a page's URLs. `ChatPhotoScreen.tsx` (`/chats/photo/<messageId>`) reads the message again for its `full`.
- `known.ts` drops a description key this build cannot say from a page, an answer or a frame (#296), so a newer API's label never fails a page.
