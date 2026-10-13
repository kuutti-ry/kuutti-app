---
paths:
  - "apps/api/**"
---

# API (Hono on Node) rules

One process: HTTP routes, WebSockets via `@hono/node-ws`, and the nightly jobs (round builder at 04:00, events to Parquet, retention pruning) as cron inside the same container. Consult `https://hono.dev/llms.txt` for framework specifics.

## Routes

- Every route validates input with a schema from `packages/schema` at the boundary: body, query, params, and any header used for logic. Responses are typed from the same contracts.
- RPC style across the boundary is an open decision (lean: generated types via `@hono/zod-openapi`). Do not introduce `hc<typeof app>` or a hand-written client without an ADR.
- Machine callers (the Telia redirect, SNS bounce notifications) get plain HTTP endpoints with their own validation.
- Product routes refuse browser origins. There is no CORS except an allowlist for the admin SPA and the waitlist site.
- Rate limits are in-process and fail closed. No Redis.

## Identity and auth

- OIDC through `@kuutti/tunnistus-oidc` (ADR-017; `openid-client` and `jose` underneath) as Telia specifies it (docs/vendors/telia.md): a signed request object (RS256, our `sig` key, `acr_values` mandatory), `private_key_jwt` at the token endpoint, and an ID token that arrives encrypted to our `enc` key and signed by Telia: decrypt, then verify `state`, `nonce`, the signature via the issuer JWKS, `iss`, `aud`, `exp`, and the `acr` expected for FTN. Broker endpoints and keys come from discovery at boot and rotate on Telia's schedule; nothing is pinned.
- The hetu lives only inside the callback handler: parse (accept all century separators `+ - A-F Y X W V U`), check 18+, derive `birth_year` and `birth_month`, compute `HMAC-SHA256(hetu)` with the SSM key, then discard. Never log it and never pass it to a function that could retain it.
- Re-registration at the callback per TD-7: banned or suspended refuse and increment `refused_attempts`; inside `reregister_after` refuse with the date; otherwise a fresh account with nothing restored.
- Session tokens: random 256-bit, hashed at rest, constant-time compare. Device-bound refresh tokens. Admin sessions are 8 hours with no refresh.
- One identity row per `hetu_hmac`, at most one live account per identity. A ban is set on the identity.

## Data access

- Every user-data query is scoped by the session `account_id` in the query. The reviewer greps for it.
- Drizzle query builder only; a raw `sql` template needs a comment explaining why.
- Visibility is computed, never stored. Inactivity is a timestamp.

## Media

- Uploads: 10 MB cap, sharp with `limitInputPixels`, `p-limit` at vCPU count, 503 with `Retry-After` above the limit. Strip EXIF. Generate thumb 200x200, card 800x1067, full 1600 long edge, WebP, content-addressed keys. Never persist the original.
- Rekognition moderation on upload, never auto-delete. What the check is sure of it rejects itself and the owner is told why: a hard label at its group's reject line, no face, several faces; what it is unsure of goes to the human queue (ADR-006 §2, #206, #253). Keep the moderators' load to what the check is unsure of; the groups and their lines live in `media/label-groups.ts` and `matching_config`.
- Signed CloudFront URLs: 15-minute TTL, issued only inside rate-limited responses, every issuance logged (`account_id`, `photo_id`, variant, time). URL issuance counts against the exposure budget.
- The data export (`GET /account/export`, #237, ADR-007 §3) is one zip built in memory: the document and every photo's `full` file. At most `matching_config exports_per_day` per Finnish day, counted in the statement that records the export; each photo read is logged as a `full` fetch, counted, never refused.

## Events and logs

- `track(name, props)` server-side only, against the zod registry in `packages/schema`. Keyed by `research_id`; carries `consent_version`, pond, and the coarse snapshot. Never message text, never raw `seeks`, never email.
- Structured logs with `account_id` and request id; never hetu, message text, or email. Errors: generic response body, detail to logs and Sentry, no empty catch.

## Config and jobs

- Environment validated with zod at boot; a missing key fails the start. Deployed config comes from SSM through the instance role; the local `.env` is read by the runtime only, never by tooling or agents.
- Migrations run in the entrypoint under an advisory lock before the server listens.
- WebSockets: application-level ping/pong (CloudFront documents no idle timeout). Fan-out across instances, if ever, via Postgres LISTEN/NOTIFY.

## Tests

- `app.request()` per route: happy path, validation failure, unauthenticated, wrong-user. Real Postgres, transaction rolled back per test.
- fast-check property tests for hetu parsing and HMAC derivation. Coverage floor for the API in `vitest.config.ts`, identity's the strictest (ADR-021).
- A test asserts that no PII pattern appears in log output.
