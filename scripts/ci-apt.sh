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

# Runs the command in its own process group and, past the limit, kills the
# whole group: a wrapper (pnpm, playwright) killed alone leaves its sudo
# apt-get running and holding the dpkg lock, and the retry then fails on it.
run_limited() {
  local seconds="$1"
  shift
  setsid "$@" &
  local group=$!
  # The watchdog ticks rather than sleeping once, so it ends within a second
  # of the command and leaves nothing behind holding the step's output open.
  (
    for ((tick = 0; tick < seconds; tick++)); do
      sleep 1
      kill -0 "$group" 2>/dev/null || exit 0
    done
    echo "::warning::'$*' passed ${seconds}s; stopping its process group"
    sudo kill -TERM -- "-$group" 2>/dev/null
    sleep 10
    sudo kill -KILL -- "-$group" 2>/dev/null
  ) &
  local watchdog=$!
  wait "$group"
  local status=$?
  wait "$watchdog" 2>/dev/null
  return "$status"
}

if run_limited "$limit" "$@"; then
  exit 0
fi
echo "::warning::'$*' failed or took over ${limit}s; retrying against archive.ubuntu.com"

# Wait out anything still holding the dpkg lock, and have the retry's apt-get
# wait for it too rather than failing at once.
for _ in $(seq 1 90); do
  sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
  sleep 2
done
echo 'DPkg::Lock::Timeout "180";' | sudo tee /etc/apt/apt.conf.d/99ci-lock-timeout >/dev/null

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
run_limited "$((limit * 2))" "$@"
