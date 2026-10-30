#!/usr/bin/env bash
# Local deploy for Once Upon a Diff. Never pushes, never deletes branches or worktrees.
#
#   scripts/deploy-local.sh [--yes] <name> <base-sha> <sha>...
#   scripts/deploy-local.sh --rollback <sha>
#
# Without --yes it builds the deploy worktree, runs every gate, prints the plan and stops.
# Re-running with the same arguments and --yes reuses that worktree and skips the gates when the tip is unchanged.
set -euo pipefail

MAIN="${OU_MAIN:-$HOME/Development/SideProjects/once-upon-a-diff}"
PORT=4823
KNOWN_EDIT="skills/once-upon/SKILL.md"
# The bridge also writes its own timestamped lines here; the hand deploys appended stdout to the same file.
BRIDGE_LOG="$HOME/.once-upon/bridge.log"

die() { echo "deploy-local: $*" >&2; exit 1; }
say() { echo "deploy-local: $*"; }

usage() {
  echo "usage: scripts/deploy-local.sh [--yes] <name> <base-sha> <sha>..." >&2
  echo "       scripts/deploy-local.sh --rollback <sha>" >&2
  exit 2
}

YES=0
ROLLBACK=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --rollback)
      [ $# -ge 2 ] || usage
      ROLLBACK="$2"
      shift
      ;;
    -h | --help) usage ;;
    --*)
      echo "deploy-local: unknown flag $1" >&2
      usage
      ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

# Quiet runner: show output only when the command fails.
quiet() {
  local label="$1" out
  shift
  out="$(mktemp)"
  if "$@" >"$out" 2>&1; then
    say "ok: $label"
    rm -f "$out"
  else
    echo "---- $label failed ----" >&2
    tail -n 80 "$out" >&2
    rm -f "$out"
    die "$label failed"
  fi
}

# Uncommitted paths in the main checkout other than the known edit (empty output means clean enough).
main_dirt() {
  git -C "$MAIN" status --porcelain | grep -v -E "^( M|UU|AA|MM) $KNOWN_EDIT\$" || true
}

check_main_clean() {
  local other
  other="$(main_dirt)"
  [ -z "$other" ] || die "main checkout has uncommitted changes besides $KNOWN_EDIT:
$other"
}

# Switch the main checkout (detached) to $1, stashing and restoring the known edit.
# With force ($2 = force), a conflicted or stuck $KNOWN_EDIT is discarded from the working tree. A stash keeps it.
switch_main() {
  local sha="$1" force="${2:-}" before after stashed=0
  check_main_clean
  if [ "$force" = force ]; then
    git -C "$MAIN" switch -q --detach --discard-changes "$sha" || die "could not force-switch main checkout to $sha"
    say "main checkout force-switched to $(git -C "$MAIN" rev-parse --short HEAD)"
    say "if $KNOWN_EDIT was conflicted, your edit is in this stash: $(git -C "$MAIN" stash list | grep 'deploy-local' | head -n 1 || true)"
    return 0
  fi
  before="$(git -C "$MAIN" diff -- "$KNOWN_EDIT" | shasum -a 256)"
  if [ -n "$(git -C "$MAIN" status --porcelain -- "$KNOWN_EDIT")" ]; then
    git -C "$MAIN" stash push -q -m "deploy-local: $KNOWN_EDIT" -- "$KNOWN_EDIT"
    stashed=1
  fi
  if ! git -C "$MAIN" switch -q --detach "$sha"; then
    [ "$stashed" = 1 ] && git -C "$MAIN" stash pop -q
    die "could not switch main checkout to $sha"
  fi
  if [ "$stashed" = 1 ]; then
    if ! git -C "$MAIN" stash pop -q; then
      say "stash pop of $KNOWN_EDIT conflicted. Your edit is still in git stash (stash@{0}, 'deploy-local'). Conflict markers are in the working tree. --rollback still works."
      return 0
    fi
    after="$(git -C "$MAIN" diff -- "$KNOWN_EDIT" | shasum -a 256)"
    [ "$before" = "$after" ] || say "note: $KNOWN_EDIT diff changed across the switch, check it"
  fi
  say "main checkout detached at $(git -C "$MAIN" rev-parse --short HEAD)"
}

# The pid listening on $PORT, or nothing.
listener_pid() { lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true; }

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

# Kill the bridge on $PORT (only if it is a node process running from MAIN/packages/bridge) and respawn it there.
respawn_bridge() {
  local pid cwd comm
  pid="$(listener_pid)"
  if [ -n "$pid" ]; then
    cwd="$(cwd_of "$pid")"
    comm="$(ps -o command= -p "$pid" || true)"
    case "$comm" in
      *node*once-upon*serve*) ;;
      *) die "the process on $PORT (pid $pid) is not the bridge ($comm). Not killing it." ;;
    esac
    [ "$cwd" = "$MAIN/packages/bridge" ] || die "the bridge on $PORT (pid $pid) runs from $cwd, not $MAIN/packages/bridge. Not killing it. Stop it by hand and re-run."
    say "killing bridge pid $pid"
    kill "$pid" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then die "bridge pid $pid did not exit"; fi
  fi
  (
    cd "$MAIN/packages/bridge" || exit 1
    nohup node bin/once-upon.mjs serve </dev/null >>"$BRIDGE_LOG" 2>&1 &
  )
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -s --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
    sleep 1
  done
  pid="$(listener_pid)"
  [ -n "$pid" ] || die "bridge did not come up on $PORT (see $BRIDGE_LOG)"
  cwd="$(cwd_of "$pid")"
  [ "$cwd" = "$MAIN/packages/bridge" ] || die "new bridge pid $pid runs from $cwd, expected $MAIN/packages/bridge"
  say "bridge pid $pid, cwd verified: $cwd"
  BRIDGE_PID="$pid"
}

verify_live() {
  local code type f name want got tok base="http://127.0.0.1:$PORT"
  # /api/board wants the bridge token. It goes to curl on stdin (-K -), so it is never in argv, output or logs.
  tok="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.once-upon/config.json","utf8")).token||""))' 2>/dev/null)" || tok=""
  [ -n "$tok" ] || die "no token in ~/.once-upon/config.json for the /api/board check"
  curl -s --max-time 10 -o /dev/null "$base/" || die "port $PORT does not answer"
  # The first /api/board call starts the worktree scanner and can take about a minute.
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -s -K - --max-time 180 -o /dev/null -w '%{http_code}' "$base/api/board")"
  [ "$code" = 200 ] || die "/api/board returned $code"
  code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$base/assets/preact.mjs")"
  [ "$code" = 200 ] || die "/assets/preact.mjs returned $code"
  type="$(curl -s --max-time 10 -o /dev/null -w '%{content_type}' "$base/assets/preact.mjs")"
  case "$type" in text/javascript*) ;; *) die "/assets/preact.mjs content-type is '$type'" ;; esac
  for f in "$MAIN"/packages/bridge/public/vendor/*.sha256; do
    [ -e "$f" ] || continue
    name="$(basename "$f" .sha256)"
    want="$(awk '{print $1}' "$f")"
    got="$(curl -s --max-time 10 "$base/assets/$name" | shasum -a 256 | awk '{print $1}')"
    [ "$want" = "$got" ] || die "served /assets/$name hashes $got, vendored says $want"
  done
  (cd "$MAIN/packages/bridge" && node bin/once-upon.mjs backlog list >/dev/null) || die "backlog list failed"
  say "verified: $PORT answers, /api/board 200, /assets/preact.mjs 200 $type and matches its sha256, backlog list ok"
}

rebuild_main() {
  quiet "yarn install (main)" bash -c "cd '$MAIN' && yarn install --immutable"
  quiet "build (main)" bash -c "cd '$MAIN' && yarn build"
}

if [ -n "$ROLLBACK" ]; then
  [ ${#ARGS[@]} -eq 0 ] || usage
  git -C "$MAIN" rev-parse --verify -q "$ROLLBACK^{commit}" >/dev/null || die "unknown sha $ROLLBACK"
  say "rolling back main checkout to $ROLLBACK"
  # Rollback goes through even when the SKILL.md stash pop conflicted earlier.
  switch_main "$ROLLBACK" force
  rebuild_main
  respawn_bridge
  verify_live
  say "rolled back. Local main was not moved."
  echo "ledger: rollback to $ROLLBACK at $(TZ=America/New_York date '+%-I:%M %p ET, %-m/%-d'), bridge pid $BRIDGE_PID"
  exit 0
fi

[ ${#ARGS[@]} -ge 2 ] || usage
NAME="${ARGS[0]}"
BASE="${ARGS[1]}"
SHAS=("${ARGS[@]:2}")
case "$NAME" in *[!A-Za-z0-9._-]* | "") die "bad name '$NAME'" ;; esac

BRANCH="stack/deploy-$NAME"
WT="$MAIN-worktrees/deploy-$NAME"
PREV="$(git -C "$MAIN" rev-parse HEAD)"
PREVS="$(git -C "$MAIN" rev-parse --short "$PREV")"

check_main_clean
git -C "$MAIN" rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "unknown base $BASE"
for s in ${SHAS[@]+"${SHAS[@]}"}; do
  git -C "$MAIN" rev-parse --verify -q "$s^{commit}" >/dev/null || die "unknown sha $s"
done

stamp_of() {
  local dir
  dir="$(git -C "$WT" rev-parse --git-dir)"
  case "$dir" in /*) ;; *) dir="$WT/$dir" ;; esac
  echo "$dir/deploy-gates-ok"
}

REUSED=0
if [ -e "$WT" ]; then
  # A dry run's worktree can be reused when its tip is the one whose gates passed.
  STAMP="$(stamp_of)"
  [ -f "$STAMP" ] || die "worktree $WT already exists and has no passed-gates stamp. Pick another name."
  [ -z "$(git -C "$WT" status --porcelain)" ] || die "worktree $WT has uncommitted changes"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$(cat "$STAMP")" ] || die "worktree $WT moved since its gates passed. Pick another name."
  TIP="$(git -C "$WT" rev-parse HEAD)"
  REUSED=1
  say "reusing $WT at $(git -C "$WT" rev-parse --short "$TIP"): gates already passed for this tip"
else
  git -C "$MAIN" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null && die "branch $BRANCH already exists"
  # 1. Worktree and cherry-picks
  mkdir -p "$MAIN-worktrees"
  git -C "$MAIN" worktree add -q "$WT" -b "$BRANCH" "$BASE"
  say "worktree $WT on $BRANCH from $(git -C "$WT" rev-parse --short HEAD)"
  for s in ${SHAS[@]+"${SHAS[@]}"}; do
    if ! out="$(git -C "$WT" cherry-pick "$s" 2>&1)"; then
      echo "deploy-local: cherry-pick of $s failed:" >&2
      echo "$out" | tail -n 6 >&2
      git -C "$WT" status --short | grep -E '^(UU|AA|DU|UD|AU|UA|DD) ' >&2 || true
      die "stopped. Fix it in $WT (branch $BRANCH), or 'git cherry-pick --abort' there. Nothing was deleted and nothing is live."
    fi
    say "picked $s -> $(git -C "$WT" rev-parse --short HEAD)"
  done
  TIP="$(git -C "$WT" rev-parse HEAD)"

  # 2. Gates
  quiet "yarn install" bash -c "cd '$WT' && yarn install --immutable"
  quiet "lint" bash -c "cd '$WT' && yarn lint"
  quiet "typecheck" bash -c "cd '$WT' && yarn typecheck"
  quiet "format:check" bash -c "cd '$WT' && yarn format:check"
  quiet "test" bash -c "cd '$WT' && yarn test"
  quiet "build" bash -c "cd '$WT' && yarn build"
  VENDOR_N=0
  for f in "$WT"/packages/*/public/vendor/*.sha256 "$WT"/public/vendor/*.sha256; do
    [ -e "$f" ] || continue
    quiet "sha256 $(basename "$f")" bash -c "cd '$(dirname "$f")' && shasum -a 256 -c '$(basename "$f")'"
    VENDOR_N=$((VENDOR_N + 1))
  done
  say "vendor checksums verified: $VENDOR_N"
  echo "$TIP" >"$(stamp_of)"
fi

# 3. Plan
ROLLBACK_CMD="scripts/deploy-local.sh --rollback $PREV"
echo
echo "Plan"
echo "  worktree   $WT ($BRANCH)"
echo "  tip        $(git -C "$WT" rev-parse --short "$TIP")  ($(git -C "$WT" log -1 --format=%s "$TIP"))"
echo "  live now   $PREVS ($PREV)"
echo "  go live    detach $MAIN at the tip, yarn install, build, respawn bridge from $MAIN/packages/bridge, verify, fast-forward local main"
echo "  rollback   $ROLLBACK_CMD"
echo
if [ "$YES" != 1 ]; then
  say "gates passed. Re-run the same command with --yes to go live (it reuses this worktree and skips the gates)."
  exit 0
fi

# 4. Go live. Once main is switched, any failure puts the previous sha back and respawns the bridge.
SWITCHED=0
recover() {
  local rc=$?
  trap - EXIT
  if [ "$SWITCHED" = 1 ] && [ "$rc" -ne 0 ]; then
    echo "deploy-local: FAILED after switching main (exit $rc). Putting $PREVS back." >&2
    (
      switch_main "$PREV" || switch_main "$PREV" force
      rebuild_main
      respawn_bridge
    ) || echo "deploy-local: automatic recovery failed." >&2
    echo "deploy-local: previous sha: $PREV" >&2
    echo "deploy-local: roll back by hand with: $ROLLBACK_CMD" >&2
  fi
  exit "$rc"
}
trap recover EXIT

switch_main "$TIP"
SWITCHED=1
rebuild_main
respawn_bridge

# 5. Verify
verify_live
SWITCHED=0
trap - EXIT

# 6. Fast-forward local main
if git -C "$MAIN" merge-base --is-ancestor main "$TIP"; then
  OLDMAIN="$(git -C "$MAIN" rev-parse --short main)"
  git -C "$MAIN" branch -f main "$TIP"
  say "local main $OLDMAIN -> $(git -C "$MAIN" rev-parse --short main)"
else
  say "local main is not an ancestor of the tip, left it alone"
fi

# 7. Rollback and ledger line
SHORT="$(git -C "$MAIN" rev-parse --short "$TIP")"
NOTE=""
[ "$REUSED" = 1 ] && NOTE=" (reused worktree)"
echo
echo "Rollback: $ROLLBACK_CMD"
echo "Ledger:   deploy $NAME: $PREVS -> $SHORT, ${#SHAS[@]} picked, gates green$NOTE, bridge pid $BRIDGE_PID at $(TZ=America/New_York date '+%-I:%M %p ET, %-m/%-d'), local main ff, nothing pushed"
