#!/usr/bin/env bash
# Local UI playground: API on :8443 with a throwaway demo dataset, Vite on :5173.
#
#   ./scripts/dev-ui.sh              # start (seeds demo data on first run)
#   DATA_DIR=/somewhere ./scripts/dev-ui.sh
#   DEMO_FORCE=1 ./scripts/dev-ui.sh # wipe the demo DB and reseed first
#
# Data lives outside the repo (default ~/.cache/chatpulse-ui) so it never touches
# the real database. Ctrl+C stops both processes. Nothing here deploys anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$HOME/.cache/chatpulse-ui}"
export PORT="${PORT:-8443}"
export ADMIN_USERNAMES="${ADMIN_USERNAMES:-demo}"
export MAIL_ENABLED=0
export NODE_ENV=development
# the server resolves certs relative to its own directory; be explicit
export CERT_PATH="${CERT_PATH:-$ROOT/certs/cert.pem}"
export KEY_PATH="${KEY_PATH:-$ROOT/certs/key.pem}"

mkdir -p "$DATA_DIR"

if [[ ! -f "$DATA_DIR/chatpulse.db" || "${DEMO_FORCE:-0}" == "1" ]]; then
  echo "→ seeding demo data into $DATA_DIR"
  ( cd "$ROOT" && DEMO_FORCE="${DEMO_FORCE:-0}" npm run demo -w server --silent )
fi

cleanup() {
  echo
  echo "→ stopping"
  kill "${SERVER_PID:-}" "${VITE_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "→ API   https://localhost:$PORT"
( cd "$ROOT/server" && exec npx tsx watch src/index.ts ) &
SERVER_PID=$!

echo "→ Vite  http://localhost:5173"
( cd "$ROOT/web" && exec npx vite --host 127.0.0.1 ) &
VITE_PID=$!

cat <<EOF

  UI playground ready:  http://localhost:5173
  login:                demo / demopass123
  data:                 $DATA_DIR

EOF

wait
