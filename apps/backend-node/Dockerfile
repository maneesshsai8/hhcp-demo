# HHCP Node API (NestJS + Fastify).
# BUILD FROM THE REPO ROOT so npm workspaces resolve:
#   docker build -f apps/backend-node/Dockerfile -t hhcp-backend-node .
# (docker-compose.yml sets context: . for you.)

# ---------- build stage ----------
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Manifests first for cached installs. Every workspace package.json is needed so
# `npm ci` can resolve the workspace graph.
COPY package.json package-lock.json ./
COPY apps/backend-node/package.json apps/backend-node/
COPY apps/backend-node-worker/package.json apps/backend-node-worker/
COPY apps/gateway/package.json apps/gateway/
COPY packages/db/package.json packages/db/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/contract-tests/package.json packages/contract-tests/
RUN npm ci

# Source needed to build the API (+ shared-types it may reference).
COPY apps/backend-node apps/backend-node
COPY packages/shared-types packages/shared-types
RUN npm run build -w @hhcp/backend-node

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=8001

# Reports use headless Chromium (Playwright). This makes the full PDF/PNG path
# work; without it the app still serves xlsx + the pdfkit PDF fallback.
# Comment this block out to slim the image (~400MB) if you don't need Chromium.
COPY --from=build /repo/node_modules ./node_modules
RUN npx playwright install --with-deps chromium \
    || echo "chromium install skipped — pdfkit fallback will be used for PDFs"

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/backend-node/package.json ./apps/backend-node/package.json
COPY --from=build /repo/apps/backend-node/dist ./apps/backend-node/dist

EXPOSE 8001
CMD ["node", "apps/backend-node/dist/main.js"]
