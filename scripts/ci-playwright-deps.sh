#!/usr/bin/env bash
# Installs only the Chromium system libraries the hosted runner lacks.
#
# `playwright install-deps` always runs `apt-get update` and reinstalls its
# whole package list, so every browser job paid an apt round trip (14 s) and,
# on a slow azure mirror, up to 3.5 minutes (B-024). The ubuntu-24.04 runner
# image already carries almost all of these libraries for its preinstalled
# Chrome, so this asks Playwright for its list, keeps the packages dpkg does
# not report as installed, and runs apt (through ci-apt.sh) only for those.
#
# Usage: scripts/ci-playwright-deps.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# The dry run prints the apt command it would run, ending in the package list.
plan="$(cd "$root" && pnpm --filter @holoim/capture exec playwright install-deps --dry-run chromium)"
packages="$(sed -n 's/.*apt-get install -y --no-install-recommends //p' <<<"${plan}" | tr -d '"' | tr ' ' '\n' | sed '/^$/d')"
if [ -z "${packages}" ]; then
  echo "ci-playwright-deps: could not read Playwright's package list; installing it all" >&2
  exec "$root/scripts/ci-apt.sh" 180 pnpm --filter @holoim/capture exec playwright install-deps chromium
fi

missing=()
while IFS= read -r package; do
  if ! dpkg-query -W -f='${Status}' "${package}" 2>/dev/null | grep -q 'install ok installed'; then
    missing+=("${package}")
  fi
done <<<"${packages}"

if [ "${#missing[@]}" -eq 0 ]; then
  echo "ci-playwright-deps: all $(wc -l <<<"${packages}" | tr -d ' ') Chromium system packages already installed"
  exit 0
fi

echo "ci-playwright-deps: installing ${#missing[@]} missing package(s): ${missing[*]}"
"$root/scripts/ci-apt.sh" 180 sudo sh -c "apt-get update && apt-get install -y --no-install-recommends ${missing[*]}"
