#!/usr/bin/env bash
# The one sticky comment of a pull request's previews (#9): every lane rewrites
# it with what it knows, so a re-run or a later lane replaces rather than
# stacks. Inputs are environment variables; empty ones mean "not there yet".
set -euo pipefail
: "${GH_TOKEN:?}" "${PR_NUMBER:?}" "${SHORT_SHA:?}" "${RUNNER_TEMP:?}"
: "${API_URL:=}" "${DATABASE:=}" "${WEB_URL:=}" "${ADMIN_URL:=}" "${NATIVE:=}" "${NATIVE_QR:=}" "${NATIVE_LINK:=}" "${NOTICE:=}"

body="$RUNNER_TEMP/preview-comment.md"
{
  echo "#### Preview · \`$SHORT_SHA\`"
  echo
  if [ -n "$NOTICE" ]; then
    echo "$NOTICE"
    echo
  fi
  if [ -n "$API_URL" ]; then
    echo "| lane | where |"
    echo "|---|---|"
    echo "| API | $API_URL/health · database \`$DATABASE\` on the staging instance, seeded, never a copy |"
    if [ -n "$WEB_URL" ]; then
      echo "| Web | $WEB_URL |"
    else
      echo "| Web | building… |"
    fi
    # The panel's preview calls the staging API, which has the bank. The bank
    # returns a member of staff to the panel's root, and the preview, on the
    # same origin, reads that session in the same tab (ADR-025 §6).
    if [ -n "$ADMIN_URL" ]; then
      echo "| Admin | $ADMIN_URL · this pull request's panel against the staging API and its invented people (ADR-018): sign in at ${ADMIN_URL%"pr-$PR_NUMBER/"} first, then open this address in the same tab |"
    fi
    case "$NATIVE" in
      "") echo "| Native | pending |" ;;
      not-needed) echo "| Native | not needed: no native code, auth, push or camera change and the fingerprint matches \`main\` |" ;;
      not-configured) echo "| Native | activates with the dev client build (#10): \`expo-updates\` is not configured yet |" ;;
      published) echo "| Native | EAS Update branch \`pr-$PR_NUMBER\`, [details]($NATIVE_LINK); scan below with the dev client |" ;;
      *) echo "| Native | $NATIVE |" ;;
    esac
    echo
    if [ "$NATIVE" = published ] && [ -n "$NATIVE_QR" ]; then
      echo "<a href=\"$NATIVE_QR\"><img src=\"$NATIVE_QR\" width=\"200\" height=\"200\" alt=\"QR code for the EAS Update\" /></a>"
      echo
    fi
    echo "No bank and no photos on the API and web previews (ADR-014 §1, ADR-005): nothing past their sign-in screen can be tried there. Run the branch locally with \`pnpm env:up\` and sign in as a persona of the mock bank."
    echo
    echo "<sub>Rate limit 30 requests a minute, \`X-Robots-Tag: noindex\`. Removed when the pull request closes or after 7 days (\`preview-cleanup.yml\`); a push after that recreates it.</sub>"
  fi
} > "$body"

MARKER=preview BODY_FILE="$body" "$(dirname "$0")/sticky-comment.sh"
