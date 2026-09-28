# Backend — the Express + LangGraph orchestrator service (src/server.mjs).
# Never bakes in .env/secrets; those come from the environment at run time
# (docker-compose's env_file / environment:).
FROM node:22-bookworm-slim

# git: this service shells out to real git (base clone + per-run
#   `git worktree`, see src/git/clone-and-commit.mjs) — no library, no shim.
# ca-certificates: HTTPS clone of the target repo + calls to the Gemini/
#   Claude/GitHub APIs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Lets the target repo's own yarn/pnpm be fetched on demand (verify/preview
# run ITS package manager, not necessarily npm) without baking every one of
# them into this image up front.
RUN corepack enable

WORKDIR /app

# `playwright` is a regular dependency (used by verify/check-hero-visibility.mjs
# etc.), and its postinstall downloads a full Chromium build by default. This
# image deliberately ships without it (see runbook.md §7) — build/lint still
# gates every run, and the three browser checks just report SKIPPED. Run
# `npx playwright install chromium` inside the container later if you want
# them to actually execute.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY post.sh ./

RUN useradd --create-home --shell /bin/bash app \
    && mkdir -p /app/data \
    && chown -R app:app /app
USER app

ENV NODE_ENV=production
EXPOSE 4300

# Matches GET /healthz (src/server.mjs) — no auth required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4300/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly, NOT `npm start` (which uses `--env-file=.env`) — in a
# container, config comes from the process environment (compose's env_file/
# environment:), not a .env file baked into the image.
CMD ["node", "src/server.mjs"]
