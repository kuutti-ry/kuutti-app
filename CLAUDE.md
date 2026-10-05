# Kuutti

Free, non-commercial, open-source dating app for Finland, run by a registered association. Every account is verified through Finnish bank ID via the Telia broker. Licence: AGPL-3.0 with App Store exception (`LICENSE`, `LICENSE-EXCEPTION`). This file carries the standing rules. The reasoning behind them, the technical decisions log (TD-1 to TD-19) and the design evidence base, lives in the maintainers' private planning documents; ask the maintainer when a rule here needs its reasoning. Where anything here conflicts with the decisions log, the log wins.

Before touching matching, rounds, likes, notifications, rewards, profile presentation, or research events, read the Product constraints section below and confirm parameters with the maintainer. Read `docs/security-checklist.md` before touching identity, auth, uploads, signed URLs, events, or infrastructure.

## Layout (pnpm monorepo, `node-linker=hoisted`)

| path | what | rules |
|---|---|---|
| `apps/mobile` | Expo SDK 57, RN 0.86, React 19, TypeScript, dev client, web preview target | `.claude/rules/mobile.md` |
| `apps/api` | Hono on Node, WebSockets via `@hono/node-ws`, nightly jobs | `.claude/rules/api.md` |
| `apps/admin` | Vite + React moderation panel, static behind CloudFront | `.claude/rules/admin.md` |
| `packages/schema` | zod contracts shared by all apps; research event registry | `.claude/rules/schema.md` |
| `packages/db` | Drizzle schema, generated migrations, seed | `.claude/rules/db.md` |
| `packages/i18n` | `messages.yaml`, typed `t()`, i18next + ICU | `.claude/rules/i18n.md` |
| `services/mock-idp` | navikt/mock-oauth2-server with FTN-shaped claims for local dev; its login page names the twelve demo personas (ADR-014) | `.claude/rules/infra.md` |
| `docs/` | security checklist, `adr/` | |
| `features/` | Gherkin specs for the rules layer, one directory per slice | `.claude/rules/layout.md` |

Inside each app, code is organised by vertical slice (identity, profile, media, pond, matching, chat, safety, research, rewards, notifications), never by layer; see `.claude/rules/layout.md`. Rules in `.claude/rules/` load automatically when you work on matching paths. The scaffold is Milestone 1; until it lands, treat this layout as the target, not a description.

## Commands

Root `package.json` is the source of truth; keep this list in sync with it.

- `pnpm install --frozen-lockfile`. Node 22.18+ and pnpm come from `package.json` (`engines`, `packageManager`); run `corepack enable` once.
- `pnpm env:up` starts the whole local environment: the database (docker compose once #5 lands, Homebrew PostgreSQL until then), migrate and seed, then the API on 3000, Metro on 8081 (app and web target), admin on 5173, with prefixed logs. It frees ports held by stale copies of our own processes and refuses to touch anything else. Ctrl+C stops the apps; `pnpm env:down` also stops the database; `pnpm env:status` shows who holds what.
- One at a time: `pnpm dev` runs the API with tsx watch on port 3000. `pnpm dev:mobile` starts the Expo dev client; never Expo Go. `pnpm dev:admin` starts Vite.
- `pnpm typecheck`, `pnpm lint` (Biome, including the slice import boundary, then the inline-string check), `pnpm format`, `pnpm test` (Vitest for api and packages, jest-expo for mobile).
- `pnpm check:scenarios` verifies every Gherkin scenario has a same-named test. `pnpm check:licenses` holds every installed dependency to the licences of `scripts/license-policy.json`, or to a named exception with its reason; a pull request's new dependencies are also checked by the dependency review workflow.
- `pnpm openapi` regenerates `apps/api/openapi.json` and the typed client paths in `packages/schema` from the route contracts (ADR-003); CI fails on drift.
- API tests need Postgres: `DATABASE_URL`, or the local default `postgres://kuutti:kuutti@127.0.0.1:5432/kuutti_test`.
- `pnpm --filter @kuutti/db generate --name <what>` after a schema change; commit the SQL and `drizzle/meta`, never edit them. `pnpm --filter @kuutti/db migrate` and `seed -- --env development`; seed refuses production. `pnpm check:schema-words` rejects columns for hetu, sex, or date of birth.
- User-facing text: edit `packages/i18n/messages.yaml`, then `pnpm i18n:build` and commit `packages/i18n/src/generated` with it; CI fails on drift. `pnpm i18n:check` runs the rules of `.claude/rules/i18n.md` (`--release` also refuses machine text in a released language and draft legal text). `pnpm i18n:translate` fills missing Finnish and Swedish by machine, flagged for a native review (`--dry-run` lists the requests, `--compare` sends them without writing, `--mode batch` uses the Batches API; it needs an Anthropic API key, which the agent does not spend without being asked). `pnpm i18n:review` shows the review's progress, lists what waits (`--list`), exports and imports the reviewer's sheet (`--export tsv`, `--import`), approves (`--approve`), and flags a changed text for review again (`--reflag`); the agent never runs `--approve` or `--import` (`docs/i18n/translation-review-guide.md`). `pnpm lint` also fails on an inline user-facing string in the clients' TSX.
- `pnpm aws:login` (`infra/scripts/aws-login`) configures the Identity Center profile once and signs in when the session has expired; every `aws` and `tofu` command then works without `AWS_PROFILE`. The agent never runs it: signing in is the maintainer's.
- `pnpm env:doctor` checks Node, pnpm, Docker, `.env` and ports and prints the fix for each failure (`pnpm doctor` is pnpm's own). `docker compose up -d --wait` alone starts Postgres, the S3 stand-in (versitygw, http://127.0.0.1:9000) and the mock bank IdP (http://127.0.0.1:8080/ftn); `env:up` does that for you. `node services/mock-idp/verify.ts` runs a bank login against the mock, as every persona and as somebody else. `pnpm demo:bank` writes the mock bank's login page from the personas of `packages/db/src/seed/personas.ts` (`--check` fails on a stale page); commit `services/mock-idp/login.html` with a change of the personas. `pnpm demo:reset` returns the twelve personas to where they begin (everybody forgotten through the erasure path, then the six histories through the API's own routes; `-- --bare` for no histories; the local environment must be running). `pnpm demo:population` writes the synthetic population into the local database, replacing the previous one (`-- --size 5000`, `-- --seed 7`, `-- --dry-run`, `-- --remove`; `docs/demo/population.md`); it goes ahead only in `development`, `test` or `preview` and refuses a managed database server whatever the environment is called; the demo tools are imported from `@kuutti/db/demo` by command lines and tests only, never by an app's own code (the linter refuses it).

Before pushing: typecheck, lint, and tests pass locally. Do not push red.

## Git

- `main` only, and only through a pull request (TD-2, switched on 2026-09-25 when the `contributors` team got write): squash merge, the fourteen checks that run on every pull request green, one approving review for anyone who is not a repository admin (admins bypass), one more for changes attributed to no person. A contributor's preview deploys only after the maintainer has approved the run (ADR-004).
- Every commit is signed off (`git commit -s`). Enable the hooks once per clone: `git config core.hooksPath .githooks` (the sign-off check, and Biome on the staged files before a commit). The DCO workflow fails on unsigned commits.
- Linear history: no merge commits, no force-push, never touch the branch ruleset or repository settings.
- Subject line imperative and under 72 characters; the body says what and why. Cite the TD or ADR when a change follows one.
- Every pull request body carries `Refs #n` for each issue it works on, so GitHub links the issue and the pull request both ways. Never a closing keyword (`Closes`, `Fixes`, `Resolves`): an issue closes when the maintainer has tested it, not when a merge happens. The `issue-link` CI job refuses both a missing reference and a closing keyword.
- Commit only what was asked. No generated artefacts, no unrelated lockfile churn, no `.env*`.

## Session handoff

Context is cheaper re-read than carried. `/clear` between tasks, `/compact` within one.

- `.claude/session-handoff.md` (gitignored) is the bridge: goal, state, files touched, decisions, next steps, verification. A SessionStart hook injects it after `/clear`, `/compact`, and on startup; read it before acting. A PreCompact hook feeds it to the summary.
- Before the user clears, when an issue closes, or before a long pause: run `/handoff` (or write the file in that shape yourself). Under 60 lines, facts only, nothing secret.
- Within a task, prefer `/compact focus on <the current issue and its verification>` over letting the window fill.

## Non-negotiable rules

From TD-1, TD-6, TD-7. A change that violates one is wrong regardless of who asked.

1. The personal identity code (hetu) is never persisted. It exists in memory during the OIDC callback, yields age and `HMAC-SHA256(hetu)`, and is discarded.
2. The HMAC key is never rotated and never leaves SSM Parameter Store (fetched at boot via the instance role, one offline backup).
3. Legal sex from the hetu is never stored. Gender is self-declared. Age is `birth_year` + `birth_month` only.
4. Uploads go through the API: validate, strip EXIF, re-encode with sharp, generate variants, discard the original. No direct-to-S3 path.
5. Research events never contain message text and are keyed by `research_id`, never `account_id`.
6. Every user-data query is scoped by the session's `account_id` in the query itself.
7. Hard filters are never violated, in either direction, for any reason.
8. No web surface for the product: no profile pages, share links, browser client, or CORS.
9. `.env` files are never read, written, logged, or committed. `.claude/settings.json` denies them at tool level; do not work around it with shell commands. The committed template is `env.example` with placeholders only.
10. Migrations are generated by drizzle-kit (`generate`, or `generate --custom` for what the schema DSL cannot express, with the SQL cited in an ADR), never edited afterwards, and applied by the entrypoint under an advisory lock.

## Security and privacy defaults

- Secrets: SSM in deployed environments, a local `.env` for dev. Never print, echo, or commit a secret; never paste user data or secrets into any external service or LLM.
- Logs: structured, carrying `account_id` and request id, never hetu, message text, email, or `seeks`.
- New dependency: check it is maintained, pin it, and note any `postinstall` script in the PR. `pnpm audit` on high blocks CI. Its licence must be in the allow-list of `scripts/license-policy.json`: a copyleft library without a store permission conflicts with `LICENSE-EXCEPTION`, so anything else needs an exception there with the reason, and that is the maintainer's call.
- GitHub Actions: pin to commit SHAs (enforced by repo settings), `permissions: contents: read` unless a step needs more, cloud access by OIDC only.
- When a change touches the four security surfaces (Telia OIDC exchange, hetu HMAC, session tokens, signed URL issuance) run the `security-reviewer` agent on the diff before committing.

## Code

- TypeScript strict everywhere. No `any` in exported signatures; `unknown` plus a zod parse at the boundary.
- Biome is the formatter and linter; its config is the style guide. Run `pnpm lint` rather than arguing with it.
- Validate at boundaries with schemas from `packages/schema`; trust types inside.
- Small modules, named exports, no barrel files that re-export whole packages (Metro and tree-shaking both suffer).
- Vertical slices, not layers. A slice imports only from `packages/schema`, `packages/db`, its app's `src/lib/`, and a neighbouring slice's `index.ts`. Never reach into another slice's internals; two slices that keep needing each other mean the boundary is wrong. Details in `.claude/rules/layout.md`.
- Comments explain why, not what. Reference the TD or ADR number when the why is a decision.
- English for code, comments, commits, and docs. User-facing strings go through i18n keys, never inline.
- Do not add infrastructure, caching layers, queues, or abstractions for scale that is not coming (5,000 users, one box).
- Understand first, then write the least. Read what the change touches and trace the flow end to end; then stop at the first of these that holds: it does not need to exist (say so in one line); it is already in this codebase (reuse it, through the slice's `index.ts` or `src/lib/`); the standard library or the platform does it (a database constraint over application code); a dependency that is already installed does it; otherwise the least code that works. The testing, accessibility, i18n and security rules of this file are part of "works".
- No structure on speculation: no interface with one implementation, no factory for one product, nothing scaffolded for later. Deleting beats adding, boring beats clever. A tunable in `matching_config` is a product rule, not speculation.
- A bug fix goes to the root cause. Look at every caller of the function you are about to change, and fix it once, where they all pass through.
- A deliberate shortcut with a known ceiling carries a comment that starts `shortcut:` and names the ceiling and what would lift it (`// shortcut: one global lock; per-account locks if throughput matters`). `git grep -E '(//|#) shortcut:'` lists what was put off.
- A pull request names what was left out on purpose and what would make it needed.
- Prefer the vendor's agent docs over training data for API details: Expo through the official Claude Code plugin and MCP (`claude plugin install expo@claude-plugins-official`), then `https://hono.dev/llms.txt`, `https://orm.drizzle.team/llms.txt`, `https://zod.dev/llms.txt`, `https://www.nativewind.dev/llms.txt`, `https://docs.dokploy.com/llms.txt`, `https://docs.sentry.io/llms.txt`, `https://www.i18next.com/llms.txt`.

## Testing

- Vitest for `apps/api` and `packages/*`; jest-expo for React Native components. Do not mix them.
- Every route: `app.request()` tests for happy path, validation failure, unauthenticated, and wrong-user. Real Postgres, transaction rolled back per test, never a mocked database.
- Every exported function in `packages/core` and `apps/api/src/identity` has tests. hetu parsing and HMAC derivation get property-based tests with fast-check.
- Coverage thresholds apply only to those two paths. No global coverage number.
- A test fails on PII patterns in log output.
- Tests are deterministic: no real network, no wall-clock dependence, no random data without a seed.
- Rules-layer behaviour (identity, matching, pond, safety, erasure) is specified in `features/<slice>/*.feature`. A `Scenario` is an `it()` with the scenario name verbatim; a `Scenario Outline` is a `describe()` with the outline name around `it.each` over the Examples rows. `pnpm check:scenarios` fails CI on any scenario without a same-named test; `@pending` marks a spec that lands before its code. If a `Given` needs more than three lines of setup, it is not a Gherkin scenario: write an ordinary test. ADR-002.

## Accessibility (mobile and admin)

- Meaning never by colour alone. Pass and like differ in shape, label, and position; no red/green pair.
- WCAG AA contrast on the token set in both themes; high contrast is a second token set, not a separate mode.
- Every touchable has `accessibilityLabel` and `accessibilityRole`; targets are at least 44 pt.
- OS font scaling and reduce-motion are respected; no fixed-height text containers.
- Decisions are buttons, not swipes. A swipe may exist as an accessibility alternative, never as the primary input.

## Product constraints

The evidence base behind these is in the maintainers' private design document. Never build: compatibility or chemistry scores, desirability signals, infinite feeds, real-time engagement push, streaks, leaderboards, boosts or anything purchasable, ads or ad SDKs, pre-match links to external profiles, under-18 access. If asked, refuse and cite this section. Every tunable lives in `matching_config`, not in code.

## Decisions

Anything that changes identity, upload, event flow, data retention, or infrastructure needs an ADR in `docs/adr/`, or a citation of the TD it follows, in the same change. Open questions you must not settle on your own: RPC style across the client-server boundary (lean: generated types via `@hono/zod-openapi`), Dokploy versus Kamal, which TD-6 anti-scraping items ship. Ask.
