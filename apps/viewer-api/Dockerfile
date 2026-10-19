# Build context is the workspace root (see fly.toml at the repo root):
#   fly deploy -c fly.toml
# The API depends on workspace packages (@holoim/contracts), so the image
# builds inside the monorepo layout and runs the compiled output with plain
# Node — no tsx at runtime.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 python3-venv ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app
COPY . .

# Python stack for the USDZ converter (tools/glb_to_usdz.py).
RUN python3 -m venv /opt/usdz-venv \
  && /opt/usdz-venv/bin/pip install --no-cache-dir -r apps/viewer-api/tools/requirements.txt

RUN pnpm install --frozen-lockfile --filter @holoim/api...
RUN pnpm --filter @holoim/contracts build \
  && pnpm --filter @holoim/api build

ENV NODE_ENV=production \
  PORT=3001 \
  DATABASE_URL=file:/data/dev.db \
  UPLOADS_ROOT=/data/uploads \
  USDZ_PYTHON=/opt/usdz-venv/bin/python

EXPOSE 3001

# Migrations run at boot; the Prisma CLI stays in the image for this
# single-machine beta (documented tradeoff in docs/DEPLOYMENT.md).
CMD ["sh", "-c", "pnpm --filter @holoim/api exec prisma migrate deploy && node apps/viewer-api/dist/apps/viewer-api/src/server.js"]
