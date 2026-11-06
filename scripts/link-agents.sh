#!/usr/bin/env bash
# Links every agent definition in this checkout's agents/ into your Claude Code agents folder ($CLAUDE_AGENTS_DIR, else
# ~/.claude/agents), one file at a time, because that folder also holds your own definitions. A `git pull` then updates them.
# A link that is already right is left as it is; one that points somewhere else, or a real file, is left alone with a notice.
# `--relink` replaces a wrong link (never a real file). Claude Code watches an agents folder that existed when the session
# started, so start a new session if this run created the folder.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${CLAUDE_AGENTS_DIR:-$HOME/.claude/agents}"
relink=""
[ "${1:-}" = "--relink" ] && relink=1

if [ ! -d "$dest" ]; then
  mkdir -p "$dest"
  echo "created $dest: start a new Claude Code session to pick the agents up"
fi
for agent in "$root"/agents/*.md; do
  name="$(basename "$agent")"
  want="$root/agents/$name"
  link="$dest/$name"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$want" ]; then
      echo "ok: $name"
    elif [ -n "$relink" ]; then
      ln -sfn "$want" "$link"
      echo "relinked: $name -> $want"
    else
      echo "left alone: $link points to $(readlink "$link") (run with --relink to point it at $want)"
    fi
  elif [ -e "$link" ]; then
    echo "left alone: $link is not a link"
  else
    ln -s "$want" "$link"
    echo "linked: $name -> $want"
  fi
done
