#!/usr/bin/env bash
#
# One-off fix for bugs on the target repo's base branch that block EVERY campaign run.
#
# `next build` typechecks the whole app. A single broken file anywhere on `dev`
# fails verify for every later campaign, no matter what this service generates.
# Two such poisons have landed so far:
#
# 1. src/app/soc-health-check/page.tsx — passed `contents` to <Frame29 />, but
#    Frame29Props requires `contents1` / `contents2`.
#
# 2. src/app/campaigns/soc-analyst-fast-track-bootcamp/sections/DetailsSection1.tsx
#    — AI-generated page that reached `dev` via CONTINUE_ON_VERIFY_FAILURE →
#    approve → merge. `defaultBenefits` is inferred as `{ text: string }[]`, so
#    accessing `benefit.icon` is a type error:
#      Property 'icon' does not exist on type '{ text: string; }'.
#
# This clones `dev` fresh into a temp directory (it never touches the service's
# data/.scratch/_base), applies every pending fix, TYPECHECKS them, shows you
# the diff, and asks before pushing. Nothing is pushed without you typing "yes".
#
# Usage:  ./fix-target-repo.sh
#
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="dev"
WORKDIR="$(mktemp -d /tmp/atss-fix-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# --- credentials + repo, read from the service's own .env -------------------
set -a; source ./.env; set +a
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set in .env}"
: "${GITHUB_TARGET_OWNER:?GITHUB_TARGET_OWNER is not set in .env}"
: "${GITHUB_TARGET_REPO:?GITHUB_TARGET_REPO is not set in .env}"

echo "==> Cloning ${GITHUB_TARGET_OWNER}/${GITHUB_TARGET_REPO}@${BRANCH} (shallow, temp dir)"
# Token is passed via the URL only inside this subshell; it is never echoed.
git clone --quiet --depth 5 --branch "$BRANCH" \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_TARGET_OWNER}/${GITHUB_TARGET_REPO}.git" \
  "$WORKDIR/repo"

cd "$WORKDIR/repo"
echo "    HEAD: $(git log -1 --format='%h %an %ar : %s')"

CHANGED=0

# --- fix 1: soc-health-check Frame29 props ---------------------------------
TARGET_FILE="src/app/soc-health-check/page.tsx"
echo "==> Patching $TARGET_FILE (if still broken)"
python3 - "$TARGET_FILE" <<'PYEOF'
import sys
path = sys.argv[1]
try:
    src = open(path, encoding="utf-8").read()
except FileNotFoundError:
    print("    file missing — skip")
    sys.exit(0)

old = '        contents="Stop skipped searches, slow dashboards, and hidden license costs. Get an expert-reviewed scorecard and a prioritized remediation roadmap—without the consulting fees."'
new = ('        contents1="Stop skipped searches, slow dashboards, and hidden license costs. Get an expert-reviewed scorecard and a prioritized remediation roadmap—without the consulting fees."\n'
       '        contents2="Our free assessment uncovers risks before they become incidents, helping you optimize your Splunk deployment for speed, cost, and security."')

if 'contents1=' in src and 'contents2=' in src:
    print("    already fixed on dev — nothing to do")
    sys.exit(0)
if old not in src:
    print("    ABORT: expected contents= line not found; fix by hand.", file=sys.stderr)
    sys.exit(2)

open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
print("    patched")
PYEOF
rc=$?
if [ "$rc" -eq 2 ]; then exit 2; fi
if git diff --quiet -- "$TARGET_FILE"; then
  :
else
  CHANGED=1
fi

# --- fix 2: poisoned AI campaign DetailsSection1 type error ----------------
DETAILS="src/app/campaigns/soc-analyst-fast-track-bootcamp/sections/DetailsSection1.tsx"
echo "==> Patching $DETAILS (if still broken)"
python3 - "$DETAILS" <<'PYEOF'
import sys
path = sys.argv[1]
try:
    src = open(path, encoding="utf-8").read()
except FileNotFoundError:
    print("    file missing — skip")
    sys.exit(0)

old = "  const defaultBenefits = ["
new = "  const defaultBenefits: { icon?: string; text: string }[] = ["
if "const defaultBenefits: { icon?: string; text: string }[]" in src:
    print("    already fixed on dev — nothing to do")
    sys.exit(0)
if old not in src:
    print("    ABORT: expected defaultBenefits declaration not found; fix by hand.", file=sys.stderr)
    sys.exit(2)
open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
print("    patched")
PYEOF
rc=$?
if [ "$rc" -eq 2 ]; then exit 2; fi
if ! git diff --quiet -- "$DETAILS"; then
  CHANGED=1
fi

if [ "$CHANGED" -eq 0 ]; then
  echo "==> Nothing to do. Exiting."
  exit 0
fi

# --- prove the known type errors are gone ----------------------------------
echo "==> Installing dependencies so the fix can be typechecked (this takes a minute)"
npm ci --silent --no-audit --no-fund

echo "==> Typechecking for the known poisons"
# Raw tsc also reports many spurious "cannot find module *.png" errors (Next
# supplies those declarations during `next build`). Filter to the real ones.
if ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'soc-health-check|DetailsSection1|TS2322.*icon|contents1'; then
  echo "!!! A known type error is STILL present. Not committing." >&2
  exit 1
fi
echo "    OK — known poisons no longer reported"

# --- show, confirm, push ----------------------------------------------------
echo
echo "==> Change to be committed:"
git --no-pager diff --
echo

read -r -p "Push this to ${GITHUB_TARGET_OWNER}/${GITHUB_TARGET_REPO}@${BRANCH}? Type 'yes' to confirm: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "==> Aborted. Nothing was pushed."
  exit 0
fi

git add -- src/app/soc-health-check/page.tsx \
  src/app/campaigns/soc-analyst-fast-track-bootcamp/sections/DetailsSection1.tsx
git -c user.name="${GIT_AUTHOR_NAME:-Arafat Rahman}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-2105118@ugrad.cse.buet.ac.bd}" \
    commit --quiet -m "$(cat <<'EOF'
fix: unblock next build poisoned by broken campaign + Frame29 props

soc-health-check passed a non-existent \`contents\` prop to Frame29.
DetailsSection1 (merged via CONTINUE_ON_VERIFY_FAILURE) accessed
\`benefit.icon\` on a default array typed as \`{ text: string }[]\`.

Either alone fails \`next build\` for the whole \`dev\` branch, so every
later campaign verify fails with NOT CAUSED BY THIS RUN.

EOF
)"

echo "==> Pushing"
git push --quiet origin "$BRANCH"
echo "==> Done: $(git log -1 --format='%h %s' | head -1)"
echo
echo "Next: restart the campaign service so it re-syncs data/.scratch/_base, then fire one campaign."
