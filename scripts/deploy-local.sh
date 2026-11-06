#!/usr/bin/env bash
# Local deploy for Once Upon a Diff. Never pushes. After a deploy it removes the worktree of each landed branch (under
# ../once-upon-a-diff-worktrees) when that branch is now an ancestor of main. Batch mode, which cherry-picks, also deletes
# each fully picked local branch (git cherry shows only '-') and logs its tip sha in the ledger line for restoring.
#
#   scripts/deploy-local.sh --yes <branch-or-sha>            fast-forward deploy (default)
#   scripts/deploy-local.sh [--yes] --batch <base> <sha>...  cherry-pick deploy with gates
#   scripts/deploy-local.sh --rollback <sha>
#
# Fast-forward mode refuses unless the target descends from the main checkout's live HEAD and the checkout is clean.
# It fast-forwards main to the target, installs, builds, respawns the bridge and verifies. It runs no gates: the
# branch's own agent ran them. Without --yes it only prints the plan.
# Batch mode cherry-picks the shas onto <base> in ONE reusable worktree (../once-upon-a-diff-worktrees/deploy, reset
# to the base each time), runs every gate and prints the plan. Re-running with the same arguments and --yes reuses
# that worktree and skips the gates when the tip is unchanged.
set -euo pipefail

MAIN="${OU_MAIN:-$HOME/Development/SideProjects/once-upon-a-diff}"
PORT=4823
KNOWN_EDIT="skills/once-upon/SKILL.md"
# The bridge also writes its own timestamped lines here; the hand deploys appended stdout to the same file.
BRIDGE_LOG="$HOME/.once-upon/bridge.log"

# shellcheck source=lib/worktree-cleanup.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/worktree-cleanup.sh"

die() { echo "deploy-local: $*" >&2; exit 1; }
say() { echo "deploy-local: $*"; }

usage() {
  echo "usage: scripts/deploy-local.sh --yes <branch-or-sha>" >&2
  echo "       scripts/deploy-local.sh [--yes] --batch <base> <sha>..." >&2
  echo "       scripts/deploy-local.sh --rollback <sha>" >&2
  exit 2
}

YES=0
BATCH=0
ROLLBACK=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --batch) BATCH=1 ;;
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

# Fast-forward mode: keep the main checkout on branch main and merge --ff-only $1 into it, carrying the known edit.
ff_main() {
  local sha="$1" stashed=0 cur
  check_main_clean
  cur="$(git -C "$MAIN" symbolic-ref -q --short HEAD || true)"
  if [ "$cur" != main ]; then
    git -C "$MAIN" merge-base --is-ancestor main HEAD || die "local main is not an ancestor of the live HEAD, so switching to it is unsafe. Fix it by hand."
  fi
  if [ -n "$(git -C "$MAIN" status --porcelain -- "$KNOWN_EDIT")" ]; then
    git -C "$MAIN" stash push -q -m "deploy-local: $KNOWN_EDIT" -- "$KNOWN_EDIT"
    stashed=1
  fi
  if [ "$cur" != main ]; then
    git -C "$MAIN" switch -q main || { [ "$stashed" = 1 ] && git -C "$MAIN" stash pop -q; die "could not switch the main checkout to branch main (is it checked out in another worktree?)"; }
  fi
  if ! git -C "$MAIN" merge -q --ff-only "$sha"; then
    [ "$stashed" = 1 ] && git -C "$MAIN" stash pop -q
    die "fast-forward of main to $sha failed"
  fi
  if [ "$stashed" = 1 ] && ! git -C "$MAIN" stash pop -q; then
    say "stash pop of $KNOWN_EDIT conflicted. Your edit is still in git stash ('deploy-local')."
  fi
  say "main fast-forwarded to $(git -C "$MAIN" rev-parse --short HEAD) on branch main"
}

# Put the main checkout back on branch main at $1 (recovery for fast-forward mode).
restore_main() {
  local sha="$1"
  if [ "$(git -C "$MAIN" symbolic-ref -q --short HEAD || true)" != main ]; then
    git -C "$MAIN" switch -q main || return 1
  fi
  git -C "$MAIN" reset -q --keep "$sha" || git -C "$MAIN" reset -q --hard "$sha"
}

# The pid listening on $PORT, or nothing.
listener_pid() { lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true; }

cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

# The bridge's folder in MAIN: packages/server/bridge, or packages/bridge while MAIN still has the layout from before the packages
# were regrouped (the live bridge's cwd on the first deploy past the move, and after a rollback to before it). It is whichever
# holds bin/once-upon.mjs: git leaves the old folder behind with its untracked node_modules after the move, so the bin decides.
# The legacy branch goes in a later card, once no rollback target is older than the regroup.
bridge_dir() {
  if [ -f "$MAIN/packages/server/bridge/bin/once-upon.mjs" ]; then
    echo "$MAIN/packages/server/bridge"
  elif [ -f "$MAIN/packages/bridge/bin/once-upon.mjs" ]; then
    echo "$MAIN/packages/bridge"
  else
    die "no bridge folder under $MAIN/packages (packages/server/bridge or packages/bridge)"
  fi
}

# The vendored files' folder in MAIN, by the same rule.
vendor_dir() {
  if [ -d "$MAIN/packages/client/web/public/vendor" ]; then
    echo "$MAIN/packages/client/web/public/vendor"
  else
    echo "$MAIN/packages/web/public/vendor"
  fi
}

# Kill the bridge on $PORT (only if it is a node process running from MAIN's bridge folder, new or legacy) and respawn it from bridge_dir.
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
    case "$cwd" in
      "$MAIN/packages/server/bridge" | "$MAIN/packages/bridge") ;;
      *) die "the bridge on $PORT (pid $pid) runs from $cwd, not $MAIN/packages/server/bridge (or the old $MAIN/packages/bridge). Not killing it. Stop it by hand and re-run." ;;
    esac
    say "killing bridge pid $pid"
    kill "$pid" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then die "bridge pid $pid did not exit"; fi
  fi
  local dir
  dir="$(bridge_dir)"
  (
    cd "$dir" || exit 1
    nohup node bin/once-upon.mjs serve </dev/null >>"$BRIDGE_LOG" 2>&1 &
  )
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -s --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
    sleep 1
  done
  pid="$(listener_pid)"
  [ -n "$pid" ] || die "bridge did not come up on $PORT (see $BRIDGE_LOG)"
  cwd="$(cwd_of "$pid")"
  [ "$cwd" = "$dir" ] || die "new bridge pid $pid runs from $cwd, expected $dir"
  say "bridge pid $pid, cwd verified: $cwd"
  BRIDGE_PID="$pid"
}

verify_live() {
  local code type f name want got tok terms base="http://127.0.0.1:$PORT"
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
  # the terms package is served as /assets/terms/ (it was /assets/domain/ before the regroup, which a rollback past it brings back)
  if [ -d "$MAIN/packages/domain/terms" ]; then terms=terms; else terms=domain; fi
  code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$base/assets/$terms/patterns.ts")"
  [ "$code" = 200 ] || die "/assets/$terms/patterns.ts returned $code"
  SERVED_N=0
  for f in "$(vendor_dir)"/*.sha256; do
    [ -e "$f" ] || continue
    SERVED_N=$((SERVED_N + 1))
    name="$(basename "$f" .sha256)"
    want="$(awk '{print $1}' "$f")"
    got="$(curl -s --max-time 10 "$base/assets/$name" | shasum -a 256 | awk '{print $1}')"
    [ "$want" = "$got" ] || die "served /assets/$name hashes $got, vendored says $want"
  done
  [ "$SERVED_N" -gt 0 ] || die "no vendor .sha256 files found in $(vendor_dir), nothing to verify"
  (cd "$(bridge_dir)" && node bin/once-upon.mjs backlog list >/dev/null) || die "backlog list failed"
  say "verified: $PORT answers, /api/board 200, /assets/preact.mjs 200 $type, $SERVED_N served vendor file(s) match their sha256, backlog list ok"
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

PREV="$(git -C "$MAIN" rev-parse HEAD)"
PREVS="$(git -C "$MAIN" rev-parse --short "$PREV")"
ROLLBACK_CMD="scripts/deploy-local.sh --rollback $PREV"

# Switch main to $TIP, rebuild, respawn and verify. Once main is switched, any failure puts the previous sha back.
SWITCHED=0
recover() {
  local rc=$?
  trap - EXIT
  if [ "$SWITCHED" = 1 ] && [ "$rc" -ne 0 ]; then
    echo "deploy-local: FAILED after switching main (exit $rc). Putting $PREVS back." >&2
    (
      if [ "$BATCH" = 1 ]; then
        switch_main "$PREV" || switch_main "$PREV" force
      else
        restore_main "$PREV" || switch_main "$PREV" force
      fi
      rebuild_main
      respawn_bridge
    ) || echo "deploy-local: automatic recovery failed." >&2
    echo "deploy-local: previous sha: $PREV" >&2
    echo "deploy-local: roll back by hand with: $ROLLBACK_CMD" >&2
  fi
  exit "$rc"
}

# Record the deployed work's backlog items as landed (no PR ever merges them, and the stack branches get pruned).
# A card is matched by the commit its agent recorded (agent finish --commit), never by a branch name: `backlog land` marks
# done the cards whose commit is in the deployed range, as the commit, as a picked sha (batch) or as the same patch.
# Fast-forward: $PREV..$TIP. Batch: $BASE..$TIP, with the picked shas. A card it could not match is printed, to close by
# hand with `backlog done ID`. Also lists LANDED_BRANCHES (local branches whose tip is in the deploy) for the worktree
# cleanup, which judges each by patch itself. A failure here only prints a line, the deploy is already live.
mark_landed() {
  local name tip from
  LANDED_BRANCHES=()
  while read -r name tip; do
    case "$name" in main | master) continue ;; esac
    if [ "$BATCH" = 1 ]; then
      case " ${SHAS[*]} " in *" $tip "*) ;; *) continue ;; esac
    elif git -C "$MAIN" merge-base --is-ancestor "$tip" "$TIP" && ! git -C "$MAIN" merge-base --is-ancestor "$tip" "$PREV"; then
      :
    else
      continue
    fi
    LANDED_BRANCHES+=("$name")
  done < <(git -C "$MAIN" for-each-ref --format='%(refname:lstrip=2) %(objectname)' refs/heads 2>/dev/null) || true
  if [ "$BATCH" = 1 ]; then from="$BASE"; else from="$PREV"; fi
  (cd "$(bridge_dir)" && node bin/once-upon.mjs backlog land ${SHAS[@]+"${SHAS[@]}"} --from "$from" --to "$TIP" --by deploy-local </dev/null) || say "could not mark backlog items as done"
}

go_live() {
  trap recover EXIT
  SWITCHED=1
  if [ "$BATCH" = 1 ]; then switch_main "$TIP"; else ff_main "$TIP"; fi
  rebuild_main
  respawn_bridge
  verify_live
  SWITCHED=0
  trap - EXIT
  # Batch mode: move the local main branch up when the tip descends from it. Fast-forward mode already did.
  if [ "$BATCH" != 1 ]; then
    say "local main is at $(git -C "$MAIN" rev-parse --short main)"
  elif git -C "$MAIN" merge-base --is-ancestor main "$TIP"; then
    OLDMAIN="$(git -C "$MAIN" rev-parse --short main)"
    if git -C "$MAIN" branch -f main "$TIP" 2>/dev/null; then
      say "local main $OLDMAIN -> $(git -C "$MAIN" rev-parse --short main)"
    else
      say "could not move local main (checked out in a worktree?), left it at $OLDMAIN"
    fi
  else
    say "local main is not an ancestor of the tip, left it alone"
  fi
  mark_landed || say "could not mark backlog items as done"
  local b
  DELETED_BRANCHES=()
  for b in ${LANDED_BRANCHES[@]+"${LANDED_BRANCHES[@]}"}; do
    if [ "$BATCH" = 1 ]; then
      # Cherry-picked branches never become ancestors of main: judge them by patch, then drop worktree and branch.
      cleanup_landed_branch "$MAIN" "$MAIN-worktrees" "$b" main || true
      [ -z "$DELETED_BRANCH_NOTE" ] || DELETED_BRANCHES+=("$DELETED_BRANCH_NOTE")
    else
      cleanup_landed_worktree "$MAIN" "$MAIN-worktrees" "$b" main "" || true
    fi
  done
  SHORT="$(git -C "$MAIN" rev-parse --short "$TIP")"
  NOW="$(TZ=America/New_York date '+%-I:%M %p ET, %-m/%-d')"
}

if [ "$BATCH" != 1 ]; then
  # Fast-forward mode
  [ ${#ARGS[@]} -eq 1 ] || usage
  TARGET="${ARGS[0]}"
  TIP="$(git -C "$MAIN" rev-parse --verify -q "$TARGET^{commit}")" || die "unknown branch or sha $TARGET"
  git -C "$MAIN" merge-base --is-ancestor "$PREV" "$TIP" || die "$TARGET ($(git -C "$MAIN" rev-parse --short "$TIP")) does not descend from the live HEAD $PREVS. Rebase it onto $PREVS, or use --batch."
  [ "$TIP" != "$PREV" ] || die "$TARGET is already live at $PREVS"
  check_main_clean
  echo
  echo "Plan"
  echo "  target     $(git -C "$MAIN" rev-parse --short "$TIP")  ($(git -C "$MAIN" log -1 --format=%s "$TIP"))"
  echo "  live now   $PREVS ($PREV)"
  echo "  go live    fast-forward $MAIN to the target, yarn install, build, respawn bridge from $MAIN/packages/server/bridge, verify. No gates."
  echo "  rollback   $ROLLBACK_CMD"
  echo
  if [ "$YES" != 1 ]; then
    say "plan only. Re-run with --yes to go live."
    exit 0
  fi
  go_live
  echo
  echo "Rollback: $ROLLBACK_CMD"
  echo "Ledger:   deploy ff $TARGET: $PREVS -> $SHORT, no gates run here, bridge pid $BRIDGE_PID at $NOW, local main ff, nothing pushed"
  exit 0
fi

# Batch mode
[ ${#ARGS[@]} -ge 2 ] || usage
BASE="${ARGS[0]}"
SHAS=("${ARGS[@]:1}")
WT="$MAIN-worktrees/deploy"

check_main_clean
BASE="$(git -C "$MAIN" rev-parse --verify -q "$BASE^{commit}")" || die "unknown base ${ARGS[0]}"
RESOLVED=()
for s in "${SHAS[@]}"; do
  r="$(git -C "$MAIN" rev-parse --verify -q "$s^{commit}")" || die "unknown sha $s"
  RESOLVED+=("$r")
done
SHAS=("${RESOLVED[@]}")
KEY="$BASE ${SHAS[*]}"

stamp_of() {
  local dir
  dir="$(git -C "$WT" rev-parse --git-dir)"
  case "$dir" in /*) ;; *) dir="$WT/$dir" ;; esac
  echo "$dir/deploy-gates-ok"
}

REUSED=0
if [ -e "$WT" ]; then
  [ -z "$(git -C "$WT" status --porcelain)" ] || die "worktree $WT has uncommitted changes"
  STAMP="$(stamp_of)"
  # A dry run's result can be reused when this worktree's tip is the one whose gates passed for these arguments.
  if [ -f "$STAMP" ] && [ "$(sed -n 1p "$STAMP")" = "$(git -C "$WT" rev-parse HEAD)" ] && [ "$(sed -n 2p "$STAMP")" = "$KEY" ]; then
    TIP="$(git -C "$WT" rev-parse HEAD)"
    REUSED=1
    say "reusing $WT at $(git -C "$WT" rev-parse --short "$TIP"): gates already passed for this tip"
  fi
fi

if [ "$REUSED" = 0 ]; then
  if [ -e "$WT" ]; then
    rm -f "$(stamp_of)"
    git -C "$WT" checkout -q --detach "$BASE"
    git -C "$WT" reset -q --hard "$BASE"
    # Ignored build output from the last deploy must not leak into these gates.
    rm -rf "$WT"/build "$WT"/packages/*/*/build "$WT"/packages/*/*/dist "$WT"/packages/*/*/.output
  else
    mkdir -p "$MAIN-worktrees"
    git -C "$MAIN" worktree add -q --detach "$WT" "$BASE"
  fi
  # The board leaves out a worktree whose git dir has this marker (HIDDEN_MARKER in the bridge's worktrees.ts).
  : >"$(dirname "$(stamp_of)")/once-upon-hidden"
  say "worktree $WT reset to $(git -C "$WT" rev-parse --short HEAD)"
  for s in "${SHAS[@]}"; do
    if ! out="$(git -C "$WT" cherry-pick "$s" 2>&1)"; then
      echo "deploy-local: cherry-pick of $s failed:" >&2
      echo "$out" | tail -n 6 >&2
      git -C "$WT" status --short | grep -E '^(UU|AA|DU|UD|AU|UA|DD) ' >&2 || true
      die "stopped. Fix it in $WT, or 'git cherry-pick --abort' there. Nothing was deleted and nothing is live."
    fi
    say "picked $s -> $(git -C "$WT" rev-parse --short HEAD)"
  done
  TIP="$(git -C "$WT" rev-parse HEAD)"

  quiet "yarn install" bash -c "cd '$WT' && yarn install --immutable"
  quiet "lint" bash -c "cd '$WT' && yarn lint"
  quiet "typecheck" bash -c "cd '$WT' && yarn typecheck"
  quiet "format:check" bash -c "cd '$WT' && yarn format:check"
  quiet "test" bash -c "cd '$WT' && yarn test"
  quiet "build" bash -c "cd '$WT' && yarn build"
  VENDOR_N=0
  for f in "$WT"/packages/client/web/public/vendor/*.sha256; do
    [ -e "$f" ] || continue
    quiet "sha256 $(basename "$f")" bash -c "cd '$(dirname "$f")' && shasum -a 256 -c '$(basename "$f")'"
    VENDOR_N=$((VENDOR_N + 1))
  done
  [ "$VENDOR_N" -gt 0 ] || die "no vendor .sha256 files found in $WT/packages/client/web/public/vendor, nothing was checked"
  say "vendor checksums verified: $VENDOR_N"
  printf '%s\n%s\n' "$TIP" "$KEY" >"$(stamp_of)"
fi

echo
echo "Plan"
echo "  worktree   $WT (detached)"
echo "  tip        $(git -C "$WT" rev-parse --short "$TIP")  ($(git -C "$WT" log -1 --format=%s "$TIP"))"
echo "  live now   $PREVS ($PREV)"
echo "  go live    detach $MAIN at the tip, yarn install, build, respawn bridge from $MAIN/packages/server/bridge, verify, fast-forward local main"
echo "  rollback   $ROLLBACK_CMD"
echo
if [ "$YES" != 1 ]; then
  say "gates passed. Re-run the same command with --yes to go live (it reuses this worktree and skips the gates)."
  exit 0
fi

go_live
NOTE=""
[ "$REUSED" = 1 ] && NOTE=" (reused worktree)"
[ ${#DELETED_BRANCHES[@]} -eq 0 ] || NOTE="$NOTE, deleted landed branches (restore with git branch <name> <sha>): ${DELETED_BRANCHES[*]}"
echo
echo "Rollback: $ROLLBACK_CMD"
echo "Ledger:   deploy batch: $PREVS -> $SHORT, ${#SHAS[@]} picked, gates green$NOTE, bridge pid $BRIDGE_PID at $NOW, local main ff, nothing pushed"
