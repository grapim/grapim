# Grapim hub (the team cloud service). Zero npm dependencies: node:http,
# node:crypto and node:sqlite only. The SQLite file lives on a volume at
# HUB_DATA (/data). See docs/deploy.md.
FROM node:22-slim

ENV NODE_ENV=production \
    HUB_DATA=/data \
    PORT=8080 \
    TRUST_PROXY=1

WORKDIR /app

# Only what the hub needs to run.
COPY package.json ./
COPY bin ./bin
COPY src ./src

# Normalise line endings (the repo may be checked out on Windows), make the
# app read-only for the runtime user, and prepare the data directory.
RUN sed -i 's/\r$//' /app/src/hub/entrypoint.sh \
 && chmod 755 /app/src/hub/entrypoint.sh \
 && chown -R root:root /app && chmod -R a-w /app \
 && mkdir -p /data && chown node:node /data && chmod 700 /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/hub/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Starts as root only to chown the mounted volume, then drops to the
# unprivileged `node` user (uid 1000) before the server starts.
ENTRYPOINT ["/app/src/hub/entrypoint.sh"]
