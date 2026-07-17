#!/usr/bin/env bash
# Fires a campaign at the running service (npm start) and watches it through
# to completion. Edit the campaign fields below, or pass a slug as $1 for a
# quick rerun with different fields left as-is.
#
# Usage:
#   ./post.sh                       # uses the slug below
#   ./post.sh some-other-slug       # overrides just the slug
set -euo pipefail
cd "$(dirname "$0")"

set -a
source ./.env
set +a

SLUG="${1:-spring-security-sale}"

# --- edit these for your campaign ---
BODY=$(cat <<JSON
{
  "slug": "$SLUG",
  "campaignName": "Spring Security Sale",
  "offer": "20% off all cybersecurity certification bundles for the month of March",
  "audience": "IT managers and security leads at mid-size companies",
  "cta": "Claim My Discount",
  "brief": "Aspire Tech Skills and Services is running a spring promotion on certification bundles (CISSP, CCSP, Azure Security Engineer). Emphasize career growth and limited-time urgency. No fake statistics."
}
JSON
)
# --- end editable section ---

extract() { node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const v=JSON.parse(d)$1;console.log(v==null?'':v)}catch{console.log('')}})"; }

echo "POST http://localhost:${PORT}/campaigns  (target: ${GITHUB_TARGET_OWNER}/${GITHUB_TARGET_REPO}@${GITHUB_BASE_BRANCH})"
[ "${DRY_RUN_NO_PR:-false}" = "true" ] && echo "DRY_RUN_NO_PR=true — no real PR will be opened." \
  || echo "DRY_RUN_NO_PR=false — this WILL open a real pull request if it succeeds."
echo

RESPONSE=$(curl -s -X POST "http://localhost:${PORT}/campaigns" \
  -H "Authorization: Bearer ${API_SHARED_SECRET}" \
  -H "Content-Type: application/json" \
  -d "$BODY")

RUN_ID=$(echo "$RESPONSE" | extract ".runId")
if [ -z "$RUN_ID" ]; then
  echo "Request failed:"
  echo "$RESPONSE"
  exit 1
fi
echo "Run started: $RUN_ID"
echo

LAST_STAGE=""
while true; do
  sleep 4
  STATUS_JSON=$(curl -s "http://localhost:${PORT}/campaigns/${RUN_ID}" -H "Authorization: Bearer ${API_SHARED_SECRET}")
  STATUS=$(echo "$STATUS_JSON" | extract ".status")
  STAGE=$(echo "$STATUS_JSON" | extract ".stage")

  if [ "$STAGE" != "$LAST_STAGE" ]; then
    echo "[$(date +%H:%M:%S)] $STATUS / $STAGE"
    LAST_STAGE="$STAGE"
  fi

  case "$STATUS" in
    completed|failed*)
      echo
      echo "=== FINAL: $STATUS ==="
      BRANCH=$(echo "$STATUS_JSON" | extract ".branchName")
      PR_URL=$(echo "$STATUS_JSON" | extract ".prUrl")
      ERROR=$(echo "$STATUS_JSON" | extract ".error")
      [ -n "$BRANCH" ] && echo "branch: $BRANCH"
      [ -n "$PR_URL" ] && echo "PR:     $PR_URL"
      [ -n "$ERROR" ] && echo "error:  $ERROR"
      echo
      echo "Full log: curl -s http://localhost:${PORT}/campaigns/${RUN_ID}/log -H \"Authorization: Bearer \$API_SHARED_SECRET\""
      break
      ;;
  esac
done
