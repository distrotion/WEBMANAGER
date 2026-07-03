#!/usr/bin/env bash
# Start WEBMANAGER (backend + nginx) on macOS / Linux.
#   WEBMANAGER_ROOT / PORT can be overridden via env.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$DIR/backend"
export WEBMANAGER_ROOT="${WEBMANAGER_ROOT:-$HOME/webmanager-dev}"
export PORT="${PORT:-8088}"
mkdir -p "$WEBMANAGER_ROOT"
PIDFILE="$WEBMANAGER_ROOT/manager.pid"

start_manager() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "• manager already running (pid $(cat "$PIDFILE"))"
  else
    ( cd "$BACKEND" && nohup node src/server.js > "$WEBMANAGER_ROOT/manager.log" 2>&1 & echo $! > "$PIDFILE" )
    sleep 1
    echo "• manager started  → http://localhost:$PORT   (log: $WEBMANAGER_ROOT/manager.log)"
  fi
}

start_nginx() {
  local prefix="$WEBMANAGER_ROOT/nginx" conf="$WEBMANAGER_ROOT/nginx/conf/nginx.conf"
  if ! command -v nginx >/dev/null 2>&1; then echo "• nginx not installed (brew install nginx) — skipped"; return; fi
  if [ ! -f "$conf" ]; then echo "• nginx conf not generated yet — skipped (deploy a site to create it)"; return; fi
  if nginx -p "$prefix" -c "$conf" -t >/dev/null 2>&1; then
    nginx -p "$prefix" -c "$conf" -s reload 2>/dev/null || nginx -p "$prefix" -c "$conf"
    echo "• nginx started/reloaded"
  else
    echo "• nginx config test failed — check the panel logs"
  fi
}

echo "Starting WEBMANAGER (root=$WEBMANAGER_ROOT)"
start_manager
sleep 1
start_nginx
