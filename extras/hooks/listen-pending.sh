#!/bin/bash
# Starts a queued "Start listening" in whatever Claude Code session you use next, in any terminal or the Desktop Code tab.
# The board's, the panel's and the PR pages' Start listening button queues a request when there is no iTerm tab to type into
# (<home>/pending-listen/<key>.json; <home> is $ONCE_UPON_HOME or ~/.once-upon). Wire this script to SessionStart and
# UserPromptSubmit (`once-upon install-hooks` prints the settings.json block). The first session whose folder is in that repo's
# checkout (or the story's checkout) and that gets a message you typed, or that is started fresh (SessionStart source "startup",
# not a compact, resume or clear), claims the request and is told to run the /once-upon-listen skill before it answers. A request
# lapses after 15 minutes: the hook removes a lapsed one at the next prompt, and a listener that starts (the bridge's heartbeat)
# removes the request it covers. Keep typed-prompt.sh beside this script.
#
# This is the one hook here that answers with context (the documented {"hookSpecificOutput": {"hookEventName", "additionalContext"}}
# form, exit 0): require-beats.sh blocks with stderr and board-status.sh prints nothing. It always exits 0, and does nothing,
# without reading the prompt, when <home>/pending-listen has no request. Needs jq.
#
# The sentence it prints is built here from checked fields (the repo as owner/name, the story id as the bridge makes it), never
# copied from the file, so nothing from a PR can reach the session through it. A claim is a rename, so exactly one session
# takes a request; the claimed file is removed at once.
. "$(dirname "${BASH_SOURCE[0]}")/typed-prompt.sh" || exit 0
home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
dir="$home/pending-listen"
[ -d "$dir" ] || exit 0
compgen -G "$dir/*.json" >/dev/null || exit 0

# a lapsed request is removed here, so every later prompt takes the exit above (jq only for the files that are there)
now=$(($(date +%s) * 1000))
for file in "$dir"/*.json; do
  [ -f "$file" ] || continue
  gone="$(jq -r '(.expires // 0) | if type == "number" and . <= '"$now"' then "yes" else "" end' "$file" 2>/dev/null)"
  [ "$gone" = yes ] && rm -f "$file"
done
compgen -G "$dir/*.json" >/dev/null || exit 0

input="$(cat)"
IFS=$'\t' read -r event sid cwd agent how < <(printf '%s' "$input" |
  jq -r '[(.hook_event_name // "-"), (.session_id // "-"), (.cwd // "-"), ((.agent_id // .agent_type // "") | if . == "" then "-" else "agent" end), (.source // "-")] | @tsv' 2>/dev/null)
case "$event" in SessionStart | UserPromptSubmit) ;; *) exit 0 ;; esac
[[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] || exit 0
[ "$agent" = "-" ] || exit 0 # a subagent's call is not a message you typed
[[ "$cwd" == /* ]] || exit 0
# a session that started on its own (compact, resume, clear) is not a message you typed: only a fresh start counts
[ "$event" = UserPromptSubmit ] || [ "$how" = startup ] || exit 0

if [ "$event" = UserPromptSubmit ]; then
  # a prompt you did not type (another session's message, a notice, a task notification, a subagent's hand-back) leaves the request alone
  prompt="$(printf '%s' "$input" | jq -r '(.prompt // "") | sub("^\\s+"; "")' 2>/dev/null)"
  typed_by_you "$prompt" || exit 0
fi

for file in "$dir"/*.json; do
  [ -f "$file" ] || continue
  IFS=$'\t' read -r key repo story checkout expires < <(jq -r '[.key // "", (.repo // "-"), (.story // "-"), (.checkout // "-"), (.expires // 0)] | @tsv' "$file" 2>/dev/null)
  [[ "$key" =~ ^(repo|story)-[A-Za-z0-9._-]+$ ]] || continue
  [[ "$expires" =~ ^[0-9]+$ ]] && [ "$expires" -gt "$now" ] || continue
  if [ "$repo" != "-" ]; then
    [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || continue
    # this session's repo, owner/name, from origin: asked once, and only for a live request on a repo
    [ -n "${origin+x}" ] || origin="$(git -C "$cwd" remote get-url origin 2>/dev/null | sed -E 's#^.*[:/]([^/:]+/[^/]+)$#\1#; s#\.git$##')"
    [ -n "$origin" ] || continue
    shopt -s nocasematch
    [[ "$origin" == "$repo" ]]
    same=$?
    shopt -u nocasematch
    [ "$same" -eq 0 ] || continue
  elif [ "$story" != "-" ]; then
    # a story with no repo: the session is in the story's checkout, or a folder inside it
    [[ "$checkout" == /* && "$checkout" != *..* ]] || continue
    [ "$cwd" = "$checkout" ] || [[ "$cwd" == "${checkout%/}/"* ]] || continue
  else
    continue
  fi
  if [ "$story" != "-" ]; then
    [[ "$story" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$ ]] || continue
    args="--story $story --keep"
  else
    args="$repo --keep"
  fi
  mkdir -p "$dir/claimed" 2>/dev/null || exit 0
  claimed="$dir/claimed/$sid.$key.json"
  mv "$file" "$claimed" 2>/dev/null || continue # another session took it first
  rm -f "$claimed"
  jq -n -c --arg event "$event" --arg args "$args" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: ("The user pressed Start listening in Once Upon a Diff. Before answering their message, run the /once-upon-listen skill with arguments `" + $args + "`.")}}'
  exit 0
done
exit 0
