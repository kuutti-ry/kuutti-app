#!/usr/bin/env bash
# What plan-role-denies.sh decides, against an aws that answers from this file
# and reaches nobody: the policy's actions are read from its own text, every
# probe passes when every call is refused, each call that is allowed fails the
# run by its action, a refusal for another reason fails it too, an action with
# no probe fails it, and nothing a call answers reaches the output. Run by the
# workflows job of ci.yml.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The stand-in. AWS_ALLOW is "all", or the service:operation pairs it answers
# as allowed; it refuses every other call with AWS_CODE, AccessDenied's code
# by default. An allowed call prints a value that must never be seen.
cat >"$work/aws" <<'STANDIN'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012; exit 0 ;;
  "cloudfront describe-key-value-store")
    echo "arn:aws:cloudfront::123456789012:key-value-store/11111111-2222-3333-4444-555555555555"; exit 0 ;;
esac
if [ "${AWS_ALLOW:-}" = all ] || [[ " ${AWS_ALLOW:-} " == *" $1:$2 "* ]]; then
  echo "THE-VALUE-THAT-MUST-NOT-BE-SEEN"
  # An empty match is a success; anything else allowed is not found.
  [ "$1 $2" = "cloudtrail lookup-events" ] && exit 0
  echo "An error occurred (ResourceNotFoundException) when calling the Op operation: not found" >&2
  exit 254
fi
case "$1" in
  s3api | cloudfront | rds) code=${AWS_CODE:-AccessDenied} ;;
  *) code=${AWS_CODE:-AccessDeniedException} ;;
esac
echo "An error occurred ($code) when calling the Op operation: User: arn:aws:sts::123456789012:assumed-role/kuutti-ci-plan/gha is not authorized with an explicit deny in an identity-based policy" >&2
exit 254
STANDIN
chmod +x "$work/aws"

failed=0
check() {
  if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; failed=$((failed + 1)); fi
}
# Runs the script on a policy, the stand-in answering as AWS_ALLOW and AWS_CODE say.
probes() {
  status=0
  PATH="$work:$PATH" AWS_ALLOW="$1" AWS_CODE="${3:-}" "$here/plan-role-denies.sh" "$2" >"$work/out" 2>&1 || status=$?
}
errors() { grep -c '^::error::' "$work/out" || true; }

policy="$root/infra/bootstrap/main.tf"

probes "" "$policy"
check "with every call refused, the run passes" '[ "$status" -eq 0 ] && [ "$(errors)" -eq 0 ]'
check "the policy's first and last actions are read" 'grep -q "^· kms:Decrypt: not probed" "$work/out" && grep -q "^✔ s3:GetObjectVersion denied" "$work/out"'
check "the four that cannot be probed say why" '[ "$(grep -c ": not probed, " "$work/out")" -eq 4 ]'
denied=$(grep -c '^✔ ' "$work/out")

probes all "$policy"
check "with every call allowed, the run fails" '[ "$status" -eq 1 ]'
check "each probed action is an error of its own" '[ "$(errors)" -eq "$denied" ]'
check "a search that matches nothing is caught by its success" 'grep -q "^::error::cloudtrail:LookupEvents was allowed: the call succeeded" "$work/out"'
check "nothing an allowed call answered is seen" '! grep -q THE-VALUE-THAT-MUST-NOT-BE-SEEN "$work/out"'

probes "wafv2:get-rate-based-statement-managed-keys" "$policy"
check "one call allowed fails the run by its action alone" '[ "$status" -eq 1 ] && [ "$(errors)" -eq 1 ] && grep -q "^::error::wafv2:GetRateBasedStatementManagedKeys was not denied: ResourceNotFoundException" "$work/out"'

probes "" "$policy" ThrottlingException
check "a refusal for another reason is no proof" '[ "$status" -eq 1 ] && [ "$(errors)" -eq "$denied" ] && grep -q "was not denied: ThrottlingException" "$work/out"'

cat >"$work/unknown.tf" <<'POLICY'
data "aws_iam_policy_document" "elsewhere" {
  statement {
    actions = ["s3:PutObject"]
  }
}

data "aws_iam_policy_document" "ci_plan_deny_data" {
  statement {
    effect = "Deny"
    actions = [
      "kms:Decrypt",
      # a comment without quotes is no action
      "ec2:GetConsoleOutput",
    ]
    resources = ["*"]
  }
}
POLICY
probes "" "$work/unknown.tf"
check "a denied action with no probe fails the run" '[ "$status" -eq 1 ] && grep -q "^::error::ec2:GetConsoleOutput is denied by ci_plan_deny_data and has no probe" "$work/out"'
check "another document's actions are not read" '! grep -q "s3:PutObject" "$work/out"'

printf 'resource "aws_s3_bucket" "x" {}\n' >"$work/empty.tf"
probes "" "$work/empty.tf"
check "a policy without the document fails the run" '[ "$status" -eq 1 ] && grep -q "^::error::no action found in ci_plan_deny_data" "$work/out"'

if [ "$failed" -gt 0 ]; then
  echo "$failed failed"
  exit 1
fi
echo "all passed"
