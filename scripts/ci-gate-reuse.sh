#!/usr/bin/env bash
# On a push to main, turn off the suites that a green gate run already passed
# on the same tree (docs/features/hosted-branch-gate.md).
#
# Usage: ci-gate-reuse.sh <areas-file> [head]
#   areas-file  the key=true|false lines of scripts/ci-changed-areas.sh
#   head        defaults to HEAD
#
# Prints the same keys, changed, plus quality_checks, reused_run and
# reused_suites (write stdout to $GITHUB_OUTPUT). A gate run is a push run of
# ci.yml on refs/heads/gate/<tree> (pnpm run verify:hosted); its changes job
# fails unless <tree> is the tree it checked out, and this script also reads
# the tree of the run's commit. The same tree holds the same ci.yml, so the
# gate ran the jobs this run would run. Only a run that finished in the last
# 24 hours counts: the runner image, action tags and cached tools are not in
# the tree.
#
# A suite is reused only when the gate run's conclusion is success and every
# job of the suite in it concluded success (at least one). A suite the gate
# skipped, a job name this script does not know, or any lookup error reuses
# nothing: the suite runs. Reused quality turns off lint, typecheck, unit
# tests and the shard check (quality_checks=false); the quality job still
# runs, for its build, when a deploy needs the viewer or capture bundle.
# Needs `gh` with GH_TOKEN and `actions: read`.
set -uo pipefail

areas_file="${1:?usage: ci-gate-reuse.sh <areas-file> [head]}"
head="${2:-HEAD}"

# Each key becomes a variable area_<key> (no associative arrays: macOS bash 3.2).
order=""
while IFS='=' read -r key value; do
  case "${key}" in
    ""|*[!a-z0-9_]*) continue ;;
  esac
  printf -v "area_${key}" '%s' "${value}"
  order="${order} ${key}"
done <"${areas_file}"

get() { local name="area_$1"; echo "${!name:-}"; }
off() { printf -v "area_$1" '%s' false; }

print() {
  local key
  for key in ${order}; do echo "${key}=$(get "${key}")"; done
  echo "quality_checks=${quality_checks}"
  echo "reused_run=${reused_run}"
  echo "reused_suites=${reused_suites}"
}

quality_checks=true
reused_run=""
reused_suites=""

if ! tree="$(git rev-parse --verify --quiet "${head}^{tree}")"; then
  echo "ci-gate-reuse: cannot read the tree of ${head}; nothing reused" >&2
  print
  exit 0
fi

# Newest first, on the exact ref, finished in the last 24 hours.
since="$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"
if ! runs="$(gh run list --workflow ci.yml --branch "gate/${tree}" --event push --status success --limit 20 \
  --json databaseId,headSha,updatedAt \
  --jq ".[] | select(.updatedAt >= \"${since}\") | \"\(.databaseId) \(.headSha)\"" 2>/dev/null)"; then
  echo "ci-gate-reuse: could not list gate runs; nothing reused" >&2
  print
  exit 0
fi

run=""
while read -r id sha; do
  [ -z "${id}" ] && continue
  if [ "$(gh api "repos/{owner}/{repo}/git/commits/${sha}" --jq .tree.sha 2>/dev/null)" = "${tree}" ]; then
    run="${id}"
    break
  fi
  echo "ci-gate-reuse: gate run ${id} is on gate/${tree} but its commit has another tree; skipped" >&2
done <<EOF
${runs}
EOF

if [ -z "${run}" ]; then
  echo "ci-gate-reuse: no green gate run for tree ${tree} in the last 24 hours" >&2
  print
  exit 0
fi

if ! jobs="$(gh run view "${run}" --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"' 2>/dev/null)"; then
  echo "ci-gate-reuse: could not read the jobs of gate run ${run}; nothing reused" >&2
  print
  exit 0
fi

# True when the gate run has at least one job whose name starts with $1 and
# every such job succeeded.
passed() {
  local prefix="$1" seen=0 conclusion name
  while IFS=$'\t' read -r conclusion name; do
    case "${name}" in
      "${prefix}"*)
        seen=1
        [ "${conclusion}" = "success" ] || return 1 ;;
    esac
  done <<EOF
${jobs}
EOF
  [ "${seen}" = 1 ]
}

reuse() {
  reused_suites="${reused_suites:+${reused_suites},}$1"
}

# Job names as in ci.yml (a renamed job matches nothing here, so it runs).
if [ "$(get capture_xr)" = true ] && passed "Capture XR checks"; then
  off capture_xr; reuse capture_xr
fi
# The e2e area runs the viewer and Knowledge shards and the viewer VR shards.
if [ "$(get e2e)" = true ] && passed "Viewer and Knowledge browser checks" \
  && passed "Viewer VR gallery, foot controls and locomotion"; then
  off e2e; reuse e2e
fi
if [ "$(get pipeline)" = true ] && passed "Capture to viewer pipeline"; then
  off pipeline; reuse pipeline
fi
if [ "$(get portal)" = true ] && passed "Portal view end-to-end"; then
  off portal; reuse portal
fi
if [ "$(get usdz_tools)" = true ] && passed "Quick Look tool check"; then
  off usdz_tools; reuse usdz_tools
fi
if [ "$(get quality)" = true ] && passed "Quality, unit tests and build"; then
  quality_checks=false; reuse quality
  # The deploys take their bundles from this run's quality build.
  if [ "$(get web)" != true ] && [ "$(get capture_app)" != true ]; then
    off quality
  fi
fi

if [ -n "${reused_suites}" ]; then
  reused_run="${run}"
  echo "ci-gate-reuse: gate run ${run} passed tree ${tree}; reused: ${reused_suites}" >&2
else
  echo "ci-gate-reuse: gate run ${run} passed tree ${tree}, but no selected suite passed there" >&2
fi
print
