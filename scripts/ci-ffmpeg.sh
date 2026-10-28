#!/usr/bin/env bash
# Installs ffmpeg and ffprobe (the Quick Look conversion's audio path and its
# inspector's check of it) as pinned static binaries, so no apt mirror is on
# the path (B-024).
#
# apt's ffmpeg pulls about 90 packages; from a slow azure mirror that took
# 30-70 s per job (run 40612369043) and once a whole 20-minute timeout. The
# static builds are two checksummed GitHub release assets (~29 MB gzipped each), kept
# in FFMPEG_CACHE (an actions/cache path in CI, a named volume in
# scripts/ci-emulate.sh), so a warm install is a gunzip and a cold one a
# download from GitHub's CDN.
#
# Usage: FFMPEG_CACHE=<dir> scripts/ci-ffmpeg.sh
# Installs into FFMPEG_BIN_DIR (default /usr/local/bin, already on PATH).
set -euo pipefail

# eugeneware/ffmpeg-static release b6.1.1, which ships John Van Sickle's
# static ffmpeg 7.0.2 Linux builds; the digests match the release API's.
release="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
declare -A sha256
case "$(uname -m)" in
  x86_64)
    arch=x64
    sha256[ffmpeg]=bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa
    sha256[ffprobe]=25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067
    ;;
  aarch64 | arm64)
    arch=arm64
    sha256[ffmpeg]=754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0
    sha256[ffprobe]=2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8
    ;;
  *) echo "ci-ffmpeg: no pinned build for $(uname -m)" >&2; exit 1 ;;
esac

cache="${FFMPEG_CACHE:-${HOME}/.cache/ffmpeg-static}"
bin_dir="${FFMPEG_BIN_DIR:-/usr/local/bin}"
sudo=""
[ -w "${bin_dir}" ] || sudo="sudo"
mkdir -p "${cache}"

for tool in ffmpeg ffprobe; do
  asset="${tool}-linux-${arch}.gz"
  archive="${cache}/${asset}"
  if [ -f "${archive}" ] && echo "${sha256[${tool}]}  ${archive}" | sha256sum --check --status; then
    echo "ci-ffmpeg: using cached ${asset}"
  else
    echo "ci-ffmpeg: downloading ${asset}"
    curl -fsSL --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
      -o "${archive}.part" "${release}/${asset}"
    if ! echo "${sha256[${tool}]}  ${archive}.part" | sha256sum --check --status; then
      rm -f "${archive}.part"
      echo "ci-ffmpeg: ${asset} does not match its pinned sha256" >&2
      exit 1
    fi
    mv "${archive}.part" "${archive}"
  fi
  gunzip -c "${archive}" > "${cache}/${tool}"
  ${sudo} install -m 0755 "${cache}/${tool}" "${bin_dir}/${tool}"
  rm -f "${cache}/${tool}"
  "${bin_dir}/${tool}" -hide_banner -version | head -n 1
done
