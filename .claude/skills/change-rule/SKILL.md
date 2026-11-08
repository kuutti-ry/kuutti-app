---
name: change-rule
description: Walk a change to how Kuutti behaves toward people: matching, rounds, likes, the pond, rewards, notifications, profile presentation or research events. Use before touching any of them, and whenever a value or a rule would change. It refuses anything on the never-build list, and confirms parameters with the maintainer before building. A hook refuses edits on those paths until this skill has run in the session.
argument-hint: [the rule or area]
---

These rules rest on an evidence base the repository does not hold, so an agent that decides them alone is guessing. The maintainer decides; the agent builds and records. CLAUDE.md's Product constraints section is the rule.

## 1. Refuse what is never built

Compatibility or chemistry scores, desirability signals, infinite feeds, real-time engagement push, streaks, leaderboards, boosts or anything purchasable, ads or ad SDKs, pre-match links to external profiles, under-18 access. If the task is one of these, or works like one under another name, stop, refuse, and cite CLAUDE.md's Product constraints. No version of it, however small, and no feature flag.

## 2. Does this change a rule?

A rule is what a person gets, sees, or is told, and any number behind it. Find what stands today:

- the rule's row in `docs/decisions.md`, with who decided it and where it is recorded;
- its `Scenario` in `features/<slice>/`, and the ADR the row cites.

A bug fix that makes the code do what the row and the spec already say changes no rule. Say so in one line and go on to step 6. A refactor that changes no outcome is the same. If the code and the record disagree, stop and ask which one is right.

## 3. Confirm with the maintainer

Put the change to the maintainer before building, as one short question with your recommendation: what changes, the value, and who it reaches. A parameter is never settled by the agent, not even a default, and a test's value is not a decision. An open question stays open: file it, or ask. What the maintainer says, with its date, goes into the record.

## 4. Spec first

Rules-layer behaviour goes in `features/<slice>/*.feature`, with `@pending` if the spec lands before the code. The `Scenario` name is the test's name, verbatim (`pnpm check:scenarios`). More than three lines of `Given` means an ordinary test.

## 5. Values live in `matching_config`

A tunable is a row, never a constant in code. A new key is born in a `--custom` migration with its value in the seed's `MATCHING_CONFIG_V1`; a new value is a new version, by a migration naming itself or by an admin with a reason. Never edit a migration or rewrite a version. Limits that are infrastructure (rate limits in SSM) stay out of it.

## 6. Build, within the rules

- Hard filters are never violated, in either direction, for any reason (rule 7).
- Nothing mentions a desirability signal to anybody, and no answer's time or shape reveals one.
- Research events are keyed by `research_id` and carry no message text (rule 5).
- Whom a push tells belongs to the notifications slice (ADR-055). A push is never real-time engagement.
- New data goes through `personal-data` as well; new or changed tests through `write-tests`.

## 7. Record it

In the same pull request: the row in `docs/decisions.md` (the value, where it lives, the source; `pnpm check:decisions`), the ADR if identity, uploads, event flow, data retention or infrastructure change, and any drawing `pnpm check:docs` names. The pull request says what the maintainer decided and when.
