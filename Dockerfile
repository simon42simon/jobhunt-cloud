# syntax=docker/dockerfile:1
# RC-3 / SIM-87 I8 - one image, three deployments (design section 6), differentiated
# purely by env: laptop (FileStore, none of the cloud env), private (PgStore, real),
# demo (PgStore, fictional). Multi-stage: a NON-ROOT runtime with NO Python (finds
# come from the discovery_finds table in cloud, not discovery.py), and the
# node-pg-migrate release step runs before the server boots.
#
# BUILD CONTEXT NOTE: ssc-ui is a local workspace dependency (package.json:
# "ssc-ui": "file:../ssc-ui"). The build context must therefore contain an `ssc-ui/`
# directory (the clean-repo extraction, I9, vendors it). Build from a context where
# both this repo and ssc-ui are present.

# ---- builder: full deps + the Vite bundle ---------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
# argon2 compiles a native addon at install (node-gyp); slim lacks the toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY ssc-ui/ ./ssc-ui/
RUN npm ci
COPY . .
RUN npm run build

# ---- proddeps: a dev-free node_modules (no vite/vitest/embedded-postgres) --
FROM node:20-bookworm-slim AS proddeps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY ssc-ui/ ./ssc-ui/
RUN npm ci --omit=dev

# ---- runtime: non-root, NO Python, minimal --------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    JOBHUNT_HOST=0.0.0.0 \
    JOBHUNT_SERVE_BUILT=1
WORKDIR /app
RUN groupadd -r app && useradd -r -g app -m app
# Compiled prod node_modules (argon2 already built in proddeps - same base image).
COPY --chown=app:app --from=proddeps /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/dist ./dist
COPY --chown=app:app server ./server
COPY --chown=app:app demo ./demo
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app ops/migrate.mjs ops/reconcile-core.mjs ops/activity-log-lint.mjs ./ops/
COPY --chown=app:app docs ./docs
COPY --chown=app:app package.json ./package.json
# Ship the PLACEHOLDER config as config.json - never the owner's real vault path.
COPY --chown=app:app config.example.json ./config.json
USER app
EXPOSE 8787
# Liveness: hit /healthz (bypasses auth; cheap store round-trip -> 503 on a dead DB).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.JOBHUNT_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Release step: node-pg-migrate up (no-op without DATABASE_URL) THEN the server.
CMD ["npm", "run", "start:prod"]
