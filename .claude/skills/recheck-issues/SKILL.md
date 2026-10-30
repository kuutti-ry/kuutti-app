---
name: recheck-issues
description: Check the issues a merged pull request refers to against what landed, then close each as completed or comment what is left. Use after every merge, on the website too, when the user says something merged, and when work on an issue finishes without a pull request. A hook keeps the turn from ending until this skill has run for each merged pull request of the session.
argument-hint: <pull request number>...
---

Pass the pull request's number as the argument: the hook reads it there. Several numbers cover several pull requests. For an issue finished with no pull request, say so and start at step 3 with that issue.

CLAUDE.md's Git section is the rule. A merge closes nothing by itself, so this check does.

1. **What landed.** Run `gh pr view <n> --json number,title,state,url,mergeCommit,body` and `gh pr diff <n> --name-only`. If the state is not `MERGED`, stop and say so. The version is the one at the merge: `git fetch origin main`, then `git show <commit>:package.json`.
2. **Which issues.** Every `Refs` line of the body, and any other issue the body says it touched (a checklist item on an umbrella, a side issue). An issue already closed needs nothing. A pull request that refers to no issue is finished here.
3. **What was asked.** For each open issue, read `gh issue view <m> --comments`: its body, its boxes, every comment, and the maintainer's decisions in this chat, which outrank the issue's text. Compare each item with what landed. Where the pull request's words do not settle it, read the code on `origin/main`. "Left out on purpose" in the pull request's body counts as left.
4. **Decide.**
   - **Nothing left:** `gh issue close <m> --reason completed --comment "<…>"`, naming the pull request, the short commit and the version. This does not wait for the maintainer's testing: testing comes after, and what it finds is a new issue. A choice the maintainer will make while testing does not hold an issue open either.
   - **Something left:** tick the boxes that landed (`gh issue edit <m> --body-file <file>`), and comment what landed, exactly what is left and whose move it is. The issue stays open. An umbrella stays open until its last piece.
5. **Report** one line per issue: closed, or what is left and whose move it is.

A backlog check not tied to a merge is different: report what you find and wait for the maintainer's word before closing anything.
