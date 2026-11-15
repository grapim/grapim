# Grapim hub (the team cloud service). Zero npm dependencies: node:http,
# node:crypto and node:sqlite only, plus git for cloud workspaces. The SQLite
# file and the workspace folders live on a volume at HUB_DATA (/data). See
# docs/deploy.md.
FROM node:22-slim

ENV NODE_ENV=production \
    HUB_DATA=/data \
    PORT=8080 \
    TRUST_PROXY=1

WORKDIR /app

# git: every cloud workspace is a git repo (git init, ls-files, branches).
# ca-certificates: HTTPS to an S3 or R2 storage backend.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Only what the hub needs to run.
COPY package.json ./
COPY bin ./bin
COPY src ./src
# Cloud review (src/hub/github/cloud-review.js) posts with the review Action's formatting.
COPY action/review/index.mjs ./action/review/index.mjs
# The review desk, served for each cloud workspace at /w/<team>/<workspace>/.
COPY ui ./ui

# Normalise line endings (the repo may be checked out on Windows), make the
# app read-only for the runtime user, and prepare the data directory.
RUN sed -i 's/\r$//' /app/src/hub/entrypoint.sh \
 && rm -rf /app/ui/screenshots /app/ui/dev-server.mjs \
 && chmod 755 /app/src/hub/entrypoint.sh \
 && chown -R root:root /app && chmod -R a-w /app \
 && mkdir -p /data && chown node:node /data && chmod 700 /data

# The volume is attached in Railway (mount path /data); Railway rejects VOLUME here.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/hub/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Starts as root only to chown the mounted volume, then drops to the
# unprivileged `node` user (uid 1000) before the server starts.
ENTRYPOINT ["/app/src/hub/entrypoint.sh"]
