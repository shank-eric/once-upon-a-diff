#!/bin/bash
# PreToolUse hook for the Agent tool: stops a launch whose brief doesn't tell the agent to post progress beats with
# `once-upon beat`, so every subagent shows its N/M progress. A brief can opt out by containing "no-beats".
# Add it to settings.json:
#   "hooks": { "PreToolUse": [ { "matcher": "Agent", "hooks": [ { "type": "command", "command": "/path/to/once-upon-a-diff/extras/hooks/require-beats.sh" } ] } ] }

prompt=$(/usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin).get("tool_input", {}).get("prompt", ""))')

if [[ "$prompt" == *"once-upon beat"* || "$prompt" == *no-beats* ]]; then
  exit 0
fi

echo "Agent brief is missing progress beats. Add: post beats with fnm exec --using=24 once-upon beat <tag> <N>/<M> <step> \"<few words>\" (plain once-upon beat where the shell is on Node 24), where M is the step count from the agent's plan (default 6: 1 read, 2 plan, 3 code, 4 tests, 5 green, 6 done) and the last beat is M/M, with <tag> also in the description. A failing beat means Node 24 was not found: tell the launching session. Or put no-beats in the brief to skip." >&2
exit 2
