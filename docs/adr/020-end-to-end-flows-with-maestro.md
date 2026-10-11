# ADR-020: End-to-end flows with Maestro

Date: 2026-10-10. Status: accepted. Refs #164.

## Context

Routes have their `app.request()` tests and the demo stories run through the real routes, but nothing drove a screen: sign-in, onboarding, the field screens and the card were checked by hand, on a simulator, from a chart. Each round of that costs an evening. #164 asked for flows that drive the app against the local environment, starting from the demo cast, and left the driver to the maintainer.

## Decision

1. **Maestro** drives the mobile app: YAML flows under `apps/mobile/e2e/`, one file per behaviour, the same files for iOS and Android, run by `pnpm e2e` (`maestro test apps/mobile/e2e/flows`). Maestro is a tool on the developer's machine (Homebrew, Apache-2.0), not a dependency of the workspace, so `scripts/license-policy.json` is untouched.
2. **The mock bank only**, as #164 says: a flow signs in through the system browser at `services/mock-idp`'s page as a persona named by their name on that page; Telia's bed and staging stay for people.
3. **The dev client build** on a booted simulator, the bundle opened by the dev client's launcher link to Metro, so a flow never sees the launcher screen.
4. **Local first.** CI comes later, on an Android emulator on a Linux runner, which is cheap where a macOS simulator runner is not.
5. **Texts in three languages.** The app speaks what the phone or the person chose, so every tap and assertion names its text in English, Finnish and Swedish as a regular expression; the texts are those of `messages.yaml`, and a flow that matches on a key's text breaks when the text changes, which is the point.

## Consequences

- `apps/mobile/e2e/common/sign-in.yaml` and the first feature flow, `flows/language.yaml`; a README for the next flows; `pnpm e2e` in the root and in CLAUDE.md's commands.
- The chart of manual checks of 10/10/2026 (#213, #146, #178) was the backlog; it and the cast's stories are now flows, one persona to each where it changes something, so the order does not matter (`apps/mobile/e2e/README.md` has the table). The workspace is `apps/mobile/e2e` (its `config.yaml` runs `flows/*`), so `common/` and the copy of the pictures `scripts/e2e.ts` makes for `addMedia` lie inside it.
- Left for later, each its own change: the admin panel with Playwright; Android in CI; a dev-only sign-in link that completes the mock IdP's login for a named persona, if the system browser proves flaky under Maestro (it touches identity: an ADR and the security reviewer); the storyboard's scenes as flows; a `--only <persona>` reset.
