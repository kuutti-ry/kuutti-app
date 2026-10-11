#!/usr/bin/env bash
# Is the pull request still open? Prints "true" or "false". A preview run can
# outlive its pull request: it waits for the image, for a reviewer of the
# "preview" environment (if any), for the lane before it. A lane that deployed
# after the merge would put back what the cleanup sweep removed, and nothing
# says a later sweep comes soon (ADR-012 §6, §7). Every lane asks right before it
# deploys. A state that cannot be read is an error, not a guess: no deploy.
set -euo pipefail
: "${GH_TOKEN:?}" "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}"

state=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json state --jq .state)
if [ "$state" = OPEN ]; then echo true; else echo false; fi
