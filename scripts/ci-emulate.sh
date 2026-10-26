#!/usr/bin/env bash
# Runs a command in a Linux container sized like a hosted CI runner (4 CPUs,
# 16 GB, Node 24, Chromium with its system libraries), against a copy of the
# current working tree including uncommitted edits. Use it when a failure seen
# on CI does not reproduce with the tests run directly on this machine.
#
#   scripts/ci-emulate.sh pnpm run test:xr:viewer
#   CI_EMULATE_CPUS=0 scripts/ci-emulate.sh pnpm run test:xr:capture
#
# CPUs are pinned with --cpuset-cpus rather than --cpus so the harness sees
# 4 CPUs (os.availableParallelism) and picks the same concurrency as CI.
# Docker Desktop must be given at least 16 GB for the memory limit to hold.
# The pnpm store and Playwright browsers live in named volumes, so only the
# first run downloads them. The browser volume is per image architecture:
# Playwright skips an install it finds marked complete, even for another one.
# Outputs are copied back to output/ci-emulate/.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/ci-emulate.sh <command...>" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cpus="${CI_EMULATE_CPUS:-0-3}"
image="${CI_EMULATE_IMAGE:-node:24-bookworm}"
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
arch="$(docker image inspect "$image" --format '{{.Architecture}}')"
pnpm_version="$(sed -n 's/^  PNPM_VERSION: //p' "$root/.github/workflows/ci.yml")"
out="$root/output/ci-emulate"
mkdir -p "$out"

printf -v cmd '%q ' "$@"

docker_mem="$(docker info --format '{{.MemTotal}}')"
if [ "$docker_mem" -lt $((15 * 1024 * 1024 * 1024)) ]; then
  echo "ci-emulate: Docker has $((docker_mem / 1024 / 1024)) MB; the runner has 16 GB," \
    "so memory-bound failures may differ. Raise it in Docker Desktop settings." >&2
fi

docker run --rm --init \
  --cpuset-cpus="$cpus" --memory=16g --shm-size=2g \
  -e CI=true -e HOME=/root \
  -v "$root":/src:ro \
  -v "$out":/out \
  -v holoim-ci-pnpm-store:/root/.local/share/pnpm/store \
  -v "holoim-ci-playwright-$arch":/root/.cache/ms-playwright \
  "$image" bash -euo pipefail -c "
    apt-get update -qq >/dev/null && apt-get install -y -qq rsync >/dev/null
    rsync -a --exclude node_modules --exclude .worktrees --exclude output \
      --exclude .git --exclude 'apps/*/output' --exclude 'apps/*/dist' \
      --exclude 'apps/*/test-results' /src/ /work/
    cd /work
    corepack enable >/dev/null
    corepack prepare pnpm@${pnpm_version} --activate >/dev/null
    pnpm install --frozen-lockfile
    cp apps/viewer-api/.env.example apps/viewer-api/.env
    pnpm --filter @holoim/api prisma:generate
    pnpm --filter @holoim/capture exec playwright install --with-deps chromium
    status=0
    ${cmd} || status=\$?
    for d in output apps/*/output apps/*/test-results apps/*/playwright-report; do
      [ -d \"\$d\" ] && mkdir -p \"/out/\$d\" && cp -a \"\$d/.\" \"/out/\$d/\"
    done
    exit \$status
  "
