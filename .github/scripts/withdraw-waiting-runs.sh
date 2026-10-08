#!/usr/bin/env bash
# Withdraws the preview runs that wait for a click nobody owes any more
# (#9, ADR-012 §8). A run of preview.yml waits for the reviewer of the
# "preview" environment (when it has one, ADR-004 §3); its pull request
# merges or closes; the run goes on waiting, for the thirty days GitHub gives
# it, and asks the maintainer to review a deployment of work that is on main
# already. The sweep that removes
# what was deployed never saw these: a run that was not approved deployed
# nothing, so there is nothing of it on the box to find it by.
#
#   withdraw-waiting-runs.sh                  cancel them
#   DRY_RUN=true withdraw-waiting-runs.sh     say which, cancel nothing
#
# A run is withdrawn only when its branch has a closed pull request and no
# open one. What cannot be read is left waiting, with a warning: a run
# withdrawn by mistake costs somebody a push, a run left waiting costs
# nothing. A cancellation that fails is named, and fails the script at its
# end, after the others have been tried; a run that stopped waiting by
# itself in the meantime is no failure.
set -euo pipefail
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}"
WORKFLOW="${WORKFLOW:-preview.yml}"
DRY_RUN="${DRY_RUN:-false}"

err=$(mktemp)
trap 'rm -f "$err"' EXIT

# The pull requests of one branch of one owner, in one state, as "#n, #m".
# By owner and branch, never by the branch's name alone: anybody can open
# pull requests from a fork's branch of the same name, and a hundred closed
# ones would push the open one out of a list that is cut at a hundred.
pulls() { # pulls <open|closed> <owner> <branch>
  gh api -X GET "repos/$GITHUB_REPOSITORY/pulls" -f state="$1" -f head="$2:$3" -f per_page=100 \
    --jq '[.[] | "#\(.number)"] | join(", ")'
}

# Only what a pull request started: a run on main belongs to no pull request.
runs=$(gh api --paginate \
  "repos/$GITHUB_REPOSITORY/actions/workflows/$WORKFLOW/runs?status=waiting&event=pull_request&per_page=100" \
  --jq '.workflow_runs[] | {id, branch: .head_branch, owner: .head_repository.owner.login}' | jq -cs .)

withdrawn=0
failed=""
while read -r run; do
  id=$(jq -r .id <<< "$run")
  branch=$(jq -r '.branch // ""' <<< "$run")
  owner=$(jq -r '.owner // ""' <<< "$run")
  if [ -z "$branch" ] || [ -z "$owner" ]; then
    echo "::warning::run $id names no branch or no repository; left waiting"
    continue
  fi
  # By the branch, not by the run's own list of pull requests: GitHub empties
  # that list when the pull request closes, which is the case in question.
  # The open ones first, and alone: whatever else is true, an open pull
  # request keeps its run.
  if ! open=$(pulls open "$owner" "$branch" 2>"$err") || ! gone=$(pulls closed "$owner" "$branch" 2>"$err"); then
    echo "::warning::run $id ($owner:$branch): its pull requests could not be read, left waiting: $(cat "$err")"
    continue
  fi
  if [ -n "$open" ]; then
    echo "run $id ($owner:$branch): $open is open; left waiting"
  elif [ -z "$gone" ]; then
    echo "::warning::run $id ($owner:$branch): no pull request of that branch was found; left waiting"
  elif [ "$DRY_RUN" = true ]; then
    echo "run $id ($owner:$branch): $gone closed, none open; would be withdrawn"
  elif gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/cancel" >/dev/null 2>"$err"; then
    echo "run $id ($owner:$branch): $gone closed, none open; withdrawn"
    withdrawn=$((withdrawn + 1))
  elif status=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id" --jq .status 2>/dev/null) && [ "$status" != waiting ]; then
    # Approved, cancelled or timed out between the list and the cancellation.
    echo "run $id ($owner:$branch): no longer waiting ($status); nothing to withdraw"
  else
    echo "::error::run $id ($owner:$branch) could not be withdrawn: $(cat "$err")"
    failed="$failed $id"
  fi
done < <(jq -c '.[]' <<< "$runs")

echo "withdrawn: $withdrawn"
if [ -n "$failed" ]; then
  echo "::error::still waiting, to be cancelled by hand (gh run cancel <id>):$failed"
  exit 1
fi
