#!/usr/bin/env bash
# A standing upload token for the agent creator account, kept in the macOS
# Keychain (docs/features/archive/agent-upload-token.md).
#
#   scripts/agent-upload-token.sh setup  <api origin> --email <agent email> [--name "Claude (agent-authored)"]
#   scripts/agent-upload-token.sh revoke <api origin>
#   scripts/agent-upload-token.sh list   <api origin>
#
# setup makes the token here, registers only its SHA-256 hash with the API's
# database (production: through `fly ssh console`; a loopback origin: the
# local API's database), and only then stores the token in the Keychain
# (service holoim-agent-upload, account = the API host). The token never
# prints, never leaves this Mac, and reaches `security` on stdin, not argv.
# revoke deletes the API's row and the Keychain entry. Run setup once per API
# host; agents then upload with `showcase:upload --api <origin>` and no env var.
set -euo pipefail

SERVICE="${HOLOIM_KEYCHAIN_SERVICE:-holoim-agent-upload}"
FLY_APP="${HOLOIM_FLY_APP:-holoim-api}"
REMOTE_CLI="node /app/apps/viewer-api/dist/apps/viewer-api/src/agent-token.js"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  sed -n '5,7p' "$0" | sed 's/^# //' >&2
  exit 1
}

[ $# -ge 2 ] || usage
command="$1"
origin="$2"
shift 2
email=""
name="Claude (agent-authored)"
while [ $# -gt 0 ]; do
  case "$1" in
    --email) email="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

# The same host string upload.mjs looks up (URL.host, lowercased).
read -r host hostname protocol < <(node -e '
  const u = new URL(process.argv[1]);
  console.log(u.host.toLowerCase(), u.hostname.toLowerCase(), u.protocol);
' "$origin")
origin="$protocol//$host"
case "$hostname" in
  localhost | 127.0.0.1 | "[::1]") local_api=1 ;;
  *) local_api=0 ;;
esac
if [ "$local_api" = 0 ] && [ "$protocol" != "https:" ]; then
  echo "A remote API must be https: $origin" >&2
  exit 1
fi

# Runs the agent-token CLI against the API's database.
agent_token() {
  if [ "$local_api" = 1 ]; then
    (cd "$ROOT/apps/viewer-api" && ./node_modules/.bin/tsx src/agent-token.ts "$@")
  else
    # The machine stops when idle (fly.toml); a request starts it for ssh.
    curl -fsS -o /dev/null --max-time 60 "$origin/healthz" || { echo "$origin/healthz did not answer" >&2; exit 1; }
    local quoted=""
    for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
    fly ssh console -a "$FLY_APP" -C "sh -c $(printf '%q' "$REMOTE_CLI$quoted")"
  fi
}

keychain_token() {
  security find-generic-password -s "$SERVICE" -a "$host" -w 2>/dev/null
}

sha256_hex() {
  # printf is a builtin: the value never appears in a process list, and %s adds no newline.
  printf %s "$1" | shasum -a 256 | cut -d' ' -f1
}

case "$command" in
  setup)
    [ -n "$email" ] || { echo "--email <agent account email> is required." >&2; exit 1; }
    if keychain_token >/dev/null; then
      echo "The Keychain already has a token for $host. Run: $0 revoke $origin, then setup again." >&2
      exit 1
    fi
    token="holoim_at_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
    agent_token register --email "$email" --name "$name" --hash "$(sha256_hex "$token")" --label "agent uploads ($host)"
    # Only a registered token is kept. -U replaces a stale entry for this host.
    # security -i echoes a failing command line, token included, so its output
    # is discarded and the result checked by reading the entry back.
    printf 'add-generic-password -U -s "%s" -a "%s" -l "HoloIM agent upload (%s)" -w "%s"\n' "$SERVICE" "$host" "$host" "$token" | security -i >/dev/null 2>&1 || true
    if ! keychain_token >/dev/null; then
      unset token
      echo "Could not store the token in the Keychain; it is registered but unusable. Revoke it with: $0 list $origin, then agent-token revoke --id <id> on the API host." >&2
      exit 1
    fi
    unset token
    echo "Stored in the Keychain as $SERVICE / $host. Checking it:"
    HOLOIM_SESSION="" HOLOIM_KEYCHAIN_SERVICE="$SERVICE" node "$ROOT/apps/capture/scripts/showcase/upload.mjs" --api "$origin" --whoami
    ;;
  revoke)
    if ! token="$(keychain_token)"; then
      echo "No Keychain token for $host. To revoke one by id: $0 list $origin, then agent-token revoke --id <id> on the API host." >&2
      exit 1
    fi
    agent_token revoke --hash "$(sha256_hex "$token")"
    unset token
    security delete-generic-password -s "$SERVICE" -a "$host" >/dev/null 2>&1
    echo "Removed the Keychain entry $SERVICE / $host."
    ;;
  list)
    agent_token list
    ;;
  *)
    usage
    ;;
esac
