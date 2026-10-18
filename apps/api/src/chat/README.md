# chat

Conversations, presence, contact release, auto-archive. TD-3.

- `conversations.ts`, `messages.ts`, `repo.ts`: the list, one conversation, text messages, the read mark, erasure's and the export's halves (#348, ADR-031 §1 to §8).
- `photos.ts`: a photo in a message (#350, ADR-031 §10): one request uploads and sends through the media slice's pipeline and check, the photo and its message one transaction, the day's photos counted under the sender's lock and the day's tries in the process's memory, both to midnight in Finland. The photo's URLs ride on a page, the read of one message and the send's answer to its sender (`withPhotoUrls` in `messages.ts`), never on a socket frame.
- `ws.ts`, `live.ts`, `listen.ts`, `presence.ts`: the live socket (#349, ADR-031 §9).
- `archive.ts`: the night's archive of silent conversations (TD-13).
