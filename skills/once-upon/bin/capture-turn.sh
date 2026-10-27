#!/bin/bash
# A Claude Code hook for the review inbox: wire it to Stop and to UserPromptSubmit.
#
#   bash /path/to/once-upon-a-diff/skills/once-upon/bin/capture-turn.sh      (reads the hook's JSON on stdin)
#
# At each prompt and each Stop it snapshots the working tree into a git tree object, through a temporary index (a copy
# of the real one, so it's quick), with no commit, ref, stash or change to your own index, and appends one short line
# about it to a spool, ~/.once-upon/turns/incoming.jsonl (ONCE_UPON_HOME moves it): the event, session, checkout,
# tree id, branch, time and the transcript's path. The bridge reads the spool, pairs a prompt's tree with the Stop's
# into a turn, makes the diff itself and reads your prompt and Claude's last message from the transcript. Nothing is
# sent anywhere, and nothing is lost while the bridge is down: the lines wait for it.
#
# Repos named in capture_exclude in ~/.once-upon/config.json (owner/name, or a checkout's folder) are skipped before
# the snapshot, so a repo you don't want reviewed costs nothing here.
#
# It never fails a turn: every path ends in exit 0, and it prints nothing. It does nothing outside a git checkout.
# Needs git and jq.
set -u
umask 077

# Is this checkout named in capture_exclude? Only that one key of config.json is read.
excluded() {
  local top="$1" config="$home/config.json" entry real slug=''
  [[ -r "$config" ]] || return 1
  real=$(cd "$top" 2>/dev/null && pwd -P) || real="$top"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == /* || "$entry" == \~/* ]]; then
      entry="${entry/#\~/$HOME}"
      [[ "$entry" == "$top" || "$(cd "$entry" 2>/dev/null && pwd -P)" == "$real" ]] && return 0
    else
      # owner/name, from origin (looked up once, and only when the list has such an entry)
      [[ -n "$slug" ]] || slug=$(git -C "$top" remote get-url origin 2>/dev/null | sed -E 's#/$##; s#\.git$##; s#.*github\.com[:/]([^/]+/[^/]+)$#\1#' | tr '[:upper:]' '[:lower:]')
      [[ -n "$slug" && "$slug" == "$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')" ]] && return 0
    fi
  done < <(jq -r '(.capture_exclude // []) | if type == "array" then .[] | strings else empty end' "$config" 2>/dev/null)
  return 1
}

main() {
  command -v git >/dev/null && command -v jq >/dev/null || return 0
  local input event='' session='' cwd='' transcript='' kind top
  input=$(cat)
  {
    read -r event
    read -r session
    read -r cwd
    read -r transcript
  } < <(jq -r '.hook_event_name // "", .session_id // "", .cwd // "", .transcript_path // ""' <<<"$input" 2>/dev/null)
  case "$event" in
    UserPromptSubmit) kind=prompt ;;
    Stop) kind=stop ;;
    *) return 0 ;;
  esac
  [[ "$session" =~ ^[A-Za-z0-9._-]{1,100}$ && -n "$cwd" ]] || return 0
  top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
  excluded "$top" && return 0
  export GIT_TERMINAL_PROMPT=0

  scratch=$(mktemp -d "${TMPDIR:-/tmp}/once-upon-turn.XXXXXX") || return 0
  trap 'rm -rf "$scratch"' EXIT

  # the snapshot: the real index copied, then `add -A` (new, changed and deleted files, .gitignore respected) into the copy.
  # Hooks are off for it (core.hooksPath), since the repo's own post-index-change hook would otherwise run twice, once for
  # `add` and once for `write-tree`. Clean and LFS filters still run, as they do when you `git add` the same files.
  local real_index tree branch line
  git_snapshot() { git -c core.hooksPath=/dev/null -C "$top" "$@"; }
  real_index=$(git -C "$top" rev-parse --path-format=absolute --git-path index 2>/dev/null) || return 0
  # cp -p keeps the index's own timestamp, which git compares file times with to tell a file edited in the same second as
  # the index was written (and of the same size) from an unchanged one: with a fresh timestamp such an edit goes unseen
  [[ -f "$real_index" ]] && cp -p "$real_index" "$scratch/index"
  GIT_INDEX_FILE="$scratch/index" git_snapshot add -A >/dev/null 2>&1 || return 0
  tree=$(GIT_INDEX_FILE="$scratch/index" git_snapshot write-tree 2>/dev/null) || return 0
  branch=$(git -C "$top" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$top" rev-parse --short HEAD 2>/dev/null)
  branch="${branch:0:200}"

  # One line, built whole first and then appended with a single write(2), so lines from sessions that finish together never
  # interleave. (bash 3.2's printf writes in 1 KB pieces, so `printf >>spool` would tear a longer line. cat takes the file
  # in one read and writes it out in one go.) The two paths are most of a line, so it stays well under the 3,500-byte cap.
  line=$(jq -cn --arg event "$kind" --arg session "$session" --arg top "$top" --arg tree "$tree" --arg branch "$branch" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg transcript "$transcript" \
    '{v: 1, event: $event, session: $session, top: $top, tree: $tree, branch: $branch, at: $at, transcript: $transcript}') || return 0
  [[ -n "$line" && $(printf '%s' "$line" | wc -c) -le 3500 ]] || return 0
  mkdir -p "$home/turns" && chmod 700 "$home/turns" 2>/dev/null
  printf '%s\n' "$line" >"$scratch/line" && cat "$scratch/line" >>"$home/turns/incoming.jsonl"
  return 0
}

scratch='' home=''
main
exit 0
