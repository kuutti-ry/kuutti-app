#!/usr/bin/env bash
# PostToolUse hook on Bash: after a `gh pr merge` that merged, tell the agent
# to check every issue the pull request refers to against what landed, and to
# close it or say what is left (CLAUDE.md, Git). stdout is JSON whose
# additionalContext reaches the agent. Silent for every other command, and
# for a merge that did not happen (refused, or left to auto-merge).
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
  `Pull request #${number} merged${commit}. Before anything else, check ${issues} against what landed ` +
  "(its body, its comments, the maintainer's decisions in chat; CLAUDE.md, Git). An issue with " +
  "nothing left: close it as completed, with a comment naming the pull request, the commit and " +
  "the version. Otherwise comment what landed, what is left and whose move it is, and tick the " +
  "boxes that landed. An umbrella issue stays open until its last piece.";
process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }),
);
JS
