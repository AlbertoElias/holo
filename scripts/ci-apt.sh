#!/usr/bin/env bash
# Runs an apt-backed install on a hosted runner with a time limit, and on a
# timeout or failure retries it once against archive.ubuntu.com (B-024).
#
# The runners' first mirror, azure.archive.ubuntu.com, sometimes serves at
# ~50 kB/s: a 26 MB Playwright system-library install then takes 8 minutes
# and the job reaches its timeout before any test runs. apt only fails over
# between mirrors on errors, not on slowness, so the retry drops that mirror.
#
# Usage: scripts/ci-apt.sh <seconds> <command...>
set -uo pipefail

limit="$1"
shift

if timeout --kill-after=10 "$limit" "$@"; then
  exit 0
fi
echo "::warning::'$*' failed or took over ${limit}s; retrying against archive.ubuntu.com"

for file in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*; do
  [ -f "$file" ] || continue
  if [ "$file" = /etc/apt/apt-mirrors.txt ]; then
    sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$file"
  else
    sudo sed -i 's#http://azure\.archive\.ubuntu\.com#http://archive.ubuntu.com#g' "$file"
  fi
done
# A killed install can leave dpkg mid-way; finish it before trying again.
sudo dpkg --configure -a || true
sudo apt-get update -o Acquire::Retries=3
timeout --kill-after=10 "$((limit * 2))" "$@"
