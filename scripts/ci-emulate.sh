#!/usr/bin/env bash
# Runs a command in a Linux container sized like a public repository's hosted
# CI runner (4 CPUs, 16 GB, Node 24, Chromium with its system libraries), against a copy of the
# current working tree including uncommitted edits. Use it when a failure seen
# on CI does not reproduce with the tests run directly on this machine.
#
#   scripts/ci-emulate.sh pnpm run test:xr:viewer
#   CI_EMULATE_CPUS=0 scripts/ci-emulate.sh pnpm run test:xr:capture
#
# CPUs are pinned with --cpuset-cpus rather than --cpus so the harness sees
# 4 CPUs (os.availableParallelism) and picks the same concurrency as CI.
# The pnpm store, Playwright browsers and the Quick Look tools' virtualenv
# live in named volumes, so only the first run downloads them. Outputs are copied back to output/ci-emulate/.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/ci-emulate.sh <command...>" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cpus="${CI_EMULATE_CPUS:-0-3}"
# A hosted runner has 16 GB; Docker Desktop may have less, and two emulations
# at once then overcommit it (crashed pages, navigation timeouts). Run one at
# a time, or lower this.
memory="${CI_EMULATE_MEMORY:-16g}"
image="${CI_EMULATE_IMAGE:-node:24-bookworm}"
pnpm_version="$(sed -n 's/^  PNPM_VERSION: //p' "$root/.github/workflows/ci.yml")"
out="$root/output/ci-emulate"
mkdir -p "$out"

printf -v cmd '%q ' "$@"

docker run --rm --init \
  --cpuset-cpus="$cpus" --memory="$memory" --shm-size=2g \
  -e CI=true -e HOME=/root \
  -v "$root":/src:ro \
  -v "$out":/out \
  -v holoim-ci-pnpm-store:/root/.local/share/pnpm/store \
  -v holoim-ci-playwright:/root/.cache/ms-playwright \
  -v holoim-ci-usdz-venv:/root/.venv-usdz \
  "$image" bash -euo pipefail -c "
    apt-get update -qq >/dev/null
    # rsync for the copy; Python and ffmpeg for the Quick Look conversion the
    # pipeline checks run, as CI's pipeline job installs them.
    apt-get install -y -qq rsync python3-venv ffmpeg >/dev/null
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
    [ -x /root/.venv-usdz/bin/python3 ] || python3 -m venv /root/.venv-usdz
    /root/.venv-usdz/bin/pip install -q -r apps/viewer-api/tools/requirements.txt
    export PATH=/root/.venv-usdz/bin:\$PATH
    status=0
    ${cmd} || status=\$?
    for d in output apps/*/output apps/*/test-results apps/*/playwright-report; do
      [ -d \"\$d\" ] && mkdir -p \"/out/\$d\" && cp -a \"\$d/.\" \"/out/\$d/\"
    done
    exit \$status
  "
