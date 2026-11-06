#!/usr/bin/env bash
# Proves that kuutti-ci-plan, which any pull request of this repository may
# assume, is refused every data read the bootstrap denies it: the actions of
# ci_plan_deny_data in infra/bootstrap/main.tf (ADR-001, ADR-066, ADR-067).
# The actions come from the policy's own text, so a deny added there is probed
# here: an action with no probe below, and no reason why not, fails the run.
# A deny declared but not yet applied fails it too, until the maintainer has
# applied the bootstrap.
#
# Each probe is one call that would read something if it were allowed, aimed
# at something that does not exist or matches nothing. A call that is wrongly
# allowed answers "not found" or an empty list, never a value. Only the error
# stream is kept, and a probe passes on AccessDenied alone.
#
# Usage: plan-role-denies.sh <infra/bootstrap/main.tf>, with the plan role's
# credentials in the environment (infra-oidc.yml). plan-role-denies.test.sh
# runs it against a stand-in aws.
set -euo pipefail
policy=${1:?usage: plan-role-denies.sh <infra/bootstrap/main.tf>}

# A read loop rather than mapfile, so that a Mac's bash 3.2 runs it too.
actions=()
while IFS= read -r action; do actions+=("$action"); done < <(
  awk '/data "aws_iam_policy_document" "ci_plan_deny_data"/,/^}/' "$policy" |
    awk '/actions *= *\[/,/\]/' | grep -oE '"[a-z0-9-]+:[A-Za-z*]+"' | tr -d '"' || true
)
if [ "${#actions[@]}" -eq 0 ]; then
  echo "::error::no action found in ci_plan_deny_data of $policy"
  exit 1
fi

none=kuutti-ci-probe                      # a name nothing in the account has
zero=00000000-0000-0000-0000-000000000000 # an id nothing has
account=$(aws sts get-caller-identity --query Account --output text)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A time in ISO 8601 on GNU date (the runner) or BSD date (a Mac).
iso() { date -u -d "@$1" +%FT%TZ 2>/dev/null || date -u -r "$1" +%FT%TZ; }

# The denied actions no call can show safely, and why.
unprobed() {
  case "$1" in
    kms:Decrypt) echo "the step before asks to decrypt the canary parameter" ;;
    rds:DownloadCompleteDBLogFile) echo "a REST call the CLI does not make, denied in the same statement" ;;
    cloudfront-keyvaluestore:List\*) echo "ListKeys would hand out the store's values if it were allowed, and no store without values is there to aim at; GetKey shows the statement in force" ;;
    *) return 1 ;;
  esac
}

# One call per action. 4 means the action has no probe.
probe() {
  case "$1" in
    secretsmanager:GetSecretValue)
      aws secretsmanager get-secret-value --secret-id "$none" ;;
    logs:GetLogEvents)
      aws logs get-log-events --log-group-name "/$none" --log-stream-name "$none" ;;
    logs:FilterLogEvents)
      aws logs filter-log-events --log-group-name "/$none" --limit 1 ;;
    logs:StartQuery)
      # A window a query may have, so that only the deny or the missing group
      # can refuse it.
      local end
      end=$(date -u +%s)
      aws logs start-query --log-group-name "/$none" --start-time $((end - 300)) --end-time "$end" \
        --query-string 'fields @timestamp | limit 1' ;;
    logs:GetQueryResults)
      aws logs get-query-results --query-id "$zero" ;;
    rds:DownloadDBLogFilePortion)
      aws rds download-db-log-file-portion --db-instance-identifier "$none" --log-file-name "$none" ;;
    cloudfront-keyvaluestore:Get\*)
      # The real store of the proof (ADR-066) and a key it does not hold: if
      # GetKey were allowed it would answer that the key is not there, never
      # with the secret's value.
      local store
      store=$(aws cloudfront describe-key-value-store --name kuutti-staging-origin-proof \
        --query KeyValueStore.ARN --output text)
      aws cloudfront-keyvaluestore get-key --kvs-arn "$store" --key "$none" ;;
    cloudfront:TestFunction)
      printf '%s' '{"version":"1.0","context":{"eventType":"viewer-request"},"viewer":{"ip":"192.0.2.1"},"request":{"method":"GET","uri":"/","headers":{},"cookies":{},"querystring":{}}}' >"$work/event.json"
      aws cloudfront test-function --name "$none" --if-match "E$none" --event-object "fileb://$work/event.json" ;;
    cloudtrail:LookupEvents)
      aws cloudtrail lookup-events --max-results 1 --lookup-attributes "AttributeKey=EventName,AttributeValue=$none" ;;
    wafv2:GetRateBasedStatementManagedKeys)
      aws wafv2 get-rate-based-statement-managed-keys --region us-east-1 --scope CLOUDFRONT \
        --web-acl-name "$none" --web-acl-id "$zero" --rule-name "$none" ;;
    wafv2:GetSampledRequests)
      local now
      now=$(date -u +%s)
      aws wafv2 get-sampled-requests --region us-east-1 --scope CLOUDFRONT --max-items 1 \
        --web-acl-arn "arn:aws:wafv2:us-east-1:$account:global/webacl/$none/$zero" --rule-metric-name "$none" \
        --time-window "StartTime=$(iso $((now - 3600))),EndTime=$(iso "$now")" ;;
    s3:GetObject)
      # A bucket of this account outside the state bucket, a key it does not
      # hold: if allowed, NoSuchKey; never an object.
      aws s3api get-object --bucket "kuutti-media-staging-$account" --key "$none" "$work/object" ;;
    s3:GetObjectVersion)
      aws s3api get-object --bucket "kuutti-media-staging-$account" --key "$none" --version-id "$none" "$work/object" ;;
    *)
      return 4 ;;
  esac
}

failures=0
for action in "${actions[@]}"; do
  if reason=$(unprobed "$action"); then
    echo "· $action: not probed, $reason"
    continue
  fi
  status=0
  probe "$action" >/dev/null 2>"$work/error" || status=$?
  code=$(sed -nE 's/.*An error occurred \(([A-Za-z0-9]+)\).*/\1/p' "$work/error" | head -n 1)
  if [ "$status" -eq 4 ]; then
    echo "::error::$action is denied by ci_plan_deny_data and has no probe: add one to this script, or the reason it cannot be probed"
  elif [ "$status" -eq 0 ]; then
    echo "::error::$action was allowed: the call succeeded, so the deny is not in force (is the bootstrap applied?)"
  elif [[ "$code" == AccessDenied* ]]; then
    echo "✔ $action denied"
    continue
  else
    echo "::error::$action was not denied: ${code:-no error code} (exit $status), so the deny is not in force (is the bootstrap applied?)"
  fi
  failures=$((failures + 1))
done

if [ "$failures" -gt 0 ]; then
  echo "$failures of the ${#actions[@]} actions ci_plan_deny_data denies are not shown denied"
  exit 1
fi
echo "every action ci_plan_deny_data denies is refused or named above"
