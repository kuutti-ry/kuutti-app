# media

Photo upload, variants, signed URL issuance (#48, TD-2, TD-8, ADR-005); moderation and the review queue (#49, ADR-006). The exposure budget arrives with #52.

- `pipeline.ts`: `inspectImage` reads format and size from the file header (the pixel cap applies before any decoder); `processPhoto` re-encodes with sharp into the three WebP variants, computes the content address and the blurhash. Nothing of the input survives it.
- `store.ts`: the object store behind `MediaStore` (S3 or the compose stand-in through `lib/s3.ts`; a Map in tests). Only variants reach `put`.
- `urls.ts`: `UrlSigner`, CloudFront canned-policy URLs in deployed environments, presigned GETs on the compose stand-in in development.
- `repo.ts`: the rows, every statement scoped by `account_id` (rule 6). `photos.ts`: the service. `routes.ts`: the five routes. `wiring.ts`: what boot builds from the configuration.
- Tests: `pipeline.test.ts` on fixtures made at test time (`src/test/media.ts`), `urls.test.ts` verifies signatures with the public half, `routes.test.ts` runs every route through `app.request()` with a memory store, `store.local.test.ts` runs against the compose stand-in when `S3_ENDPOINT` is set (the compose job).
- `moderation.ts`: the `Moderator` seam (Rekognition through the instance role: three detect calls, or queue-everything where there is none), the pure decision over `matching_config` thresholds (moderation labels only), tip signals stored beside them for #56, `moderatePhoto` after the upload and `sweepPendingPhotos` nightly. Counts in the log line, never label names.
- `admin-routes.ts`: the queue, the card URL and the decision for staff, behind `requireAdmin` with an audit row per view and decision (`safety/audit.ts`).
- Tests: `moderation.test.ts` (the decision as a Scenario Outline, the upload path with a scripted moderator), `admin-routes.test.ts`; specs in `features/media/moderation.feature`.
