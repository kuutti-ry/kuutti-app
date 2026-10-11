# Security checklist

OWASP Top 10 (2025) mapped to this codebase. A diff that touches identity, auth, uploads, signed URLs, research events, or infrastructure is checked against every line here before it opens as a pull request. The `security-reviewer` agent in `.claude/agents/` runs this list; humans use it the same way.

The four surfaces that matter most, in order: the OIDC exchange with Telia, the hetu HMAC, session token issuance and validation, signed URL issuance for media. Everything else is CRUD with rate limits.

## Broken access control

- [ ] Every query that touches user data is scoped by the session's `account_id` inside the query, never by a check after the fetch.
- [x] Admin routes check role (moderator / admin / researcher) server-side, and the admin allowlist is by `hetu_hmac`. (#49: `requireAdmin` in `apps/api/src/lib/admin-middleware.ts` re-reads `moderator_roles` on every request; the row is keyed by the identity the `hetu_hmac` resolves to.)
- [x] No endpoint returns another user's data beyond what a profile card shows; no bulk export endpoint exists. (#52: another account's photo is issued a URL only against a `card_shown` row the card route writes for the viewer, one photo at a time and counted against the day's budget in the same statement, `apps/api/src/media/repo.ts`; `/account/export` is one person's own data, #51. The card: `buildCard` in `apps/api/src/profile/card.ts` serves another account's card only when the subject is `active` and complete, writes the shown records and counts the card in `recordCardServed`, and no route takes a subject id in M3, ADR-009 §6.)
- [ ] Hard filters are enforced in the round builder query, in both directions.

## Security misconfiguration

- [x] CORS: product API routes refuse browser origins; only the admin SPA, the waitlist site, and a pull-request preview's own web origin are allowlisted. (#52: `corsAllowlist` answers only the configured origins and production refuses http ones, `apps/api/src/lib/config.ts`; `app.test.ts` asks every route with an unknown browser origin, direct and preflight, and finds no Access-Control-Allow-Origin.)
- [ ] No debug or introspection routes outside `NODE_ENV=development`.
- [ ] Deployed configuration comes only from SSM Parameter Store via the instance role; `.env` is local-only.
- [ ] CloudFront is the only public entry; nothing listens on plain HTTP. (ADR-005: the distribution fronts the API once `media_enabled` is set; the box still admits 443 from anywhere because Dokploy and the previews are served there directly, and 80 for the ACME challenge. `cloudfront_only_ingress` is the switch; the follow-up that lets it flip is in ADR-005.)

## Supply chain

- [ ] `pnpm-lock.yaml` committed and installs use the frozen lockfile.
- [ ] `pnpm audit` blocks on high and critical.
- [ ] A new dependency with a `postinstall` script is called out in the PR description.
- [ ] Every dependency's licence is in `scripts/license-policy.json` or a named exception there (`pnpm check:licenses`); dependency review is green on the pull request.
- [ ] Images deployed by hand are verified first, against the workflow and the ref and not only the repository: `gh attestation verify oci://ghcr.io/kuutti-ry/kuutti-api:<ref> --repo kuutti-ry/kuutti-app --signer-workflow kuutti-ry/kuutti-app/.github/workflows/build.yml --source-ref refs/heads/main` (`refs/tags/vX.Y.Z` for a release). An image built before the organisation was renamed on 2026-10-03 is refused by this command: `infra/README.md`, "Build provenance", says how it is verified.
- [ ] GitHub Actions are pinned to commit SHAs (repo settings enforce it) and run with `contents: read` unless a step needs more.

## Cryptographic failures

- [ ] HMAC-SHA256 with the permanent SSM key is used for the hetu and for nothing else.
- [ ] Session tokens are random 256-bit values, stored hashed, compared in constant time.
- [ ] The hetu HMAC key and the Telia signing key are never in the database, the repo, logs, or the Dokploy control plane.
- [ ] TLS terminates at CloudFront; internal hops stay inside the VPC. (ADR-005: viewer TLS at CloudFront after the cutover; the hop to the box is HTTPS over the public address to `origin.api.<env>`, not inside the VPC, until the ingress switch above flips.)

## Injection

- [ ] Drizzle query builder only. Any raw `sql` template carries a reviewer comment explaining why.
- [ ] All input passes through a zod schema from `packages/schema` at the route boundary, including query strings, headers used for logic, and WebSocket messages.
- [x] Uploaded images are re-encoded by sharp with `limitInputPixels`; the original bytes are never stored or served. (#48: `apps/api/src/media/pipeline.ts`; the pixel cap is applied to the file header before the decoder, the route tests read the stored bytes back.)
- [x] The translator (`pnpm i18n:translate`) sends only message text (and approved translations as examples), the glossary and the tone guide to the Claude API; its output is validated and stays machine text until a native review (#55).

## Insecure design

- [ ] The change cites the TD entry or ADR it follows, or proposes a new ADR in `docs/adr/`.
- [ ] It does not add a compatibility score, desirability signal, infinite feed, real-time engagement push, or purchasable visibility (see the Product constraints section of `CLAUDE.md`).
- [ ] It does not widen what is stored about identity: no hetu, no legal sex, no full date of birth, no name.

## Authentication failures

- [ ] OIDC callback verifies `state`, `nonce`, the ID token signature against the issuer JWKS, `iss`, `aud`, `exp`, and the `acr` expected for FTN.
- [ ] Telia broker keys are fetched from discovery and rotate on their schedule; nothing is pinned.
- [ ] The app never holds a client secret; the exchange is backend-driven and the app receives a one-time code by deep link.
- [x] Sessions expire; a device change re-authenticates through the bank; admin sessions are 8 hours with no refresh token. (#35 for the product sessions; #49: `admin_session`, `ADMIN_SESSION_TTL_MS`, no refresh route, tested.)
- [ ] Re-registration honours identity standing: banned and suspended are refused, cooldown is enforced, nothing is restored.

## Software and data integrity failures

- [x] EAS updates are not code-signed for now (ADR-004: Expo sells signing with its paid plans only), so the publish authority is `EXPO_TOKEN`, and any copy of it can publish to `production`: it exists only in the GitHub environments `staging`, `prod`, `preview` and `preview-cleanup` (the names of their secrets read through the API, 2026-09-28; none at repository or organisation level); `prod` keeps its required reviewer, `staging` admits only `main`, and `preview` loses its reviewer by the decision of 2026-10-08 (the maintainer from 2026-09-25, the day the `contributors` team got write, until the flip; ADR-004 §3): a pull request from anyone with write then deploys its preview without a click, so write access is the trust boundary of the update path, granted by name; no step that runs a pull request's bundler holds the token; no workflow edits a channel. Signing returns, or the reviewer goes back on, before a production build reaches people outside the team (ADR-004 §3 and §4, `docs/runbooks/custody.md`).
- [x] The `preview` environment has no required reviewer (ADR-004 §3, decided 2026-10-08): flipped on 2026-10-08 on the maintainer's instruction with the first command of `infra/README.md` Previews, Trust, and read back the same minute (`gh api repos/kuutti-ry/kuutti-app/environments/preview --jq .protection_rules`: `[]`). From 2026-09-25 until then the maintainer was the reviewer.
- [x] The environment `preview-cleanup`, which has no reviewer by design (ADR-012 §2), admits only `main` (ADR-012 §9): set by the maintainer on 2026-09-28 and read back the same hour (`gh api repos/kuutti-ry/kuutti-app/environments/preview-cleanup/deployment-branch-policies`: one policy, the branch `main`); a sweep from `main` passed the environment after it. From 2026-09-27 until then it had no policy, and a workflow on any branch that named it would have been handed `EXPO_TOKEN` and `DOKPLOY_TOKEN` without a review.
- [ ] `runtimeVersion` uses the fingerprint policy (compatibility between update and binary, not a protection).
- [ ] Migrations are generated by drizzle-kit, reviewed as SQL, and applied by the entrypoint under an advisory lock.
- [ ] Container images are built for arm64 in CI from a pinned base image, not on the box.

## Logging and monitoring failures

- [ ] Structured logs carry `account_id` and request id, never hetu, message text, email, or `seeks`.
- [x] Moderator actions, disclosure requests, and photo views by staff write to the immutable audit table. (#49: `audit_log`, append-only by the trigger of migration 0006, written before the view or the change; the table and the trigger function are owned by `kuutti_audit` after `infra/scripts/db-audit-owner.sh`, so the application role can neither rewrite rows nor disable the trigger, and the API warns at every boot until that has run; disclosure requests join in M4.)
- [ ] A test asserts that known PII patterns do not appear in log output.
- [x] Signed URL issuance is logged per account (photo id, variant, time). (#48: a `photo_access` row and a log line per issuance, `apps/api/src/media/photos.ts`.)

## Mishandling of exceptional conditions

- [ ] No empty `catch` blocks; errors are logged with context and rethrown or mapped.
- [ ] Error responses are generic; detail goes to logs and Sentry.
- [x] Rate-limited and moderation-gated endpoints fail closed. (#52: a request without a trusted client address shares one bucket instead of bypassing the limit, `apps/api/src/lib/rate-limit.ts`; the address comes from the trusted proxy's own hop or header, never one the client wrote (audit F19), and the request id is the server's (F26); the exposure budget is counted under an advisory lock per account and variant, so a parallel burst cannot overshoot it, `apps/api/src/media/repo.ts`, ADR-008.)
- [x] Image processing returns 503 with `Retry-After` above the concurrency limit instead of queueing unbounded work. (#48: `p-limit` at the vCPU count, checked before the work is queued.)
