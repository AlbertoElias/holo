#!/usr/bin/env bash
# The Quick Look tool check as a verify:pr step: record the walk take in
# capture, then run the conversion challenges on it, as the hosted
# "Quick Look tool check" job does.
#
# The check needs Python with the packages in
# apps/viewer-api/tools/requirements.txt. $USDZ_PYTHON picks the interpreter
# (default python3). When the interpreter or a package is missing, this step
# prints how to install them and passes without running: hosted CI is then the
# first run of the check. A failure of the check itself fails the step.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="${USDZ_PYTHON:-python3}"

if ! "${python}" -c 'import pxr, numpy, pygltflib, PIL' >/dev/null 2>&1; then
  echo "[usdz-tools] SKIPPED: ${python} cannot import pxr, numpy, pygltflib and PIL." >&2
  echo "[usdz-tools] The Quick Look tool check did not run. To run it locally:" >&2
  echo "[usdz-tools]   python3.11 -m venv ~/.venv-usdz" >&2
  echo "[usdz-tools]   ~/.venv-usdz/bin/pip install -r apps/viewer-api/tools/requirements.txt" >&2
  echo "[usdz-tools]   USDZ_PYTHON=~/.venv-usdz/bin/python3 pnpm run test:usdz-tools" >&2
  exit 0
fi

cd "${root}"
pnpm --filter @holoim/web run test:e2e:walk-take
USDZ_PYTHON="${python}" apps/viewer-api/tools/check_usdz_tools.sh
