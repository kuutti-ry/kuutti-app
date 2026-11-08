<!-- What changes and why. -->

Refs #

<!-- One "Refs #n" per issue this touches: it links the issue and the pull request
     both ways without closing anything. Never "Closes/Fixes/Resolves #n": a merge
     closes nothing by itself; after it, the issue is closed as completed once
     nothing is left on it (CLAUDE.md, Git; CI checks the keyword). -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, DCO).
- [ ] The change cites the TD or ADR it follows, or adds an ADR (identity, uploads, event flow, data retention, infrastructure).
- [ ] Security surfaces touched (Telia OIDC exchange, hetu HMAC, session tokens, signed URLs, workflows, infrastructure)? If yes, the `security-reviewer` agent or a second person has read the diff against `docs/security-checklist.md`.
- [ ] User-facing text goes through `t()` with keys in `packages/i18n/messages.yaml`; `pnpm i18n:build` output is committed.
- [ ] New or changed Finnish and Swedish text carries `machine:` (written by a machine, an agent, or anyone but a native reviewer); a `reviewed:` hash appears only through `pnpm i18n:review` for a native reviewer who approves this pull request.
- [ ] Every new touchable has `accessibilityLabel` and `accessibilityRole`, is at least 44 pt, and the screen holds at the largest font size.
- [ ] Screen-reader walk stated here: which changed screens were walked with VoiceOver and TalkBack (no unlabelled control, no path that only a gesture opens), on which phones, by whom; or that they were not walked, and why, with an `Unwalked: <screens>` line in the commit message (`.claude/rules/mobile.md`).
- [ ] A drawing whose `<!-- draws` files this changes is redrawn with its steps, or a commit message says `Still-true: <file>` (ADR-047, `pnpm check:docs`).
- [ ] New dependency: maintained, pinned, any install script named here, licence inside `scripts/license-policy.json`.
- [ ] Tests added, changed or removed at every level that applies, and the ones guarding a rule seen to fail when it breaks (ADR-021, the `write-tests` skill). Named here: the levels left out, and why.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally.
