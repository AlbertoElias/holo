# Build context is the workspace root (see fly.toml at the repo root):
#   fly deploy -c fly.toml
# The API depends on workspace packages (@holoim/contracts), so the image
# builds inside the monorepo layout and runs the compiled output with plain
# Node — no tsx at runtime.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 python3-venv ffmpeg curl bzip2 \
  && rm -rf /var/lib/apt/lists/*

# KTX-Software (toktx), which the processing worker uses to serve KTX2
# textures (hologram-budgets Q4); the same release CI and ci-emulate install.
RUN case "$(uname -m)" in aarch64) ktx_arch=arm64 ;; *) ktx_arch=x86_64 ;; esac \
  && mkdir -p /opt/ktx \
  && curl -fsSL "https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-${ktx_arch}.tar.bz2" \
    | tar -xj -C /opt/ktx --strip-components=1 \
  && /opt/ktx/bin/toktx --version

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

WORKDIR /app
COPY . .

# Python stack for the USDZ converter (tools/glb_to_usdz.py).
RUN python3 -m venv /opt/usdz-venv \
  && /opt/usdz-venv/bin/pip install --no-cache-dir -r apps/viewer-api/tools/requirements.txt

RUN pnpm install --frozen-lockfile --filter @holoim/api...
RUN pnpm --filter @holoim/contracts build \
  && pnpm --filter @holoim/objects build \
  && pnpm --filter @holoim/api build

ENV NODE_ENV=production \
  PORT=3001 \
  DATABASE_URL=file:/data/dev.db \
  UPLOADS_ROOT=/data/uploads \
  USDZ_PYTHON=/opt/usdz-venv/bin/python \
  TOKTX_PATH=/opt/ktx/bin/toktx \
  LD_LIBRARY_PATH=/opt/ktx/lib

EXPOSE 3001

# Migrations run at boot, but only when the database lacks one this image
# ships (scripts/start.mjs); the Prisma CLI stays in the image for this
# single-machine beta (documented tradeoff in docs/DEPLOYMENT.md).
CMD ["node", "apps/viewer-api/scripts/start.mjs"]
