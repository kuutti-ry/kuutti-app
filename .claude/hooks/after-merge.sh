#!/usr/bin/env bash
# PostToolUse hook on Bash: after a `gh pr merge` that merged, send the agent
# to the recheck-issues skill at once, naming every issue the pull request
# refers to (CLAUDE.md, Git). skill-gates.ts holds the end of the turn to it.
# stdout is JSON whose additionalContext reaches the agent. Silent for every
# other command, and for a merge that did not happen (refused, or left to
# auto-merge).
set -u
input="$(cat)"
# Every shell command passes here: leave at once unless it is a merge.
printf '%s' "$input" | grep -Eq 'gh[[:space:]]+pr[[:space:]]+merge' || exit 0
# The program comes on stdin through a quoted heredoc, so nothing in it is
# the shell's to interpret; the call's JSON travels in INPUT.
INPUT="$input" node --input-type=module - <<'JS'
import { execFileSync } from "node:child_process";
let call;
try {
  call = JSON.parse(process.env.INPUT ?? "");
} catch {
  process.exit(0);
}
const command = String(call?.tool_input?.command ?? "");
const merge = /\bgh\s+pr\s+merge\b(.*)/s.exec(command);
if (!merge) process.exit(0);
const rest = merge[1];
// No number: gh merged the current branch's pull request, and gh pr view finds it the same way.
const pr = (/\/pull\/(\d+)/.exec(rest) ?? /(?:^|\s)#?(\d+)(?=\s|$)/.exec(rest))?.[1];
const repo = /--repo[ =](\S+)|-R\s+(\S+)/.exec(rest);
const repoArgs = repo ? ["--repo", repo[1] ?? repo[2]] : [];
let view;
try {
  view = JSON.parse(
    execFileSync("gh", ["pr", "view", ...(pr ? [pr] : []), ...repoArgs, "--json", "number,state,body,mergeCommit"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  view = null;
}
if (view && view.state !== "MERGED") process.exit(0);
const refs = view
  ? [...new Set([...String(view.body ?? "").matchAll(/^\s*Refs\s+(\S*#\d+)/gim)].map((m) => m[1]))]
  : [];
const number = pr ?? view?.number;
if (!number) process.exit(0);
const commit = view?.mergeCommit?.oid ? ` as ${view.mergeCommit.oid.slice(0, 7)}` : "";
const issues = refs.length > 0 ? refs.join(", ") : "each issue the pull request refers to";
const additionalContext =
  `Pull request #${number} merged${commit}. Before anything else, run the recheck-issues skill ` +
  `with ${number}: it checks ${issues} against what landed, and closes each or says what is left.`;
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }),
);
JS
