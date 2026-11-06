#!/bin/bash
# heavy.sh <name> <command...>
# Runs a heavy command (full test suite, browser test, typecheck, lint, deploy gates) only when no other heavy run on
# this machine holds the lock, so parallel agents and sessions, in any repo, take turns instead of running at once.
# The lock is a directory holding the holder's pid; a lock whose pid is gone is stale and taken over.
# The lock is $ONCE_UPON_HEAVY_LOCK, else ${XDG_CACHE_HOME:-~/.cache}/heavy-run.lock. It waits ONCE_UPON_HEAVY_POLL
# seconds (default 5) between tries.
lock="${ONCE_UPON_HEAVY_LOCK:-${XDG_CACHE_HOME:-$HOME/.cache}/heavy-run.lock}"
poll="${ONCE_UPON_HEAVY_POLL:-5}"
mkdir -p "$(dirname "$lock")"
name="$1"
shift
said=""
while ! mkdir "$lock" 2>/dev/null; do
  pid=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  if [ -z "$said" ]; then
    echo "heavy.sh: waiting for $(cat "$lock/who" 2>/dev/null || echo 'another heavy run')" >&2
    said=1
  fi
  sleep "$poll"
done
echo $$ >"$lock/pid"
echo "$name ($(date '+%-I:%M %p')): $*" >"$lock/who"
trap 'rm -rf "$lock"' EXIT
trap 'exit 130' INT TERM
"$@"
