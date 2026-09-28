#!/usr/bin/env bash
# Sets up the landing-page automation service (new_approach) on a fresh
# device or VPS, WITHOUT Docker:
#
#   1. system packages (git, curl, build tools) + Node.js >= 22 + corepack
#   2. clone (or update) this service's own repo
#   3. .env — copied from the old machine, or seeded from .env.example
#   4. backend deps (npm ci) + optional Playwright Chromium for the browser checks
#   5. UI deps (npm ci) + production build (ui/dist)
#   6. data/ dirs, optional import of the old campaigns.db
#   7. the shared target-repo clone at WORKDIR_ROOT/_base + its node_modules
#      (exactly what src/pipeline/steps/04-clone-target-repo.mjs would do on
#      the first run — done up front so the first campaign isn't slow)
#   8. validates .env against src/config.mjs
#
# Never runs `docker build` / `docker compose`.
#
# Usage:
#   ./setup.sh [options]
#   curl -fsSL <raw url>/setup.sh | bash -s -- [options]
#
# Options:
#   --dir PATH            install location          (default: ~/landing-automation)
#   --repo URL            this service's git repo   (default: $APP_REPO_URL below)
#   --branch NAME         branch of that repo       (default: main)
#   --env PATH            .env to copy in (e.g. scp'd from the old machine)
#   --db PATH             campaigns.db to import (its -wal/-shm are copied too)
#   --fresh-base          delete and re-clone data/.scratch/_base
#   --skip-system         don't apt/dnf install anything or touch Node
#   --skip-playwright     don't install Chromium (hero-fit/SEO/a11y checks report SKIPPED)
#   --skip-base           don't pre-clone the target repo (first run will do it)
#   --skip-ui             don't install/build the UI
#   -h, --help
#
# Private repos: export GITHUB_TOKEN (or APP_REPO_TOKEN for the service repo
# only) before running. The token is passed to git via an HTTP header in the
# environment — never on the command line and never written to .git/config.
set -euo pipefail

APP_REPO_URL="https://github.com/arafatrahman-aspire/landing-automation.git"
APP_BRANCH="main"
INSTALL_DIR="$HOME/landing-automation"
ENV_SRC=""
DB_SRC=""
FRESH_BASE=false
SKIP_SYSTEM=false
SKIP_PLAYWRIGHT=false
SKIP_BASE=false
SKIP_UI=false
NODE_MAJOR_MIN=22

# --- output helpers ---
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { echo; echo "${B}==> $*${N}"; }
ok()   { echo "${G}  ✓${N} $*"; }
warn() { echo "${Y}  ! $*${N}" >&2; WARNINGS+=("$*"); }
die()  { echo "${R}  ✗ $*${N}" >&2; exit 1; }
WARNINGS=()

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --repo) APP_REPO_URL="$2"; shift 2 ;;
    --branch) APP_BRANCH="$2"; shift 2 ;;
    --env) ENV_SRC="$(realpath "$2")"; shift 2 ;;
    --db) DB_SRC="$(realpath "$2")"; shift 2 ;;
    --fresh-base) FRESH_BASE=true; shift ;;
    --skip-system) SKIP_SYSTEM=true; shift ;;
    --skip-playwright) SKIP_PLAYWRIGHT=true; shift ;;
    --skip-base) SKIP_BASE=true; shift ;;
    --skip-ui) SKIP_UI=true; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ -n "$ENV_SRC" && ! -f "$ENV_SRC" ]] && die "--env file not found: $ENV_SRC"
[[ -n "$DB_SRC" && ! -f "$DB_SRC" ]] && die "--db file not found: $DB_SRC"

SUDO=""
if [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null && SUDO="sudo" || SUDO="__nosudo__"
fi
as_root() {
  [[ "$SUDO" == "__nosudo__" ]] && die "need root for: $* (install sudo or run as root, or pass --skip-system)"
  $SUDO "$@"
}

# Runs git with a GitHub token supplied as an HTTP header via env vars, so it
# never shows up in `ps` or gets persisted in the clone's remote URL.
git_auth() {
  local token="$1"; shift
  if [[ -n "$token" ]]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $basic" \
      git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# Reads KEY from a dotenv file without sourcing/exporting it (so secrets never
# leak into the env of npm installs run inside the target repo).
env_get() {
  local key="$1" file="$2" line val
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n1 || true)"
  [[ -z "$line" ]] && return 0
  val="${line#*=}"
  val="${val%%[[:space:]]#*}"                      # trailing " # comment"
  val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]] && val="${BASH_REMATCH[1]}"
  printf '%s' "$val"
}

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# ---------------------------------------------------------------------------
step "1/8  System prerequisites"
if $SKIP_SYSTEM; then
  ok "skipped (--skip-system)"
else
  if command -v apt-get >/dev/null; then
    as_root apt-get update -y
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg build-essential python3
  elif command -v dnf >/dev/null; then
    as_root dnf install -y git curl ca-certificates gcc-c++ make python3
  elif command -v yum >/dev/null; then
    as_root yum install -y git curl ca-certificates gcc-c++ make python3
  else
    warn "unknown package manager — make sure git, curl and a C/C++ toolchain are installed"
  fi

  if (( $(node_major) < NODE_MAJOR_MIN )); then
    echo "  Node $(node -v 2>/dev/null || echo 'not installed') found; installing Node 22 LTS (needs node:sqlite + --env-file)"
    if command -v apt-get >/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
      as_root apt-get install -y nodejs
    elif command -v dnf >/dev/null || command -v yum >/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | as_root bash -
      as_root "$(command -v dnf || command -v yum)" install -y nodejs
    else
      die "install Node.js >= $NODE_MAJOR_MIN manually, then re-run with --skip-system"
    fi
  fi
  # Target repos may pin yarn/pnpm via packageManager; the service runs them through corepack.
  if command -v corepack >/dev/null; then
    corepack enable 2>/dev/null || as_root corepack enable || warn "corepack enable failed — yarn/pnpm target repos won't install"
  fi
fi
command -v git >/dev/null || die "git is not installed"
(( $(node_major) >= NODE_MAJOR_MIN )) || die "Node.js >= $NODE_MAJOR_MIN required, found $(node -v 2>/dev/null || echo none)"
ok "git $(git --version | awk '{print $3}'), node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------------
step "2/8  Service repo → $INSTALL_DIR"
APP_TOKEN="${APP_REPO_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "  existing checkout found — fast-forwarding $APP_BRANCH"
  git_auth "$APP_TOKEN" -C "$INSTALL_DIR" fetch origin "$APP_BRANCH"
  git -C "$INSTALL_DIR" checkout "$APP_BRANCH"
  git -C "$INSTALL_DIR" merge --ff-only "origin/$APP_BRANCH" \
    || warn "local changes/divergence in $INSTALL_DIR — left as is, not updated"
elif [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  die "$INSTALL_DIR exists and is not an empty git checkout — pick another --dir"
else
  git_auth "$APP_TOKEN" clone --branch "$APP_BRANCH" "$APP_REPO_URL" "$INSTALL_DIR" \
    || die "clone failed — for a private repo, export GITHUB_TOKEN (or APP_REPO_TOKEN) first"
fi
cd "$INSTALL_DIR"
[[ -f package.json && -f src/server.mjs ]] || die "$INSTALL_DIR doesn't look like the new_approach service (no src/server.mjs)"
ok "at $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"

# ---------------------------------------------------------------------------
step "3/8  .env"
if [[ -n "$ENV_SRC" ]]; then
  if [[ -f .env ]] && ! cmp -s "$ENV_SRC" .env; then
    cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
    ok "backed up existing .env"
  fi
  cp "$ENV_SRC" .env
  ok "copied $ENV_SRC"
elif [[ -f .env ]]; then
  ok "keeping existing .env"
else
  cp .env.example .env
  warn ".env created from .env.example — fill in the API keys/secrets, then re-run (or run 'npm start')"
fi
chmod 600 .env

DB_PATH="$(env_get DB_PATH .env)";                 DB_PATH="${DB_PATH:-./data/campaigns.db}"
WORKDIR_ROOT="$(env_get WORKDIR_ROOT .env)";       WORKDIR_ROOT="${WORKDIR_ROOT:-./data/.scratch}"
OWNER="$(env_get GITHUB_TARGET_OWNER .env)"
REPO="$(env_get GITHUB_TARGET_REPO .env)"
BASE_BRANCH="$(env_get GITHUB_BASE_BRANCH .env)";  BASE_BRANCH="${BASE_BRANCH:-main}"
CLONE_URL="$(env_get TARGET_REPO_CLONE_URL .env)"
TARGET_TOKEN="$(env_get GITHUB_TOKEN .env)";       TARGET_TOKEN="${TARGET_TOKEN:-${GITHUB_TOKEN:-}}"
PM_OVERRIDE="$(env_get PACKAGE_MANAGER_OVERRIDE .env)"
APP_PUBLIC_URL="$(env_get APP_PUBLIC_URL .env)"
PORT="$(env_get PORT .env)";                       PORT="${PORT:-4300}"
[[ -z "$CLONE_URL" && -n "$OWNER" && -n "$REPO" ]] && CLONE_URL="https://github.com/$OWNER/$REPO.git"

# ---------------------------------------------------------------------------
step "4/8  Backend dependencies"
# Browsers are installed explicitly below (or not at all), never as a side effect of npm ci.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
ok "node_modules installed"

if $SKIP_PLAYWRIGHT; then
  ok "Playwright Chromium skipped — hero-fit/SEO/a11y checks will report SKIPPED"
else
  if ! $SKIP_SYSTEM && [[ "$SUDO" != "__nosudo__" ]]; then
    as_root "$PWD/node_modules/.bin/playwright" install-deps chromium \
      || warn "playwright install-deps failed — Chromium may be missing system libraries"
  fi
  ./node_modules/.bin/playwright install chromium && ok "Chromium installed for Playwright" \
    || warn "Chromium install failed — browser checks will report SKIPPED (build/lint still gate runs)"
fi

# ---------------------------------------------------------------------------
step "5/8  UI"
if $SKIP_UI; then
  ok "skipped (--skip-ui)"
else
  (cd ui && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund && npm run build)
  ok "ui/dist built"
fi

# ---------------------------------------------------------------------------
step "6/8  Data directories"
mkdir -p "$(dirname "$DB_PATH")" "$WORKDIR_ROOT" data/runs
if [[ -n "$DB_SRC" ]]; then
  if [[ -f "$DB_PATH" ]]; then
    cp "$DB_PATH" "$DB_PATH.bak.$(date +%Y%m%d%H%M%S)"
    ok "backed up existing $DB_PATH"
  fi
  # A WAL-mode DB is only complete together with its -wal file; stop the old
  # service before copying so the three files are consistent.
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  cp "$DB_SRC" "$DB_PATH"
  for ext in -wal -shm; do [[ -f "$DB_SRC$ext" ]] && cp "$DB_SRC$ext" "$DB_PATH$ext"; done
  ok "imported $DB_SRC → $DB_PATH"
  warn "imported runs still reference the OLD machine's worktree paths — those drafts' previews/approvals may need re-running"
fi
ok "DB_PATH=$DB_PATH, WORKDIR_ROOT=$WORKDIR_ROOT"

# ---------------------------------------------------------------------------
step "7/8  Target repo base clone ($WORKDIR_ROOT/_base)"
BASE_DIR="$WORKDIR_ROOT/_base"
if $SKIP_BASE; then
  ok "skipped (--skip-base) — the first campaign run will clone it"
elif [[ -z "$CLONE_URL" ]]; then
  warn "GITHUB_TARGET_OWNER/GITHUB_TARGET_REPO not set in .env — base clone skipped"
else
  if $FRESH_BASE && [[ -d "$BASE_DIR" ]]; then
    # Per-run worktrees hang off _base; they're useless without it.
    find "$WORKDIR_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    ok "removed old $WORKDIR_ROOT contents (--fresh-base)"
  fi
  if [[ -d "$BASE_DIR/.git" ]]; then
    echo "  existing base clone — syncing $BASE_BRANCH"
    git_auth "$TARGET_TOKEN" -C "$BASE_DIR" fetch --depth 1 origin "$BASE_BRANCH" \
      && git -C "$BASE_DIR" checkout -q "$BASE_BRANCH" \
      && git -C "$BASE_DIR" reset -q --hard "origin/$BASE_BRANCH" \
      || warn "base sync failed — the service will retry on its next run"
  else
    # Same shape as cloneShallow() in src/git/clone-and-commit.mjs. The
    # service rewrites origin with its own auth (setRemoteAuth) on each run.
    git_auth "$TARGET_TOKEN" clone --depth 1 --branch "$BASE_BRANCH" "$CLONE_URL" "$BASE_DIR" \
      || die "could not clone $CLONE_URL@$BASE_BRANCH — check GITHUB_TOKEN / GITHUB_BASE_BRANCH in .env"
  fi
  ok "$(git -C "$BASE_DIR" log -1 --format='%h %s')"

  # Mirror ensureSharedNodeModules() (src/verify/reuse-base-install.mjs):
  # one install in _base that every run's worktree symlinks.
  PKG_DIR="$BASE_DIR"
  if [[ ! -f "$PKG_DIR/package.json" ]]; then
    PKG_DIR="$(find "$BASE_DIR" -mindepth 2 -maxdepth 2 -name package.json -not -path '*/node_modules/*' -printf '%h\n' | head -n1)"
  fi
  if [[ -z "$PKG_DIR" ]]; then
    warn "no package.json in the target repo — skipping its dependency install"
  elif [[ -d "$PKG_DIR/node_modules" ]] && ! $FRESH_BASE; then
    ok "target repo node_modules already present"
  else
    PM="$PM_OVERRIDE"
    if [[ -z "$PM" ]]; then
      PM="$(node -p "(require('$PKG_DIR/package.json').packageManager||'').split('@')[0]" 2>/dev/null || true)"
      if [[ -z "$PM" ]]; then
        if   [[ -f "$PKG_DIR/pnpm-lock.yaml" ]]; then PM=pnpm
        elif [[ -f "$PKG_DIR/yarn.lock" ]];      then PM=yarn
        else PM=npm; fi
      fi
    fi
    echo "  installing target repo deps with $PM (this can take several minutes)"
    # Clean env: no NODE_ENV=production (would drop devDeps needed by next build).
    case "$PM" in
      npm)  (cd "$PKG_DIR" && env -u NODE_ENV npm install --no-audit --no-fund) ;;
      yarn) (cd "$PKG_DIR" && env -u NODE_ENV corepack yarn install) ;;
      pnpm) (cd "$PKG_DIR" && env -u NODE_ENV corepack pnpm install) ;;
      *)    warn "unknown package manager '$PM' — skipping"; false ;;
    esac && ok "target repo node_modules installed ($PM)" \
      || warn "target repo install failed — each run will install inside its own worktree instead (slower)"
  fi
fi

# ---------------------------------------------------------------------------
step "8/8  Validate configuration"
CHECK_OUT="$(mktemp)"
if node --env-file=.env --input-type=module -e "await import('./src/config.mjs')" >"$CHECK_OUT" 2>&1; then
  ok ".env passes src/config.mjs validation"
else
  sed 's/^/    /' "$CHECK_OUT" >&2
  warn ".env does not validate yet — fix the fields above before 'npm start'"
fi
rm -f "$CHECK_OUT"
for k in SSO_CLIENT_SECRET APP_PUBLIC_URL CMS_PUBLIC_URL; do
  [[ -z "$(env_get "$k" .env)" ]] && warn "$k is empty — CMS login won't work (see docs/cms-auth.md)"
done
[[ -n "$APP_PUBLIC_URL" && "$APP_PUBLIC_URL" == *localhost* ]] && \
  warn "APP_PUBLIC_URL still points at localhost — set it to this server's public origin"

# ---------------------------------------------------------------------------
echo
echo "${B}${G}Setup finished${N} in $INSTALL_DIR"
if (( ${#WARNINGS[@]} )); then
  echo "${Y}${#WARNINGS[@]} warning(s):${N}"
  for w in "${WARNINGS[@]}"; do echo "  - $w"; done
fi
cat <<EOF

Next steps:
  cd $INSTALL_DIR
  npm start                                  # backend on :$PORT  (not 'npm run dev' during real runs)
  curl localhost:$PORT/healthz               # {"ok":true}
  npm test                                   # optional: full test suite

  UI: ui/dist is a static build. Serve it with nginx (see ui/nginx.conf — proxy
  /api/ → http://127.0.0.1:$PORT/ with the /api prefix stripped), or for a quick
  look run 'cd ui && npm run dev' (binds to APP_PUBLIC_URL's host/port).
EOF
