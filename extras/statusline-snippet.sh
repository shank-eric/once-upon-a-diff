#!/bin/bash
# Writes what the board shows as a session's context and usage. Claude Code's status line is the only place that has
# them, so call this from your status line script with its JSON input:
#   printf '%s' "$input" | /path/to/once-upon-a-diff/extras/statusline-snippet.sh
# It writes <home>/statusline/<session id>.json ({session_id, at, context, rate_limits}; <home> is $ONCE_UPON_HOME or
# ~/.once-upon) and prints nothing. The context is `used_percentage`, or computed from the token counts when a render has none.
# It does nothing when <home> doesn't exist. Needs jq.
input="$(cat)"
home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
if [ -d "$home" ] && [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]]; then
  mkdir -p "$home/statusline"
  tmp="$home/statusline/$sid.json.$$.tmp"
  if printf '%s' "$input" | jq -c --argjson at "$(date +%s)" \
    '{session_id, at: $at,
      context: (.context_window.used_percentage // (
        if (.context_window.total_input_tokens != null) and ((.context_window.context_window_size // 0) != 0)
        then (.context_window.total_input_tokens / .context_window.context_window_size * 100) else null end)),
      rate_limits}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$home/statusline/$sid.json"
  else
    rm -f "$tmp"
  fi
fi
exit 0
