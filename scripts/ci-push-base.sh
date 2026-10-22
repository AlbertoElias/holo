#!/usr/bin/env bash
# Print the base commit a main-branch workflow should diff against so that
# scripts/ci-changed-areas.sh sees every change since that workflow last
# succeeded on main, not just the last commit or the last push.
#
# Usage: ci-push-base.sh <workflow-file> [head] [fallback] [event]
#   workflow-file  e.g. ci.yml or deploy.yml
#   head           defaults to HEAD
#   fallback       printed when no successful run is usable (for example the
#                  push's `before` SHA); default empty, which makes
#                  ci-changed-areas.sh select every area.
#   event          only count runs triggered by this event (deploy passes
#                  workflow_run, so a partial manual redeploy is never a base)
#
# A successful run's head is used only when it is an ancestor of head, so a
# rewritten main falls back instead of diffing unrelated history. Diffing from
# the last success (rather than HEAD^ or the push's `before`) also covers
# merge commits, multi-commit pushes, and pushes whose own run was cancelled
# by a newer push or failed. Needs `gh` with GH_TOKEN and `actions: read`.
set -euo pipefail

workflow="${1:?usage: ci-push-base.sh <workflow-file> [head] [fallback] [event]}"
head="${2:-HEAD}"
fallback="${3:-}"
event="${4:-}"

head_sha="$(git rev-parse --verify "${head}^{commit}")"

if ! shas="$(gh run list --workflow "${workflow}" --branch main --status success \
  ${event:+--event "${event}"} --limit 20 --json headSha --jq '.[].headSha' 2>/dev/null)"; then
  echo "ci-push-base: could not list ${workflow} runs; using fallback" >&2
  shas=""
fi

while IFS= read -r sha; do
  [ -z "${sha}" ] && continue
  if git merge-base --is-ancestor "${sha}" "${head_sha}" 2>/dev/null; then
    echo "ci-push-base: last successful ${workflow} on main was ${sha}" >&2
    echo "${sha}"
    exit 0
  fi
done <<EOF
${shas}
EOF

echo "ci-push-base: no usable successful ${workflow} run; using fallback '${fallback}'" >&2
echo "${fallback}"
