#!/bin/bash
# SubagentStop hook: when a background agent stops with its run still registered as running, ends that run
# (`once-upon agent auto-finish`: an author or critic run is failed, outcome "stopped without agent finish", so its card shows
# a failure; a helper, researcher or storyteller is done, outcome "auto-finished"; one that is waiting, at
# a plan, parked on a review, standing, an editor or a --self run is left alone). Only when Claude Code's agent-<id>.meta.json
# says `"finished": true`: a stop that is only a turn end (the agent waits on its own background run) changes nothing. The agent should still finish itself with
# `once-upon agent finish`: that finish replaces this one. The run is found from the subagent's own files (the Agent tool's
# name in agent-<id>.meta.json beside its transcript, or the `<name>: ` that starts its description), and the launching
# session from the transcript's folder, so nothing is guessed: no match, no change.
# Add it to settings.json, in the SubagentStop group:
#   "hooks": { "SubagentStop": [ { "hooks": [ { "type": "command", "command": "/path/to/once-upon-a-diff/extras/hooks/auto-finish-run.sh" } ] } ] }
# Every stop's raw input is appended, one line each, to <home>/logs/subagent-stop.jsonl (<home> is $ONCE_UPON_HOME or
# ~/.once-upon), so you can see what Claude Code sent when a run was not matched. Prints nothing, always exits 0 (it can never
# hold a stop), and does nothing when <home> doesn't exist. Needs python3 and once-upon (on Node 24, or through fnm).
home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
[ -d "$home" ] || exit 0

# the raw input logged; then the transcript and the session id, only when the subagent has a name to look for (so a subagent
# of something else never starts node)
fields=$(ONCE_UPON_HOOK_HOME="$home" /usr/bin/python3 -c '
import json, os, re, sys
raw = sys.stdin.read()
home = os.environ["ONCE_UPON_HOOK_HOME"]
try:
    os.makedirs(home + "/logs", exist_ok=True)
    with open(home + "/logs/subagent-stop.jsonl", "a") as log:
        log.write(raw.replace("\n", " ").strip() + "\n")
except Exception:
    pass
try:
    event = json.loads(raw)
    transcript = event.get("agent_transcript_path")
    meta = json.load(open(transcript[: -len(".jsonl")] + ".meta.json"))
    # a subagent that ends a turn (waiting on its own background run) fires a stop too: only a finished one is done
    if meta.get("finished") is not True:
        raise SystemExit
    named = isinstance(meta.get("name"), str) and meta["name"] or re.match(r"[a-z0-9][a-z0-9-]*:", meta.get("description") or "")
    if named and transcript.endswith(".jsonl"):
        print(transcript)
        print(event.get("session_id") or "")
except Exception:
    pass
' 2>/dev/null)
transcript="$(printf '%s\n' "$fields" | sed -n 1p)"
session="$(printf '%s\n' "$fields" | sed -n 2p)"
[ -n "$transcript" ] || exit 0

if command -v once-upon >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 24 ] 2>/dev/null; then
  once-upon agent auto-finish --transcript "$transcript" --session "$session" >/dev/null 2>&1
elif command -v fnm >/dev/null 2>&1; then
  fnm exec --using=24 once-upon agent auto-finish --transcript "$transcript" --session "$session" >/dev/null 2>&1
fi
exit 0
