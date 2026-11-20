#!/usr/bin/env bash
# Run a read-only design review with Gemini's Neon model on the owner's subscription.
#
# Usage: scripts/gemini-review.sh <prompt-file> [workdir]
#   The prompt file holds the full review brief. Name files with @path to give
#   Gemini a file or an image (paths relative to workdir, default: the current folder).
#
# Exit codes:
#   0   The review is on stdout.
#   75  Gemini cannot review now: no usage left, not signed in, or no Neon model.
#       Use the Claude `design-reviewer` subagent instead.
#   64  Bad arguments.
#   1   Any other failure (message on stderr).
#
# Env: GEMINI_REVIEW_MODEL forces a model id. GEMINI_REVIEW_TIMEOUT sets seconds (default 900).
set -uo pipefail

prompt_file="${1:-}"
workdir="${2:-$PWD}"
if [[ -z "$prompt_file" || ! -f "$prompt_file" ]]; then
  echo "gemini-review: give the path of a prompt file." >&2
  exit 64
fi
if ! command -v gemini >/dev/null 2>&1; then
  echo "gemini-review: the gemini CLI is not installed. Use the Claude design-reviewer." >&2
  exit 75
fi

# Subscription only: an API key must never switch the CLI to paid API billing.
unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI GOOGLE_CLOUD_PROJECT

model="${GEMINI_REVIEW_MODEL:-}"
if [[ -z "$model" ]]; then
  model="$(gemini --list-models 2>/dev/null | grep -o -i -E '^[a-z0-9.-]*neon[a-z0-9.-]*' | head -1)"
fi
if [[ -z "$model" ]]; then
  echo "gemini-review: no Neon model is available (sign in with the subscription account). Use the Claude design-reviewer." >&2
  exit 75
fi

out="$(mktemp)"; err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT
(
  cd "$workdir" || exit 1
  # wall-clock: a review has no condition to wait on; the timeout only stops a hung CLI.
  timeout "${GEMINI_REVIEW_TIMEOUT:-900}" gemini -m "$model" --approval-mode plan -o json -p "$(cat "$prompt_file")" </dev/null
) >"$out" 2>"$err"
status=$?

if grep -q -i -E 'quota|resource_exhausted|rate.?limit|429|usage limit|daily limit|not authenticated|login required|sign in' "$err" "$out"; then
  echo "gemini-review: Gemini has no usage left or is not signed in ($model). Use the Claude design-reviewer." >&2
  exit 75
fi

python3 -I - "$out" "$model" <<'PY'
import json, sys
path, model = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
try:
    data = json.loads(text[text.index("{"):])
except Exception:
    sys.stderr.write("gemini-review: the CLI gave no JSON result.\n")
    sys.exit(1)
if data.get("error"):
    sys.stderr.write(f"gemini-review: {data['error']}\n")
    sys.exit(1)
resp = (data.get("response") or "").strip()
if not resp:
    sys.stderr.write("gemini-review: the review is empty.\n")
    sys.exit(1)
print(f"<!-- reviewer: Gemini {model} -->")
print(resp)
PY
py=$?
if [[ $py -ne 0 && $status -ne 0 ]]; then
  sed -n '1,20p' "$err" >&2
fi
exit $py
