# HHCP outbox worker — separate process (analysis §12).
# BUILD FROM THE REPO ROOT:
#   docker build -f apps/backend-node-worker/Dockerfile -t hhcp-worker .
# Runs via tsx (no build step) and imports the framework-agnostic helpers from
# apps/backend-node/src, so that source must be present in the image.

FROM node:20-bookworm-slim
WORKDIR /repo

# Manifests for the workspace graph.
COPY package.json package-lock.json ./
COPY apps/backend-node/package.json apps/backend-node/
COPY apps/backend-node-worker/package.json apps/backend-node-worker/
COPY apps/gateway/package.json apps/gateway/
COPY packages/db/package.json packages/db/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/contract-tests/package.json packages/contract-tests/
# Include devDependencies — the worker runs through `tsx`.
RUN npm ci

# The worker + the shared helpers it reuses.
COPY apps/backend-node-worker apps/backend-node-worker
COPY apps/backend-node/src apps/backend-node/src
COPY apps/backend-node/tsconfig.json apps/backend-node/tsconfig.json

CMD ["npm", "start", "-w", "@hhcp/backend-node-worker"]
