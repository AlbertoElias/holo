#!/usr/bin/env bash
# Installs ffmpeg (the Quick Look conversion's audio path) on a hosted runner
# without an apt mirror on the path when warm.
#
# ffmpeg pulls about 90 packages; from a slow azure mirror that took 30-70 s
# per job (run 40612369043) and once a whole timeout (B-024). Its .deb files
# are kept in DEB_CACHE (an actions/cache path, keyed by runner image), so a
# warm runner installs them with dpkg; a cold one downloads them with apt
# straight into the cache.
#
# Usage: DEB_CACHE=<dir> scripts/ci-ffmpeg.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cache="${DEB_CACHE:-}"

if command -v ffmpeg >/dev/null; then
  echo "ci-ffmpeg: $(command -v ffmpeg) already installed"
  exit 0
fi

if [ -n "${cache}" ] && compgen -G "${cache}/*.deb" >/dev/null; then
  echo "ci-ffmpeg: installing from ${cache}"
  if sudo dpkg -i "${cache}"/*.deb >/dev/null && command -v ffmpeg >/dev/null; then
    exit 0
  fi
  # A newer runner image may need a package the cache never held.
  echo "::warning::cached ffmpeg .deb install failed; falling back to apt"
  sudo dpkg --configure -a || true
fi

archives=""
if [ -n "${cache}" ]; then
  # apt downloads straight into the cache, so it holds exactly this install.
  mkdir -p "${cache}/partial"
  archives="-o Dir::Cache::archives=${cache}"
fi
"$root/scripts/ci-apt.sh" 240 sudo sh -c "apt-get update && apt-get install -y --no-install-recommends ${archives} ffmpeg"
[ -z "${cache}" ] || sudo chown -R "$(id -u):$(id -g)" "${cache}"
command -v ffmpeg >/dev/null
