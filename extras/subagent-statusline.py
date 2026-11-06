#!/usr/bin/env python3
"""Subagent panel rows: show each running agent's newest progress beat.

Claude Code runs this for subagentStatusLine with the panel's rows as JSON on
stdin. Beats come from the file named by `board_progress_file` in Once Upon's config.json
(<home>/config.json, <home> = $ONCE_UPON_HOME or ~/.once-upon; the CLI's `agent beat` and scripts/beat.sh write it), one line
each: "- 11:02 PM stage-b 4/7 tests: what's done", where 7 is the agent's own step
count. A beat belongs to an agent when its tag (e.g. "stage-b") appears in the
agent's name or description, and it isn't timed before the agent started.
Rows with no beat print nothing, so Claude Code shows its default row.

Agents that finished but need the user's decision stay listed. Their newest ledger
line for this session (the file named by `board_ledger_file`) is
"- [waiting] sid:<8hex> [lane:<name>] <name> — <time ET>, <M/D> — needs <name>: <question> — <notes path>",
and a later [done]/[stopped]/[failed]/[running] line for the same name clears
it. The Agent tool no longer lists them, so each prints as an extra blue row.
"""

import json
import os
import re
import sys
import time
from pathlib import Path



def configured_file(key):
    """The path config.json gives for `key` (a leading ~/ expanded), or None when it is unset or unreadable."""
    home = Path(os.environ.get("ONCE_UPON_HOME") or Path.home() / ".once-upon")
    try:
        value = json.loads((home / "config.json").read_text()).get(key)
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(value, str) or not value:
        return None
    return Path(value).expanduser() if value.startswith("~/") else Path(value)


LEDGER_FILE = configured_file("board_ledger_file")
PROGRESS_FILE = configured_file("board_progress_file")
LEDGER_PATTERN = re.compile(
    r"^- \[(?P<kind>running|waiting|done|failed|stopped)\] sid:(?P<sid>\w+)(?: lane:\S+)? (?P<name>\S+)(?P<rest>.*)$"
)
WAITING_PATTERN = re.compile(
    r"^ — (?P<time>\d{1,2}:\d{2}(?: [AP]M)?)(?: ET)?, (?P<date>\d{1,2}/\d{1,2}) — needs [^:]+:\s*(?P<question>.*?)(?: — \S.*)?$"
)
WAITING_BLUE = "\x1b[38;2;95;135;255m"  # #5f87ff, iTerm's waiting color
RESET = "\x1b[0m"
BEAT_PATTERN = re.compile(
    r"^- (?P<time>\d{1,2}:\d{2} [AP]M)(?: ET)? (?P<tag>\S+) (?P<step>\d+)/(?P<of>\d+) (?P<label>\w+)(?::\s*(?P<note>.*))?$"
)
# Columns the panel uses before a row starts (tree glyphs and padding).
ROW_INDENT = 8


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def read_beats():
    try:
        lines = PROGRESS_FILE.read_text().splitlines()
    except (OSError, AttributeError):
        return []
    beats = []
    for line in lines:
        match = BEAT_PATTERN.match(line.strip())
        if match and 1 <= int(match["step"]) <= int(match["of"]):
            beats.append(match.groupdict())
    return beats


def waiting_agents(session_id):
    """Agents whose newest ledger line for this session is [waiting], oldest first."""
    if not session_id:
        return []
    try:
        lines = LEDGER_FILE.read_text().splitlines()
    except (OSError, AttributeError):
        return []
    today = "%d/%d" % (time.localtime().tm_mon, time.localtime().tm_mday)
    state = {}
    for line in lines:
        match = LEDGER_PATTERN.match(line.strip())
        if not match or match["sid"] != str(session_id)[:8]:
            continue
        name = match["name"]
        if match["kind"] != "waiting":
            state.pop(name, None)
            continue
        details = WAITING_PATTERN.match(match["rest"])
        if details and details["date"] != today:
            continue
        state.pop(name, None)
        state[name] = {
            "name": name,
            "time": details["time"] if details else "",
            "question": details["question"].strip() if details else match["rest"].strip(" —"),
        }
    return list(state.values())


def format_waiting_row(agent, columns):
    """Name, "waiting" and the short question on the left, time on the right, all blue."""
    left = "%s · waiting" % agent["name"]
    if agent["question"]:
        left = "%s · %s" % (left, agent["question"])
    right = agent["time"]
    width = (columns or 100) - ROW_INDENT
    room = width - len(right) - 2
    if len(left) > room:
        left = left[: max(room - 1, 0)] + "…"
    return WAITING_BLUE + left + " " * max(width - len(left) - len(right), 2) + right + RESET


def beat_epoch(beat, now):
    """The beat's time today, in epoch seconds (beats carry no date), or None."""
    try:
        clock = time.strptime(beat["time"], "%I:%M %p")
    except ValueError:
        return None
    day = time.localtime(now)
    return time.mktime((day.tm_year, day.tm_mon, day.tm_mday, clock.tm_hour, clock.tm_min, 0, 0, 0, -1))


def newest_beat_for(row, beats, now=None):
    """The newest beat whose tag is in the agent's name or description (not its activity text, which can
    name other agents), skipping beats timed before the agent started or later than now (another day's)."""
    now = time.time() if now is None else now
    row_slug = slugify(" ".join(str(row.get(key) or "") for key in ("name", "description")))
    start = row.get("startTime")
    start = start / 1000 if isinstance(start, (int, float)) and start > 0 else None
    for beat in reversed(beats):
        if slugify(beat["tag"]) not in row_slug:
            continue
        if start is not None:
            at = beat_epoch(beat, now)
            # a beat is stamped to the minute, so one in the agent's start minute counts
            if at is None or at < start - 60 or at > now + 60:
                continue
        return beat
    return None


def format_tokens(count):
    if not isinstance(count, (int, float)) or count <= 0:
        return ""
    if count >= 1000:
        return "%.1fk tokens" % (count / 1000)
    return "%d tokens" % count


def format_elapsed(start_ms):
    if not isinstance(start_ms, (int, float)) or start_ms <= 0:
        return ""
    seconds = max(0, int(time.time() - start_ms / 1000))
    if seconds >= 3600:
        return "%dh %dm" % (seconds // 3600, seconds % 3600 // 60)
    if seconds >= 60:
        return "%dm %ds" % (seconds // 60, seconds % 60)
    return "%ds" % seconds


def format_row(row, beat, columns):
    """Description, step name and current activity on the left; step count,
    percentage, elapsed time and tokens right-justified, like the built-in row."""
    step, of = int(beat["step"]), int(beat["of"])
    right_parts = ["%d/%d %d%%" % (step, of, round(100 * step / of))]
    for part in (format_elapsed(row.get("startTime")), format_tokens(row.get("tokenCount"))):
        if part:
            right_parts.append(part)
    right = " · ".join(right_parts)

    left = "%s · %s" % (row.get("description") or row.get("name") or "agent", beat["label"])
    activity = str(row.get("label") or "").strip()
    if activity:
        left = "%s · %s" % (left, activity)

    width = (columns or 100) - ROW_INDENT
    room = width - len(right) - 2
    if len(left) > room:
        left = left[: max(room - 1, 0)] + "…"
    return left + " " * max(width - len(left) - len(right), 2) + right


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    beats = read_beats()
    rows = payload.get("tasks") if isinstance(payload, dict) and "tasks" in payload else [payload]
    columns = payload.get("columns") if isinstance(payload, dict) else None
    if isinstance(payload, dict):
        listed = [slugify(" ".join(str(row.get(key) or "") for key in ("name", "description", "label"))) for row in rows if isinstance(row, dict) and row.get("status", "running") == "running"]
        for agent in waiting_agents(payload.get("session_id")):
            if any(slugify(agent["name"]) in text for text in listed):
                continue
            print(json.dumps({"id": "waiting:" + agent["name"], "content": format_waiting_row(agent, columns)}, ensure_ascii=False))
    for row in rows:
        if not isinstance(row, dict):
            continue
        beat = newest_beat_for(row, beats) if beats else None
        if beat is None:
            continue
        print(json.dumps({"id": row.get("id"), "content": format_row(row, beat, columns)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
