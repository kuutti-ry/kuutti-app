---
name: open-pr
description: Open a pull request on Kuutti and put it in Auto-fix. Use for every pull request, before any `gh pr create`, and whenever the user says to open, raise or send one. A hook refuses `gh pr create` until this skill has run in the session, and keeps the turn from ending until Auto-fix is on.
argument-hint: [issue number]
allowed-tools: mcp__ccd_pr__get_status, mcp__ccd_pr__set_monitor
---

Every pull request goes this way, in this order. The rules are CLAUDE.md's (Git, Commands, Testing); this is the order they run in.

## Before

1. **The branch** is not `main`, is cut from `origin/main`, and carries only what was asked. Every commit is signed off (`git commit -s`). An issue exists for the work, or the nearest related one is named.
2. **Tests**: when the branch changes code, run the `write-tests` skill first. The hook refuses the pull request without it.
3. **What the change calls for**, and only that:
   - `pnpm openapi` after a route contract, `pnpm i18n:build` after `messages.yaml`, `pnpm --filter @kuutti/db generate --name <what>` after a schema change;
   - `pnpm check:docs` always (it says which drawings the change touches), `pnpm check:scenarios` after a `.feature`, `pnpm check:decisions` after a rule or a value, `pnpm check:adr-index` after an ADR;
   - the `security-reviewer` agent on the diff when it touches the Telia OIDC exchange, the hetu HMAC, session tokens or signed URLs.
4. **The version**: `pnpm version:bump minor` for a feature, `patch` for fixes only, from a branch that contains main's tip. Again after any rebase onto a bumped main.
5. **Green here**: `pnpm typecheck && pnpm lint && pnpm test`. Do not push red.
6. **Pushed**: `git log origin/<branch>..HEAD` is empty.

## The pull request

Write the body to a file, from `.github/pull_request_template.md`:

- what changes and why, citing the TD or ADR it follows;
- `Refs #n` for each issue it works on, never a closing keyword;
- which tests changed at which levels, from `write-tests`' report;
- what was left out on purpose, and what would make it needed;
- the checklist, each box ticked or struck through with the reason;
- the attribution line the session's instructions give.

```bash
gh pr create --base main --title "<imperative, under 72 characters>" --body-file <file>
```

## After

1. Call `mcp__ccd_pr__get_status`. If it does not report this pull request, bind it with `mcp__ccd_pr__bind_pr` and its URL.
2. Call `mcp__ccd_pr__set_monitor` with `auto_fix: true`, `address_comments: true` and the URL. The maintainer's standing word is that every pull request is in Auto-fix (30/10/2026), so do not ask first. The app may still show its own approval card; if the maintainer declines it, leave it off.
3. Read the checks once from `get_status`, then leave them. The app wakes the session on a failed check, a merge conflict or a review comment. Never poll CI or schedule a check of it. What arrives is fixed in this pull request, a flake too, with a comment.
4. Never enable auto-merge unasked, never use `--admin`, and never request a review from Copilot.
5. Give the link and say what the pull request waits for: green checks, then the maintainer's approval.

Outside the desktop app the `ccd_pr` tools do not exist and the hook does not ask for Auto-fix. Say so in the report, and read `gh pr checks` when the session comes back to it.
