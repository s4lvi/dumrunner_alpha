# Game server image. Runs the @dumrunner/server workspace package on Fly.
#
# We don't pre-compile to dist — @dumrunner/shared resolves to its TS source
# at runtime, so we run the server through tsx (already a dev dep). For an
# alpha that scales to zero between sessions the JIT-on-boot cost is fine.
#
# Built from the repo root so the workspace topology is intact:
#   docker build -f packages/server/Dockerfile .
# Fly's `fly deploy` from packages/server/ does the same with the right
# build context (configured via fly.toml).

FROM node:22-slim

WORKDIR /app

# Install deps before copying source so layer caching survives source edits.
# Workspaces mean a single npm install at the root sets up shared + server.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
# Client package.json is included so npm install doesn't fail the workspace
# resolution. We don't copy its source / build it.
COPY packages/client/package.json ./packages/client/

RUN npm ci --no-audit --no-fund \
    -w @dumrunner/shared -w @dumrunner/server \
    --include-workspace-root

# Source last — invalidates only the smaller cache layer on edits.
COPY packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-http-header-size=65536
ENV GAME_SERVER_HOST=0.0.0.0
ENV GAME_SERVER_PORT=8070

EXPOSE 8070

# tsx loads the TS source directly — no compile step. Honors NODE_OPTIONS.
CMD ["npx", "tsx", "packages/server/src/index.ts"]
