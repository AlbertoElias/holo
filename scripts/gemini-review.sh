#!/usr/bin/env bash
# Run a read-only design review with Gemini's Neon model on the owner's subscription,
# through the Antigravity CLI (`agy`). The Gemini CLI no longer serves subscribers.
#
# Usage: scripts/gemini-review.sh <prompt-file> [workdir]
#   The prompt file holds the full review brief. Name files and images by path
#   (relative to workdir, default: the current folder) and ask the reviewer to read them.
#
# Exit codes:
#   0   The review is on stdout.
#   75  Gemini cannot review now: agy is not installed, no usage left, not signed in,
#       or no Neon model. Use the Claude `design-reviewer` subagent instead.
#   64  Bad arguments.
#   1   Any other failure (message on stderr).
#
# Env: GEMINI_REVIEW_MODEL sets the model slug (default gemini-4-neon-high).
#      GEMINI_REVIEW_TIMEOUT sets the time limit (default 15m).
set -uo pipefail

prompt_file="${1:-}"
workdir="${2:-$PWD}"
if [[ -z "$prompt_file" || ! -f "$prompt_file" ]]; then
  echo "gemini-review: give the path of a prompt file." >&2
  exit 64
fi

agy_bin="$(command -v agy || true)"
[[ -z "$agy_bin" && -x "$HOME/.local/bin/agy" ]] && agy_bin="$HOME/.local/bin/agy"
if [[ -z "$agy_bin" ]]; then
  echo "gemini-review: the Antigravity CLI (agy) is not installed. Use the Claude design-reviewer." >&2
  exit 75
fi

# Subscription only: an API key must never switch the CLI to paid API billing.
unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI GOOGLE_CLOUD_PROJECT AGY_ADC_AUTH

model="${GEMINI_REVIEW_MODEL:-gemini-4-neon-high}"
if ! "$agy_bin" models 2>/dev/null | grep -q -F -- "$model"; then
  echo "gemini-review: model $model is not available (sign in to agy with the subscription account). Use the Claude design-reviewer." >&2
  exit 75
fi

out="$(mktemp)"; err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# Headless agy soft-denies a shell command that needs approval, and the turn can
# then end with no text. So the reviewer reads with its file and image tools only.
rules='Rules for this review: use only your file read, search and image view tools. Do not run shell or terminal commands; this mode blocks them. End your turn with the full review as your reply text.'

run_agy() { # $1 = prompt text, then extra agy flags
  local text="$1"; shift
  (
    cd "$workdir" || exit 1
    "$agy_bin" -p "$text" --model "$model" --mode plan "$@" \
      --output-format json --print-timeout "${GEMINI_REVIEW_TIMEOUT:-15m}" </dev/null
  ) >"$out" 2>"$err"
}

check_quota() {
  if grep -q -i -E 'quota|resource_exhausted|rate.?limit|429|usage limit|out of credits|authentication required|not signed in|sign in' "$err" "$out"; then
    echo "gemini-review: Gemini has no usage left or is not signed in ($model). Use the Claude design-reviewer." >&2
    exit 75
  fi
}

# Prints the field $2 of the JSON result in file $1 ("" when absent or not JSON).
json_field() {
  python3 -I -c '
import json, sys
t = open(sys.argv[1], encoding="utf-8").read()
try:
    d = json.loads(t[t.index("{"):])
except Exception:
    sys.exit(0)
print((d.get(sys.argv[2]) or "").strip())
' "$1" "$2"
}

run_agy "$(cat "$prompt_file")

$rules"
status=$?
check_quota

# An empty reply (for example after a denied command): resume the same
# conversation once and ask for the review.
if [[ -z "$(json_field "$out" response)" ]]; then
  conv="$(json_field "$out" conversation_id)"
  if [[ -n "$conv" ]]; then
    run_agy "Do not run any commands. Write the full review now, from what you already read. $rules" --conversation "$conv"
    status=$?
    check_quota
  fi
fi

python3 -I -c '
import json, sys
path, model = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
try:
    data = json.loads(text[text.index("{"):])
except Exception:
    sys.stderr.write("gemini-review: agy gave no JSON result.\n")
    sys.exit(1)
if data.get("status") != "SUCCESS" or data.get("error"):
    sys.stderr.write("gemini-review: status %s: %s\n" % (data.get("status"), data.get("error")))
    sys.exit(1)
resp = (data.get("response") or "").strip()
if not resp:
    sys.stderr.write("gemini-review: the review is empty.\n")
    sys.exit(1)
print(f"<!-- reviewer: Gemini {model} via agy -->")
print(resp)
' "$out" "$model"
py=$?
if [[ $py -ne 0 ]]; then
  sed -n '1,20p' "$err" >&2
fi
[[ $py -ne 0 && $status -eq 0 ]] && exit 1
exit $py
