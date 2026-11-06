#!/bin/bash
# PreToolUse hook for the Agent tool: stops a launch whose brief doesn't tell the agent to post progress beats with
# beat.sh, so every subagent shows its N/M progress. A brief can opt out by containing "no-beats".
# Add it to settings.json:
#   "hooks": { "PreToolUse": [ { "matcher": "Agent", "hooks": [ { "type": "command", "command": "/path/to/once-upon-a-diff/extras/hooks/require-beats.sh" } ] } ] }

prompt=$(/usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin).get("tool_input", {}).get("prompt", ""))')
beat="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/beat.sh"

if [[ "$prompt" == *beat.sh* || "$prompt" == *no-beats* ]]; then
  exit 0
fi

echo "Agent brief is missing progress beats. Add: post beats with $beat <tag> <N>/<M> <step> \"<few words>\", where M is the step count from the agent's plan (default 6: 1 read, 2 plan, 3 code, 4 tests, 5 green, 6 done) and the last beat is M/M, with <tag> also in the description. Or put no-beats in the brief to skip." >&2
exit 2
