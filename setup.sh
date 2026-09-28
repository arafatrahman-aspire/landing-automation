#!/usr/bin/env bash
# One-command setup for the landing-page automation service (no Docker).
#
#   bash setup.sh
#
# Put your .env (and campaigns.db, if you want the old run history) in the
# same folder as this script first — both are picked up automatically.
#
# Installs to ~/landing-automation (override: INSTALL_DIR=/some/path bash setup.sh).
# Safe to re-run: it updates what's there instead of starting over.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/arafatrahman-aspire/landing-automation.git}"
REPO_BRANCH="main"
INSTALL_DIR="${INSTALL_DIR:-$HOME/landing-automation}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

step() { echo; echo -e "\e[1m==> $*\e[0m"; }
ok()   { echo -e "  \e[32m✓\e[0m $*"; }
warn() { echo -e "  \e[33m! $*\e[0m"; WARNINGS+=("$*"); }
die()  { echo -e "  \e[31m✗ $*\e[0m" >&2; exit 1; }
WARNINGS=()

SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"

# Read KEY from a .env without sourcing it.
env_get() {
  local line; line="$(grep -E "^${1}=" "$2" | tail -n1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}
# git with a GitHub token passed as a header (never saved to disk or shown in `ps`).
git_tok() {
  local tok="$1"; shift
  if [[ -n "$tok" ]]; then
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$tok" | base64 | tr -d '\n')" git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# Already inside a checkout (git clone ... && bash setup.sh)? Use it in place.
if [[ -f "$HERE/src/server.mjs" ]]; then INSTALL_DIR="$HERE"; fi

OLD_ENV=""; [[ -f "$HERE/.env" && "$HERE" != "$INSTALL_DIR" ]] && OLD_ENV="$HERE/.env"
OLD_DB="";  [[ -f "$HERE/campaigns.db" ]] && OLD_DB="$HERE/campaigns.db"

if [[ -n "$OLD_ENV" ]]; then ENV_FILE="$OLD_ENV"
elif [[ -f "$INSTALL_DIR/.env" ]]; then ENV_FILE="$INSTALL_DIR/.env"
else die "no .env found — paste your .env into $HERE (next to setup.sh) and re-run"; fi
TOKEN="$(env_get GITHUB_TOKEN "$ENV_FILE")"
ok "using $ENV_FILE"
[[ -n "$OLD_DB" ]] && ok "will import run history from $OLD_DB"

# ---------------------------------------------------------------------------
step "Installing system packages + Node.js 22"
if command -v apt-get >/dev/null; then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates build-essential python3 >/dev/null
  if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
    $SUDO apt-get install -y -qq nodejs >/dev/null
  fi
elif command -v dnf >/dev/null; then
  $SUDO dnf install -y -q git curl ca-certificates gcc-c++ make python3
  if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
    $SUDO dnf install -y -q nodejs
  fi
fi
command -v node >/dev/null && (( $(node -p 'process.versions.node.split(".")[0]') >= 22 )) \
  || die "Node.js 22+ is required — install it and re-run"
$SUDO corepack enable 2>/dev/null || true
ok "node $(node -v), git $(git --version | awk '{print $3}')"

# ---------------------------------------------------------------------------
step "Getting the code → $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git_tok "$TOKEN" -C "$INSTALL_DIR" pull --ff-only origin "$REPO_BRANCH" \
    || warn "couldn't update the code (local changes?) — kept what's there"
else
  git_tok "$TOKEN" clone -q --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" \
    || die "clone failed — is the GitHub token right, and does it have access to the repo?"
fi
cd "$INSTALL_DIR"
ok "$(git log -1 --format='%h %s')"

# ---------------------------------------------------------------------------
step "Configuring .env"
if [[ -n "$OLD_ENV" ]]; then
  [[ -f .env ]] && ! cmp -s "$OLD_ENV" .env && cp .env ".env.bak.$(date +%s)"
  cp "$OLD_ENV" .env
  ok "copied your .env"
else
  ok "kept existing .env"
fi
# Empty optional settings (Supabase, Pexels, …) must be unset, not "".
sed -i -E 's/^([A-Z_]+)=$/# \1=/' .env
chmod 600 .env

# ---------------------------------------------------------------------------
step "Installing backend packages"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error
ok "done"
if $SUDO ./node_modules/.bin/playwright install-deps chromium >/dev/null 2>&1 \
   && ./node_modules/.bin/playwright install chromium >/dev/null 2>&1; then
  ok "Chromium installed (for the page checks)"
else
  warn "Chromium not installed — page checks will be skipped, builds still work"
fi

step "Building the UI"
(cd ui && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)
ok "ui/dist ready"

# ---------------------------------------------------------------------------
step "Preparing data + target repo"
DB_PATH="$(env_get DB_PATH .env)";           DB_PATH="${DB_PATH:-./data/campaigns.db}"
SCRATCH="$(env_get WORKDIR_ROOT .env)";      SCRATCH="${SCRATCH:-./data/.scratch}"
mkdir -p "$(dirname "$DB_PATH")" "$SCRATCH" data/runs

if [[ -n "$OLD_DB" ]]; then
  [[ -f "$DB_PATH" ]] && mv "$DB_PATH" "$DB_PATH.bak.$(date +%s)"
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  cp "$OLD_DB" "$DB_PATH"
  for x in -wal -shm; do [[ -f "$OLD_DB$x" ]] && cp "$OLD_DB$x" "$DB_PATH$x"; done
  ok "imported run history"
fi

OWNER="$(env_get GITHUB_TARGET_OWNER .env)"; REPO="$(env_get GITHUB_TARGET_REPO .env)"
BRANCH="$(env_get GITHUB_BASE_BRANCH .env)"; BRANCH="${BRANCH:-main}"
URL="$(env_get TARGET_REPO_CLONE_URL .env)"; URL="${URL:-https://github.com/$OWNER/$REPO.git}"
TTOKEN="$(env_get GITHUB_TOKEN .env)";       TTOKEN="${TTOKEN:-$TOKEN}"
BASE="$SCRATCH/_base"
if [[ -d "$BASE/.git" ]]; then
  ok "target repo already cloned (the service syncs it each run)"
elif git_tok "$TTOKEN" clone -q --depth 1 --branch "$BRANCH" "$URL" "$BASE"; then
  ok "cloned $OWNER/$REPO@$BRANCH"
else
  warn "couldn't clone $URL — check GITHUB_TOKEN / GITHUB_BASE_BRANCH; the first run will retry"
fi
if [[ -f "$BASE/package.json" && ! -d "$BASE/node_modules" ]]; then
  PM="$(env_get PACKAGE_MANAGER_OVERRIDE .env)"
  if [[ -z "$PM" ]]; then
    if [[ -f "$BASE/pnpm-lock.yaml" ]]; then PM=pnpm; elif [[ -f "$BASE/yarn.lock" ]]; then PM=yarn; else PM=npm; fi
  fi
  echo "  installing the target repo's packages with $PM (a few minutes)…"
  [[ "$PM" == npm ]] && CMD=(npm install --no-audit --no-fund --loglevel=error) || CMD=(corepack "$PM" install)
  (cd "$BASE" && env -u NODE_ENV "${CMD[@]}" >/dev/null) && ok "done" \
    || warn "target repo install failed — each run will install on its own (slower)"
fi

# ---------------------------------------------------------------------------
step "Checking .env"
if CHECK="$(node --env-file=.env --input-type=module -e "await import('./src/config.mjs')" 2>&1)"; then
  ok "config is valid"
else
  echo "$CHECK" | sed 's/^/    /'
  warn "fix the settings above in $INSTALL_DIR/.env"
fi

echo
echo -e "\e[1;32mSetup finished.\e[0m"
for w in "${WARNINGS[@]}"; do echo -e "  \e[33m! $w\e[0m"; done
cat <<EOF

Start it:
  cd $INSTALL_DIR && npm start
  (UI for a quick look: cd $INSTALL_DIR/ui && npm run dev)
EOF
