#!/bin/bash
# A Claude Code Stop hook: after every turn, hands the bridge what the turn changed, for the review inbox.
#
#   bash /path/to/once-upon-a-diff/skills/once-upon/bin/capture-turn.sh      (reads the hook's JSON on stdin)
#
# It snapshots the working tree into a git tree object, through a temporary index (a copy of the real one, so it's
# quick), with no commit, ref, stash or change to your own index. It compares that tree with this session's last
# snapshot (the first turn: with HEAD's tree) and, when they differ, posts the two tree ids, the branch, the session,
# your prompt for the turn (from the transcript) and Claude's last message to the bridge, which makes the diff itself.
# The baseline moves on only once the bridge has taken the turn, so a failed post is retried with the next turn.
#
# It never fails a turn: every path ends in exit 0, and it prints nothing. It does nothing outside a git checkout,
# or when the bridge isn't answering. Needs git, jq and curl.
set -u
umask 077

main() {
  command -v git >/dev/null && command -v jq >/dev/null && command -v curl >/dev/null || return 0
  local input session transcript cwd summary
  input=$(cat)
  session=$(jq -r '.session_id // empty' <<<"$input")
  transcript=$(jq -r '.transcript_path // empty' <<<"$input")
  cwd=$(jq -r '.cwd // empty' <<<"$input")
  summary=$(jq -r '.last_assistant_message // empty' <<<"$input")
  [[ "$session" =~ ^[A-Za-z0-9._-]{1,100}$ && -n "$cwd" ]] || return 0

  # the bridge: its port and token, and whether it answers (nothing is snapshotted when it doesn't)
  local home port token
  home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
  port=$(jq -r '.port // empty' "$home/config.json" 2>/dev/null)
  token=$(jq -r '.token // empty' "$home/config.json" 2>/dev/null)
  [[ "$port" =~ ^[0-9]+$ && -n "$token" ]] || return 0
  # the token goes to curl on stdin, not its command line, where `ps` would show it
  bridge() {
    printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS -K - --max-time "$1" "${@:2}" 2>/dev/null
  }
  bridge 1 -f -o /dev/null "http://127.0.0.1:$port/api/health" || return 0

  local top
  top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  export GIT_TERMINAL_PROMPT=0

  scratch=$(mktemp -d "${TMPDIR:-/tmp}/once-upon-turn.XXXXXX") || return 0
  trap 'rm -rf "$scratch"' EXIT

  # the snapshot: the real index copied, then `add -A` (new, changed and deleted files, .gitignore respected) into the copy
  local real_index head
  real_index=$(git -C "$top" rev-parse --path-format=absolute --git-path index 2>/dev/null) || return 0
  [[ -f "$real_index" ]] && cp "$real_index" "$scratch/index"
  GIT_INDEX_FILE="$scratch/index" git -C "$top" add -A >/dev/null 2>&1 || return 0
  head=$(GIT_INDEX_FILE="$scratch/index" git -C "$top" write-tree 2>/dev/null) || return 0

  # this session's last snapshot of this checkout, else HEAD's tree (else the empty tree, in a repo with no commits)
  local baselines base
  baselines="$home/turn-baselines"
  mkdir -p "$baselines" && chmod 700 "$baselines" 2>/dev/null
  find "$baselines" -name '*.json' -mtime +14 -delete 2>/dev/null
  base=$(jq -r --arg top "$top" '.[$top].tree // empty' "$baselines/$session.json" 2>/dev/null)
  if [[ -z "$base" ]] || ! git -C "$top" cat-file -e "$base^{tree}" 2>/dev/null; then
    base=$(git -C "$top" rev-parse --verify --quiet 'HEAD^{tree}' 2>/dev/null || git -C "$top" hash-object -t tree /dev/null)
  fi
  remember() {
    local file="$baselines/$session.json"
    [[ -f "$file" ]] || echo '{}' >"$file"
    jq --arg top "$top" --arg tree "$head" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.[$top] = {tree: $tree, at: $at}' "$file" >"$scratch/baseline.json" &&
      mv "$scratch/baseline.json" "$file"
  }
  if [[ "$base" == "$head" ]]; then
    remember
    return 0
  fi

  # your prompt for the turn: the last user message that has text of its own (a tool result has none), from the transcript's tail
  local branch
  branch=$(git -C "$top" symbolic-ref --quiet --short HEAD 2>/dev/null || git -C "$top" rev-parse --short HEAD 2>/dev/null)
  : >"$scratch/prompt"
  if [[ -n "$transcript" && -r "$transcript" ]]; then
    tail -c 4000000 "$transcript" | jq -rRs '
      split("\n") | map(fromjson? // empty) | reverse
      | map(select(.type == "user" and (.isSidechain | not) and (.isMeta | not)) | .message.content
            | if type == "string" then . else (map(select(.type == "text").text) | join("\n")) end
            | select(length > 0 and (startswith("<local-command") | not) and (startswith("<system-reminder") | not)))
      | .[0] // ""' >"$scratch/prompt" 2>/dev/null
  fi
  printf '%s' "$summary" >"$scratch/summary"

  jq -n --arg repo_path "$top" --arg base_tree "$base" --arg head_tree "$head" --arg session "$session" \
    --arg branch "$branch" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --rawfile prompt "$scratch/prompt" --rawfile summary "$scratch/summary" \
    '{repo_path: $repo_path, base_tree: $base_tree, head_tree: $head_tree, session: $session, branch: $branch, at: $at,
      prompt: $prompt[0:8000], summary: $summary[0:20000]}' >"$scratch/body.json" || return 0
  local code
  code=$(bridge 8 -H 'Content-Type: application/json' --data-binary "@$scratch/body.json" \
    -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/turns")
  if [[ "$code" == "200" ]]; then
    remember
  fi
  return 0
}

scratch=''
main
exit 0
