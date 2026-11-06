#!/bin/bash
# Post a subagent progress beat. Usage: beat.sh <tag> <N>/<M> <label> [note...]
#   beat.sh larmor-outreach 3/8 code "research on comparable tools"
# M is the agent's own step count from its plan, and the last beat is M/M. A bare N means N/6,
# the default steps: 1 read, 2 plan, 3 code, 4 tests, 5 green, 6 done.
#
# It appends `- 3:40 PM <tag> 3/8 code: <note>` (Eastern time, the form `once-upon agent beat` mirrors) to the file named
# by `board_progress_file` in <home>/config.json (<home> is $ONCE_UPON_HOME or ~/.once-upon; a leading ~/ is expanded).
# With no such setting no file is written. It then registers the beat with the agent registry, best effort and
# detached, so it can never fail or delay this script. The CLI is, in order: $ONCE_UPON_CLI (a command line),
# `once-upon` on PATH or this checkout's bin when the first `node` is 24 or newer, else fnm's Node 24.

if [[ $# -lt 3 ]]; then
  echo "usage: beat.sh <tag> <N>/<M> <label> [note...]" >&2
  exit 1
fi

tag="$1"
step="$2"
label="$3"
shift 3
note="$*"

[[ "$step" =~ ^[0-9]+$ ]] && step="$step/6"
if [[ ! "$step" =~ ^([1-9][0-9]?)/([1-9][0-9]?)$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
  echo "beat.sh: step must be N/M with 1 <= N <= M <= 99, got '$step'" >&2
  exit 1
fi
if [[ "$tag" =~ [[:space:]] || "$label" =~ [^[:alnum:]_] ]]; then
  echo "beat.sh: tag can't contain spaces and label must be one word" >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${ONCE_UPON_HOME:-$HOME/.once-upon}"

progress=""
wrote=""
if command -v node >/dev/null 2>&1; then
  progress="$(node -e '
    try {
      const file = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).board_progress_file;
      if (typeof file === "string" && file) {
        process.stdout.write(file.startsWith("~/") ? require("path").join(require("os").homedir(), file.slice(2)) : file);
      }
    } catch {}
  ' "$home/config.json" 2>/dev/null)"
fi

if [[ -n "$progress" ]]; then
  line="- $(TZ=America/New_York date '+%-I:%M %p') $tag $step $label"
  [[ -n "$note" ]] && line="$line: $note"
  echo "$line" >> "$progress" || exit 1
  wrote=1
fi

# When the progress line is written above, the CLI adds only the event (--no-mirror); otherwise (no node to read the
# config with) the CLI mirrors the line itself. The note goes after -- so a note starting with -- stays a note.
# Runs from $HOME so a repo's .node-version can't change which Node runs.
args=("$tag" "$step" "$label")
[[ -n "$wrote" ]] && args+=(--no-mirror)
[[ -n "$note" ]] && args+=(-- "$note")
(
  cd "$HOME" || exit 0
  mjs="$here/../packages/bridge/bin/once-upon.mjs"
  if [[ -n "$ONCE_UPON_CLI" ]]; then
    # shellcheck disable=SC2086
    $ONCE_UPON_CLI agent beat "${args[@]}"
  elif [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 24 ]] 2>/dev/null; then
    if command -v once-upon >/dev/null 2>&1; then
      once-upon agent beat "${args[@]}"
    else
      node "$mjs" agent beat "${args[@]}"
    fi
  elif command -v fnm >/dev/null 2>&1; then
    if fnm exec --using=24 which once-upon >/dev/null 2>&1; then
      fnm exec --using=24 once-upon agent beat "${args[@]}"
    else
      fnm exec --using=24 node "$mjs" agent beat "${args[@]}"
    fi
  fi
) >/dev/null 2>&1 &
exit 0
