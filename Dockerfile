# syntax=docker/dockerfile:1
#
# Multi-stage build for the Praxis backend.
#   deps      → full install (incl. devDeps) for the build
#   build     → tsup bundle to dist/server.js (ESM; runtime deps stay external)
#   prod-deps → production-only node_modules for the runtime image
#   runtime   → slim, non-root image running the bundled server
#
# The default PERSISTENCE=memory makes the image fully self-contained — no database
# is required to boot. Secrets (e.g. GOV_API_KEY) are supplied at run time via the
# environment, never baked into the image.

# ---- Base: pinned Node LTS + pnpm via corepack ----
FROM node:25-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin pnpm to the version used to author the lockfile (lockfileVersion 9.0). pnpm 10+ treats
# pnpm-workspace.yaml as config-only (overrides/allowBuilds) without requiring a `packages:` field,
# which this single-package repo relies on.
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app

# ---- Full dependency install (cached on lockfile) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# No BuildKit cache mount here: Railway's Metal builder rejects a cache-mount `id`
# without its own cacheKey prefix, and a Railway-specific id would break plain
# `docker build` and CI. A plain install keeps the Dockerfile portable everywhere.
RUN pnpm install --frozen-lockfile

# ---- Build the ESM bundle ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- Production-only dependencies for the runtime layer ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

# ---- Runtime: slim, non-root ----
FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json carries "type": "module" so node treats dist/server.js as ESM.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Drop privileges: the stock `node` user owns nothing it can write outside /tmp.
USER node
EXPOSE 8080

# Liveness probe hits the in-process health endpoint (ledger-chain integrity check).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
