#!/usr/bin/env bash
# Test the Campaign Codegen → PR Service endpoints.
# Run sections one at a time by uncommenting.
#
#   chmod +x test-api.sh
#   ./test-api.sh
#
# Requires the server running:  npm start   (from new_approach/)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

BASE="${SERVER_URL:-http://localhost:4300}"
SECRET="${API_SHARED_SECRET:-}"

if [ -z "$SECRET" ]; then
  echo "API_SHARED_SECRET not set. Export it or ensure .env has it."
  exit 1
fi

echo "Server: $BASE"
echo ""

# ─── 1. Health check (no auth) ──────────────────────────────

echo "=== 1. Health check ==="
curl -s "$BASE/healthz" | jq -C .
echo ""

# ─── 2. Create a campaign ───────────────────────────────────

echo "=== 2. Create a campaign ==="
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/campaigns" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "summer-sale-2026",
    "campaignName": "Summer Sale 2026",
    "offer": "20% off all annual plans",
    "audience": "Small business owners",
    "cta": "Claim 20% Discount",
    "brief": "Summer promotional campaign. Highlight urgency and value."
  }')

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

echo "HTTP $HTTP_CODE"
echo "$BODY" | jq -C .

RUN_ID=$(echo "$BODY" | jq -r '.runId')
if [ "$RUN_ID" = "null" ] || [ -z "$RUN_ID" ]; then
  echo "No runId returned. Aborting."
  exit 1
fi
echo "Run ID: $RUN_ID"

# ─── 3. Poll status ─────────────────────────────────────────

echo ""
echo "=== 3. Polling status ==="
POLL=0
while true; do
  POLL=$((POLL + 1))
  STATUS=$(curl -s "$BASE/campaigns/$RUN_ID" -H "Authorization: Bearer $SECRET")
  ST=$(echo "$STATUS" | jq -r '.status // "?"')
  STAGE=$(echo "$STATUS" | jq -r '.stage // "?"')
  echo "[$POLL] $(date +%H:%M:%S)  status=$ST  stage=$STAGE"

  case "$ST" in
    completed|failed*)
      echo ""
      echo "Terminal state: $ST"
      echo "$STATUS" | jq -C .
      break
      ;;
  esac
  sleep 5
done

# ─── 4. Get full log ────────────────────────────────────────

echo ""
echo "=== 4. Full log ==="
curl -s "$BASE/campaigns/$RUN_ID/log" \
  -H "Authorization: Bearer $SECRET" | tail -40
echo ""

# ─── 5. Error: missing auth ─────────────────────────────────

echo ""
echo "=== 5. Error — missing auth (expect 401) ==="
curl -s -w "\nHTTP %{http_code}\n" "$BASE/campaigns/nonexistent" | tail -3
echo ""

# ─── 6. Error: bad brief ────────────────────────────────────

echo "=== 6. Error — bad slug (expect 400) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/campaigns" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"slug":"BAD SLUG!","campaignName":"T","offer":"t","audience":"t","cta":"t"}' | tail -5
echo ""
