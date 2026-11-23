# Sourced by deploy-local.sh (and by test/respawn-bridge.test.ts). Restarts the bridge on $PORT from MAIN's bridge folder.
# The caller defines MAIN, PORT, BRIDGE_LOG, die and say before it calls respawn_bridge.
#
# With the LaunchAgent installed (`once-upon install-launch-agent`, label below) the restart is `launchctl kickstart -k`, which
# stops the job if it runs and starts it either way, so the bridge's cwd is the plist's WorkingDirectory and needs no check.
# A bridge that launchd does not own (started by hand) is stopped by its pid first, after checking it is main's. Without the
# LaunchAgent the bridge is stopped by pid and started again with nohup, as before.

# The job's label: adapters/src/launch-agent.ts LAUNCH_LABEL (a test keeps the two equal).
LAUNCH_LABEL=dev.onceupon.bridge

# The pid listening on $PORT, or nothing.
listener_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true; }

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

# The bridge's folder in MAIN.
bridge_dir() {
  if [ -f "$MAIN/packages/server/bridge/bin/once-upon.mjs" ]; then
    echo "$MAIN/packages/server/bridge"
  else
    die "no bridge folder under $MAIN/packages/server"
  fi
}

# Whether the LaunchAgent's file is there and launchd has the job loaded.
launch_agent_installed() {
  [ -f "$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist" ] &&
    launchctl print "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1
}

# The pid launchd runs the job under, or nothing.
launchd_pid() {
  launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1
}

# Whether the folder is MAIN's checkout, or inside it, and not inside another worktree of the repo (lsof reports real paths).
is_main_cwd() {
  local cwd="$1" main wt real
  main="$(cd "$MAIN" && pwd -P)"
  case "$cwd" in "$main" | "$main"/*) ;; *) return 1 ;; esac
  while IFS= read -r wt; do
    real="$(cd "$wt" 2>/dev/null && pwd -P)" || continue
    case "$cwd" in "$real" | "$real"/*) return 1 ;; esac
  done < <(git -C "$MAIN" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | tail -n +2)
  return 0
}

# Stops a bridge on $PORT that launchd does not own, only when it is a node process running from main's checkout.
stop_hand_bridge() {
  local pid="$1" cwd comm
  cwd="$(cwd_of "$pid")"
  comm="$(ps -o command= -p "$pid" || true)"
  case "$comm" in
    *node*once-upon*serve*) ;;
    *) die "the process on $PORT (pid $pid) is not the bridge ($comm). Not killing it." ;;
  esac
  is_main_cwd "$cwd" || die "the bridge on $PORT (pid $pid) runs from $cwd, which is not the main checkout $MAIN (or a folder in it that is no other worktree). Not killing it. Stop it by hand and re-run."
  say "killing bridge pid $pid"
  kill "$pid" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then die "bridge pid $pid did not exit"; fi
}

# Waits up to 15 seconds for the bridge to answer on $PORT.
wait_for_bridge() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -s --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
    sleep 1
  done
}

# Starts the bridge from the folder $1 with nohup, detached.
start_bridge_by_hand() {
  (
    cd "$1" || exit 1
    nohup node bin/once-upon.mjs serve </dev/null >>"$BRIDGE_LOG" 2>&1 &
  )
}

# Restarts the bridge on $PORT from bridge_dir and leaves its pid in BRIDGE_PID.
# When launchd cannot bring it up (its Node or checkout is gone, so it cannot exec), the plain nohup start takes over, so the
# board is not left down; the LaunchAgent then needs `once-upon install-launch-agent` again.
respawn_bridge() {
  local pid cwd dir real installed=0 lpid=""
  dir="$(bridge_dir)"
  if launch_agent_installed; then
    installed=1
    lpid="$(launchd_pid)"
  fi
  pid="$(listener_pid)"
  if [ -n "$pid" ] && [ "$pid" != "$lpid" ]; then
    stop_hand_bridge "$pid"
  fi
  if [ "$installed" = 1 ]; then
    say "restarting the bridge through launchd ($LAUNCH_LABEL)"
    launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL" || say "launchctl kickstart of $LAUNCH_LABEL failed"
    wait_for_bridge
    if [ -z "$(listener_pid)" ]; then
      say "launchd did not bring the bridge up on $PORT (its Node or checkout may be gone): starting it by hand. Run once-upon install-launch-agent again to repair the LaunchAgent"
      start_bridge_by_hand "$dir"
      wait_for_bridge
    fi
  else
    start_bridge_by_hand "$dir"
    wait_for_bridge
  fi
  pid="$(listener_pid)"
  [ -n "$pid" ] || die "bridge did not come up on $PORT (see $BRIDGE_LOG)"
  cwd="$(cwd_of "$pid")"
  real="$(cd "$dir" && pwd -P)"
  [ "$cwd" = "$real" ] || die "new bridge pid $pid runs from $cwd, expected $real. If launchd started it, run once-upon install-launch-agent again"
  say "bridge pid $pid, cwd verified: $cwd"
  BRIDGE_PID="$pid"
}
