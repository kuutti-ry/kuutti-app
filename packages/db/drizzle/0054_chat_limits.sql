-- Custom SQL migration file, put your code below! --
-- matching_config version 1 rows for the chat of #348 (ADR-031 §6,
-- apps/api/src/chat/messages.ts): the longest message a person may send, in
-- characters after trimming, and the messages one account may send in a
-- minute, which the send's limiter reads on each request. #101's table
-- states both: 2000 and 30. The seed carries the same rows
-- (packages/db/src/seed.ts; migrate.test.ts keeps the two identical). A new
-- number is a new version, written by an admin in the panel (#305), never an
-- edit of this file.
INSERT INTO "matching_config" ("version", "key", "value", "created_by") VALUES
  (1, 'message_max_length', '2000'::jsonb, 'migration:0054'),
  (1, 'messages_per_minute', '30'::jsonb, 'migration:0054')
ON CONFLICT ("key", "version") DO NOTHING;
