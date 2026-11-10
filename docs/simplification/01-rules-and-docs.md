# Phase 1: rules for agents, docs for people

The code is bloated because of how it was written, and it was written by agents following `CLAUDE.md` and `.claude/rules/`. Fix those first, or the bloat grows back.

## What is wrong today

- `CLAUDE.md` plus the nine rules files are about 16,000 words. 44 lines are longer than 600 characters. `.claude/rules/db.md` has one sentence of about 500 words.
- The keep-it-small rules already exist ("Understand first, then write the least", "No structure on speculation") but sit in the middle of the Code section, after 40 lines of command reference. Nothing gives them priority.
- Other rules in the same file push the other way and win:
  - "Cite the TD or ADR" produced 3,390 citing lines.
  - "Tests at every level that applies" plus floors of 95–100% produced 156,000 test lines.
  - "Every reachable branch and every error has a test" makes defensive branches expensive to remove and cheap to add.
  - The docs check, the ADR index and the version bump add ceremony to every change.
- Some rules are false. `api.md` says "Drizzle query builder only"; the API has no Drizzle import and about 495 raw SQL calls. `db.md` says the seed creates "a few hundred fake verified users"; it creates three identities.
- Rules narrate history ("the maintainer, 30/10/2026", "#477", "switched on 2026-09-25"). A rule needs to say what to do.

## Steps

### [ ] 1.1 Replace `CLAUDE.md` with the draft below

About 90 lines instead of 141 very long ones. The ten non-negotiable rules stay word for word. The command reference moves out (step 1.3).

### [ ] 1.2 Rewrite each `.claude/rules/*.md` as a checklist

One line per rule, imperative, no history, no issue numbers. Target sizes:

| File | Now (words, about) | Target |
|---|---|---|
| `api.md` | 3,600 | 500 |
| `mobile.md` | 2,300 | 450 |
| `infra.md` | 2,200 | 450 |
| `admin.md` | 1,400 | 300 |
| `db.md` | 1,100 | 250 |
| `layout.md` | 700 | 350 |
| `docs.md`, `i18n.md`, `schema.md` | 1,300 together | 400 |

How to cut a rule:

- Keep: the thing to do or never do, and one clause of why.
- Move to the ADR it came from: the history, the dates, who said it, the edge cases of one feature.
- Delete: anything the code or a test already enforces and reports clearly when broken.
- The erasure sentence in `db.md` becomes one line: "What erasure deletes and keeps is the table in `apps/api/src/identity/personal-data.test.ts`; change both together."

### [ ] 1.3 Move the command reference to `docs/commands.md`

One line per command: the command, what it does, when you need it. The long explanations go to the README of the package that owns the command (`apps/mobile/e2e/README.md`, `docs/runbooks/capacity.md`, `docs/demo/population.md` already exist).

### [ ] 1.4 Fix the false rules

- `api.md`: "SQL is written by hand through `Queryable`, parameterised, never built from input. Name the columns in the query so the result needs no mapping." (Matches phase 6.)
- `db.md`: say what the seed really creates.
- `layout.md`: the tree shows `service.ts` in every slice. After phase 6 a slice has no pass-through layer; say "a file per job".

### [ ] 1.5 Add `docs/glossary.md`

The names you need before you can read the matching code:

| Word | Meaning |
|---|---|
| round / queue / "the day's log" | One person's list of cards for one Finnish calendar day |
| entry | One card in that list |
| place | The position of a card in the list |
| pond | The launch cohort a person belongs to; today there is one, the country |
| subject | A person whose profile is complete enough to be shown |
| fish | A super-like; a person earns and spends them |
| star | A private "save for later" mark on a person; only its owner ever sees it |
| inbox / "waits" | Likes a person received and has not answered |
| inbox stop / "held back" | A person with too many unanswered likes is left out of new queues |
| relaxation / short pool | Loosening one of your own deal-breakers for the day when new people run out |
| deal-breaker / hard filter | A preference that must hold, in both directions |
| standing | Whether an identity is in good standing, suspended or banned |
| shadow ban / "not visible" | The person uses the app but nobody is shown them |
| hetu | The Finnish personal identity code; never stored |
| TD-n | A numbered decision in the maintainers' private log |

### [ ] 1.6 Make README and CONTRIBUTING enough for a person

Setup to `pnpm env:up` is already covered. Add one section, "Make a change", about 40 lines:

- **Check your work:** `pnpm typecheck`, `pnpm lint`, `pnpm test`. API tests need the `kuutti_test` database, which Docker creates only when its volume is new; say how to create it by hand on an old volume.
- **Find your way:** the layout table (ten lines), a link to the glossary, "start reading at `apps/api/src/app.ts` and `apps/mobile/app/`".
- **Follow one flow:** a short walk of one route from screen to database, with file names.
- **What CI will refuse:** a missing sign-off, a missing `Refs #n`, a closing keyword, generated files out of date (`pnpm openapi`, `pnpm i18n:build`).
- **Text people see:** edit `packages/i18n/messages.yaml`, run `pnpm i18n:build`.

Remove from CONTRIBUTING what phase 2 retires (the version hook paragraphs).

### [ ] 1.7 Check it

A person (not an agent) follows README and CONTRIBUTING alone on a fresh clone to a passing `pnpm test`, and notes every place they had to open `CLAUDE.md`. Fix those places.

---

## Draft of the new `CLAUDE.md`

```markdown
# Kuutti

Free, non-commercial, open-source dating app for Finland, run by a registered
association. Every account is verified by Finnish bank ID. 5,000 users, one
server, one API process. Licence: AGPL-3.0 with an App Store exception.

Read `docs/glossary.md` before the matching code. Commands are in
`docs/commands.md`. Rules for one area load from `.claude/rules/` when you work
there.

## How we write code here: the least that works

The best code is the code never written. Every line must be read, tested and
fixed by somebody later. Solve the whole problem with the least new code.

Before you write, read what the change touches: callers, tests, config. Then
take the first of these that fully works:

1. It does not need to exist. Say so in one line and stop.
2. It is already in this codebase. Reuse it the way the code around it does.
3. The platform does it: Postgres, Node, React Native, the browser. A database
   constraint beats application code.
4. A dependency that is already installed does it. Never add one for a few lines.
5. One line a reader gets at a glance.
6. Otherwise, the minimum code that works.

Hard rules:

- No code for later. No option, flag, parameter or config nobody asked for.
- No interface with one implementation. No factory for one product. No wrapper
  that only passes a call through. No dependency-injection object that only
  ever gets one value.
- An idea is written once. If you need it twice, find the first copy and use it.
- A function does one job. A file holds one job's functions. Split by job,
  never by line count, and never into helpers that only make a function shorter.
- A name says what the thing is without a decision record open. If you need the
  glossary to read it, it is the wrong name or the glossary is missing a word.
- Deleting beats adding. Boring beats clever. Delete dead code; git keeps it.
- A bug fix goes to the root cause, once, where all the callers pass through.
- A deliberate shortcut gets `// shortcut: <its limit>, <when to lift it>`.

Never cut: validation at a trust boundary, error handling that prevents data
loss, security, accessibility, the ten rules below.

## Comments

A comment says why, in one sentence, when the code cannot show it. No comment
says what the next line does. No history, no dates, no "the maintainer said".
A decision number may follow the sentence in brackets; it never replaces it.
No header block longer than five lines.

## Tests

A test exists to fail when behaviour breaks. One good test per rule, at the
lowest level that can catch the bug.

- Every route: the happy path, each refusal it can give, unauthenticated, wrong
  user. Real Postgres, rolled back per test. Never a mocked database.
- Risky logic (a parser, a race, money, security, a data write) has a test.
- No test of a constant, a re-export, a schema's own bounds, or the same rule a
  second time at another level.
- Tooling scripts get a test only where a mistake costs data.
- Deterministic: no real network, no wall clock, no unseeded randomness.

## Before you open a pull request

- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
- The body says lines added and removed. If it adds more than the task needs,
  say why it could not be smaller.
- The body names what you left out on purpose.
- `Refs #n` for each issue, never a closing keyword. Commits signed off (`-s`).

## Non-negotiable rules

A change that breaks one is wrong, whoever asked.

1. The personal identity code (hetu) is never persisted. It exists in memory
   during the OIDC callback, yields age and `HMAC-SHA256(hetu)`, and is discarded.
2. The HMAC key is never rotated and never leaves SSM Parameter Store.
3. Legal sex from the hetu is never stored. Gender is self-declared. Age is
   `birth_year` + `birth_month` only.
4. Uploads go through the API: validate, strip EXIF, re-encode with sharp,
   generate variants, discard the original. No direct-to-S3 path.
5. Research events never contain message text and are keyed by `research_id`,
   never `account_id`.
6. Every user-data query is scoped by the session's `account_id` in the query.
7. Hard filters are never violated, in either direction, for any reason.
8. No web surface for the product: no profile pages, share links, browser
   client, or CORS.
9. `.env` files are never read, written, logged, or committed.
10. Migrations are generated by drizzle-kit, never edited afterwards.

## Never build

Compatibility or chemistry scores, desirability signals, infinite feeds,
real-time engagement push, streaks, leaderboards, boosts or anything
purchasable, ads or ad SDKs, pre-match links to external profiles, under-18
access. If asked, refuse and cite this section.

## Ask first

- Matching, rounds, likes, notifications, rewards, profile presentation,
  research events: confirm the parameters with the maintainer.
- Identity, auth, uploads, signed URLs, events, infrastructure: read
  `docs/security-checklist.md`, and run the `security-reviewer` agent on the
  diff before committing.
- A new table or column that holds a person's data: say how it is erased and
  exported.
- A new dependency: maintained, pinned, licence in `scripts/license-policy.json`.
- A decision that changes identity, uploads, events, retention or
  infrastructure needs an ADR in `docs/adr/`.

## Also

- TypeScript strict. No `any` in exported signatures. Validate at boundaries
  with `packages/schema`; trust types inside.
- English for code, comments, commits and docs. Text people see goes through
  i18n keys.
- Meaning never by colour alone. Every touchable has a label and a role and is
  at least 44 pt. Decisions are buttons, not swipes.
- Secrets live in SSM. Logs carry `account_id` and a request id, never hetu,
  message text, email or `seeks`.
```

Notes on the draft:

- The Git section shrinks to four lines because phase 2 retires the version bump and most gates. Until phase 2 lands, keep the current Git section below the draft.
- The skills (`open-pr`, `write-tests`, `change-rule`, `personal-data`, `check-screen`, `recheck-issues`) stay as skills. `CLAUDE.md` no longer describes the hooks that force them; see phase 2.
- The session handoff section moves to the `handoff` skill, which already holds it.
