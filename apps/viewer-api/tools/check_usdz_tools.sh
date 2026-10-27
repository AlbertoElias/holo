#!/usr/bin/env bash
# Quick Look tool check: the source-derived conversion challenges
# (exercise_usdz.py) on a real capture export, outside the e2e pipeline.
#
# Usage: check_usdz_tools.sh [captured.glb] [artifact-directory]
#   captured.glb defaults to $USDZ_TOOLS_GLB, then to the walk take the
#   pipeline specs record (output/pipeline-takes/walk.glb). Nothing is
#   committed: record it first with the capture-to-viewer pipeline spec.
#   $USDZ_PYTHON picks the interpreter (default python3).
set -euo pipefail

tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${tools}/../../.." && pwd)"
glb="${1:-${USDZ_TOOLS_GLB:-${root}/output/pipeline-takes/walk.glb}}"
out="${2:-${root}/output/quicklook/tools-check}"

if [ ! -s "${glb}" ]; then
  echo "check_usdz_tools: no capture GLB at ${glb}." >&2
  echo "Record one with the pipeline (apps/viewer-web e2e/capture-to-viewer.pipeline.spec.ts) or pass a path." >&2
  exit 2
fi

rm -rf "${out}"
mkdir -p "${out}"
"${USDZ_PYTHON:-python3}" "${tools}/exercise_usdz.py" "${glb}" "${out}"
echo "check_usdz_tools: passed on ${glb}; report ${out}/exercise-summary.json"
