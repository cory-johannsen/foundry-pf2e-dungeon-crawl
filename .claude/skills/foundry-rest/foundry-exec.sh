#!/usr/bin/env bash
# Run JavaScript inside a live Foundry VTT world through the foundryrestapi.com
# relay, and print what it returns.
#
#   foundry-exec.sh script.js
#   echo 'return game.actors.size;' | foundry-exec.sh
#   foundry-exec.sh -c script.js          # also print the client it used
#
# Needs FOUNDRY_REST_API_KEY, from the environment or a .env in the working
# directory. FOUNDRY_BASE_URL and FOUNDRY_CLIENT_ID override the defaults.
#
# Exits non-zero when the relay refuses the script or the script throws, so it
# can be used in a chain without checking the output by eye.
set -uo pipefail

BASE="${FOUNDRY_BASE_URL:-https://foundryrestapi.com}"
SHOW_CLIENT=0
[ "${1:-}" = "-c" ] && { SHOW_CLIENT=1; shift; }

# A .env in the working directory is the usual home for the key. Sourced only
# for the variables wanted, rather than executed wholesale.
if [ -z "${FOUNDRY_REST_API_KEY:-}" ] && [ -f .env ]; then
  FOUNDRY_REST_API_KEY=$(grep -E '^FOUNDRY_REST_API_KEY=' .env | head -1 | cut -d= -f2-)
fi
if [ -z "${FOUNDRY_REST_API_KEY:-}" ]; then
  echo "foundry-exec: no FOUNDRY_REST_API_KEY in the environment or ./.env" >&2
  exit 2
fi

SCRIPT=$(cat "${1:-/dev/stdin}")
[ -n "$SCRIPT" ] || { echo "foundry-exec: nothing to run" >&2; exit 2; }

# The relay scans the raw source for forbidden text before running it, and does
# not parse it first — so a banned word inside a string or a comment is refused
# just the same. Catching the common ones here gives a useful message instead
# of "Script contains forbidden patterns".
BANNED='globalThis|import\(|eval\(|new Function|XMLHttpRequest|game\.settings\.set|apiKey|password|localStorage|sessionStorage'
HIT=$(printf '%s' "$SCRIPT" | grep -oE "$BANNED" | sort -u | tr '\n' ' ')
if [ -n "$HIT" ]; then
  echo "foundry-exec: the relay will refuse this — remove: $HIT" >&2
  echo "  (it scans the text, so strings and comments count; rename variables)" >&2
  exit 2
fi

CLIENT="${FOUNDRY_CLIENT_ID:-}"
if [ -z "$CLIENT" ]; then
  CLIENT=$(curl -s -m 20 "$BASE/clients" -H "x-api-key: $FOUNDRY_REST_API_KEY" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        let j; try { j = JSON.parse(d) } catch { process.exit(1) }
        const list = j.clients ?? [];
        const c = list.find(x => x.isOnline) ?? list[0];
        if (!c) process.exit(1);
        process.stdout.write(c.clientId);
      })") || { echo "foundry-exec: no Foundry client registered with the relay" >&2; exit 3; }
fi
[ "$SHOW_CLIENT" = 1 ] && echo "client: $CLIENT" >&2

BODY=$(node -e 'console.log(JSON.stringify({ script: process.argv[1] }))' "$SCRIPT")
RESPONSE=$(curl -s -m "${FOUNDRY_TIMEOUT:-300}" -X POST "$BASE/execute-js?clientId=$CLIENT" \
  -H "x-api-key: $FOUNDRY_REST_API_KEY" -H "Content-Type: application/json" -d "$BODY")

printf '%s' "$RESPONSE" | node -e "
let d = '';
process.stdin.on('data', c => d += c).on('end', () => {
  let j;
  try { j = JSON.parse(d) } catch { console.error('foundry-exec: unreadable reply: ' + d.slice(0, 300)); process.exit(4) }
  // A refusal by the relay carries no 'success' field; a script that threw
  // carries success:false. They need different exit codes because they call
  // for different fixes — reconnect, versus correct the code.
  if (j.success === false) { console.error('foundry-exec: script threw: ' + (j.error ?? 'unknown')); process.exit(5) }
  // 'Invalid client ID' usually means the module's socket dropped rather than
  // that the id is wrong; the same id works again once it reconnects.
  if (j.error) { console.error('foundry-exec: ' + j.error); process.exit(3) }
  console.log(JSON.stringify(j.result, null, 1));
});
"
