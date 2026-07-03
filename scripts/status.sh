#!/usr/bin/env bash
# Show WEBMANAGER status on macOS / Linux.
export WEBMANAGER_ROOT="${WEBMANAGER_ROOT:-$HOME/webmanager-dev}"
export PORT="${PORT:-8088}"
PIDFILE="$WEBMANAGER_ROOT/manager.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "manager : RUNNING (pid $(cat "$PIDFILE"))  http://localhost:$PORT"
else
  echo "manager : stopped"
fi
if pgrep -f "nginx: master" >/dev/null 2>&1; then echo "nginx   : RUNNING"; else echo "nginx   : stopped"; fi
