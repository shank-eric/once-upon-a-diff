#!/usr/bin/env bash
# Links every skill in this checkout's skills/ into your Claude Code skills folder
# ($CLAUDE_SKILLS_DIR, else ~/.claude/skills), so a `git pull` updates them. A link that is already right is left as
# it is; one that points somewhere else, or a real folder, is left alone with a notice. `--relink` replaces a wrong
# link (never a real folder). Start a new Claude Code session to pick the skills up.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
relink=""
[ "${1:-}" = "--relink" ] && relink=1

mkdir -p "$dest"
for skill in "$root"/skills/*/; do
  name="$(basename "$skill")"
  want="$root/skills/$name"
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
