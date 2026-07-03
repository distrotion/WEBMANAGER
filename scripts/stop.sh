#!/usr/bin/env bash
# Stop WEBMANAGER (nginx + backend) on macOS / Linux.
set -uo pipefail

export WEBMANAGER_ROOT="${WEBMANAGER_ROOT:-$HOME/webmanager-dev}"
PIDFILE="$WEBMANAGER_ROOT/manager.pid"
prefix="$WEBMANAGER_ROOT/nginx"; conf="$prefix/conf/nginx.conf"

# nginx first
if command -v nginx >/dev/null 2>&1 && [ -f "$conf" ]; then
  if nginx -p "$prefix" -c "$conf" -s stop 2>/dev/null; then echo "• nginx stopped"; else echo "• nginx not running"; fi
fi

# manager
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "• manager stopped"
elif pkill -f "src/server.js" 2>/dev/null; then
  rm -f "$PIDFILE"; echo "• manager stopped (fallback)"
else
  echo "• manager not running"
fi
