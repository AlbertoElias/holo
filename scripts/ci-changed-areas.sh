#!/usr/bin/env bash
# Print the CI/deploy areas touched between two commits as key=true|false
# lines (append stdout to $GITHUB_OUTPUT in Actions).
#
# Usage: ci-changed-areas.sh [base] [head]
#   base omitted, all-zero, or unreachable -> every area (fail closed).
#   head defaults to HEAD.
#
# Each file selects only the suites that actually exercise it, and the apps
# whose build it changes. Docs, CI/deploy workflows, shell scripts and tool
# configuration have no suite, so they select nothing (the changes job itself
# runs the selection scripts on every push; dispatch CI to exercise an edited
# job). Lockfile changes alter every app's dependencies and select every
# area; unclassified files fail closed the same way. Keep this mapping in sync
# with the jobs in .github/workflows/ci.yml and deploy.yml.
set -euo pipefail

base="${1:-}"
head="${2:-HEAD}"

quality=false
capture_xr=false
e2e=false
pipeline=false
portal=false
api=false
web=false
capture_app=false
docs_only=false

all() {
  quality=true; capture_xr=true; e2e=true; pipeline=true; portal=true
  api=true; web=true; capture_app=true
}

if [ -z "${base}" ] || [ "${base}" = "0000000000000000000000000000000000000000" ] \
  || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "ci-changed-areas: no usable base; selecting all areas" >&2
  all
else
  files="$(git diff --name-only "${base}" "${head}")"
  if [ -z "${files}" ]; then
    echo "ci-changed-areas: no changed files" >&2
  fi
  saw_code=false
  saw_docs=false
  saw_plumbing=false
  while IFS= read -r file; do
    [ -z "${file}" ] && continue
    case "${file}" in
      # Knowledge content/code is an app surface, not plain documentation.
      apps/knowledge/*)
        saw_code=true; quality=true; e2e=true ;;
      *.md|docs/*)
        saw_docs=true ;;
      apps/capture/*)
        saw_code=true; quality=true; capture_xr=true; pipeline=true; portal=true; capture_app=true ;;
      apps/viewer-web/*)
        saw_code=true; quality=true; e2e=true; pipeline=true; portal=true; web=true ;;
      apps/viewer-api/*)
        saw_code=true; quality=true; pipeline=true; api=true ;;
      apps/*)
        saw_code=true; all ;;
      packages/avatar-face/*|packages/contracts/*|packages/tooling-testing/*|packages/ui-dom/*|packages/xr-*)
        saw_code=true; quality=true; capture_xr=true; e2e=true; pipeline=true; portal=true
        api=true; web=true; capture_app=true ;;
      packages/*)
        saw_code=true; quality=true ;;
      # The API image: nothing tests it before the deploy health check.
      fly.toml|.dockerignore)
        saw_code=true; api=true ;;
      # Lint, typecheck and tooling unit tests cover these.
      scripts/*.ts|tsconfig*.json|eslint.config.*)
        saw_code=true; quality=true ;;
      pnpm-lock.yaml)
        saw_code=true; all ;;
      # No suite exercises these: CI/deploy workflows and actions, shell and
      # Node scripts, agent tooling, editor and package-manager settings.
      # (Dependency edits in package.json or pnpm-workspace.yaml also change
      # pnpm-lock.yaml, which selects everything.)
      .github/*|scripts/*|.agents/*|.claude/*|.codex/*|.vscode/*|.mcp.json \
        |.gitignore|.npmrc|.nvmrc|package.json|pnpm-workspace.yaml)
        saw_plumbing=true ;;
      *)
        echo "ci-changed-areas: unclassified file '${file}'; selecting all areas" >&2
        saw_code=true; all ;;
    esac
  done <<EOF
${files}
EOF
  if [ "${saw_code}" = "false" ] && [ "${saw_docs}" = "true" ] \
    && [ "${saw_plumbing}" = "false" ]; then
    docs_only=true
  fi
fi

cat <<EOF
quality=${quality}
capture_xr=${capture_xr}
e2e=${e2e}
pipeline=${pipeline}
portal=${portal}
api=${api}
web=${web}
capture_app=${capture_app}
docs_only=${docs_only}
EOF
