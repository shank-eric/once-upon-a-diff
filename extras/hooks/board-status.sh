#!/bin/bash
# Tells the board when a Claude Code session is waiting on you or finished, in any terminal. Wire it to these hook events
# (the README's "Board status hook" has the settings.json block): UserPromptSubmit, PreToolUse (matcher AskUserQuestion),
# PermissionRequest, Notification (matcher permission_prompt|elicitation_dialog), PostToolUse, Stop and SessionEnd.
# It writes <home>/status/<session id>.json ({session_id, at (ms), state: working|waiting|done, detail, event}; <home> is
# $ONCE_UPON_HOME or ~/.once-upon), prints nothing and always exits 0. It does nothing when <home> doesn't exist. Needs jq.
#
# Stop is the one judgment call: the turn is Waiting when the last line of the reply is a question or a handoff line
# ("Next ...", "Up next ...", "Queued ...", "Still to do ..."), else Done. Edit the `if` under "Stop" to change that.
# A turn you didn't start is never Waiting: a message from another session, a subagent's hand-back and a task notification
# all fire UserPromptSubmit too, so the file records who began the turn ("origin": user or peer) and Stop reads it. A Stop
# hook that blocks (stop_hook_active) runs this Stop again after the turn goes on; the origin is kept, so the last one counts.
# A Stop with no prompt hook before it (a queued prompt, a restart) is not a turn you started either.
input="$(cat)"
home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
[ -d "$home" ] || exit 0
read -r event sid < <(printf '%s' "$input" | jq -r '[.hook_event_name // "", .session_id // ""] | @tsv' 2>/dev/null)
[[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] || exit 0
file="$home/status/$sid.json"

field() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

# who began the turn the file describes: user, peer, or unknown (no file, or one from before this field)
origin_now() { jq -r '.origin // "unknown"' "$file" 2>/dev/null || echo unknown; }

# put STATE DETAIL [ORIGIN]: the file's new content, written whole (tmp + mv), so a read never sees half of it
put() {
  mkdir -p "$home/status" 2>/dev/null || return 0
  local tmp="$file.$$.tmp" origin="${3:-$(origin_now)}"
  if jq -n -c --arg sid "$sid" --arg state "$1" --arg detail "$2" --arg event "$event" --arg origin "$origin" \
    '{session_id: $sid, at: (now * 1000 | floor), state: $state,
      detail: (if $detail == "" then null else $detail[:300] end), event: $event, origin: $origin}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}

case "$event" in
  UserPromptSubmit)
    case "$(field '(.prompt // "") | sub("^\\s+"; "")')" in
      "<cross-session-message"* | "<task-notification"* | "<agent-message"* | "<system-reminder"* | \
        "Another Claude session sent a message"* | "[Subagent hand-back]"*)
        put working "" peer
        ;;
      *) put working "" user ;;
    esac
    ;;
  PreToolUse)
    # a question put to you through the AskUserQuestion tool; PostToolUse clears it when you answer
    if [ "$(field '.tool_name // ""')" = AskUserQuestion ]; then
      put waiting "$(field '.tool_input.questions[0].question // ""')"
    fi
    ;;
  PermissionRequest)
    put waiting "$(field '"Needs your approval: " + (.tool_name // "a tool")')"
    ;;
  Notification)
    # only the two notifications that wait on you (the settings matcher says the same; this holds without it)
    case "$(field '.notification_type // "permission_prompt"')" in
      permission_prompt | elicitation_dialog) put waiting "$(field '.message // ""')" ;;
    esac
    ;;
  PostToolUse)
    # a tool ran, so an approval or an answer let the turn go on; one grep per tool call, a write only after a wait
    if grep -q '"state":"waiting"' "$file" 2>/dev/null; then
      put working ""
    fi
    ;;
  Stop)
    last="$(field '(.last_assistant_message // "") | split("\n") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | last // ""')"
    last="$(printf '%s' "$last" | sed -E 's/^[*_#>[:space:]-]+//' | sed -E "s/[*_)\"'[:space:]]+\$//")"
    state=done
    # only a turn you started (UserPromptSubmit wrote origin "user") can wait on you; a Stop right after a Stop with no
    # prompt between began with no prompt hook at all, unless the last one blocked and the turn went on (stop_hook_active)
    if grep -q '"origin":"user"' "$file" 2>/dev/null &&
      { [ "$(field '.stop_hook_active // false')" = true ] || ! grep -q '"event":"Stop"' "$file" 2>/dev/null; }; then
      shopt -s nocasematch
      if [[ "$last" == *"?" || "$last" =~ ^(next|up\ next|queued|still\ to\ do)([[:space:]:]|$) ]]; then
        state=waiting
      fi
      shopt -u nocasematch
    fi
    if [ "$state" = waiting ]; then put waiting "$last"; else put done ""; fi
    ;;
  SessionEnd)
    rm -f "$file"
    ;;
esac
exit 0
