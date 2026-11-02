# Sourced by deploy-local.sh. Removes a landed branch's worktree. Keeps the branch.
#
#   cleanup_landed_worktree <repo> <worktrees-dir> <branch> <landed-into-ref> [patch]
#
# Removes the worktree checked out on <branch> under <worktrees-dir> when <branch> is an ancestor of
# <landed-into-ref>. With "patch" (batch deploys, which cherry-pick), landed means every commit of <branch> has a
# patch-id match in <landed-into-ref> (git cherry) instead. Untracked or ignored symlinks (node_modules) are forced past. Any other untracked, ignored or modified
# file makes it refuse and say so. Prints one "deploy-local:" line either way. Never fails the caller.
cleanup_landed_worktree() {
  local repo="$1" root="$2" branch="$3" into="$4" mode="${5:-}" wt="" line cur dirt p out
  cur=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) cur="${line#worktree }" ;;
      "branch refs/heads/$branch") wt="$cur" ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain)
  [ -n "$wt" ] || return 0
  root="$(cd "$root" 2>/dev/null && pwd -P)" || return 0
  case "$wt" in "$root"/*) ;; *) return 0 ;; esac
  if [ "$mode" = patch ]; then
    out="$(git -C "$repo" cherry "$into" "$branch" 2>&1)" || out="+ cherry failed"
    if printf '%s\n' "$out" | grep -q '^+'; then
      echo "deploy-local: worktree $wt kept: not every commit of $branch is in $into by patch (batch deploy)"
      return 0
    fi
  elif ! git -C "$repo" merge-base --is-ancestor "$branch" "$into"; then
    echo "deploy-local: worktree $wt kept: $branch is not an ancestor of $into"
    return 0
  fi
  if ! out="$(git -C "$wt" status --porcelain --ignored --untracked-files=all 2>&1)"; then
    echo "deploy-local: worktree $wt kept: git status failed there"
    return 0
  fi
  dirt=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p="${line:3}"
    case "${line:0:2}" in "??" | "!!") [ -L "$wt/${p%/}" ] && continue ;; esac
    dirt="$dirt
  $line"
  done <<EOS
$out
EOS
  if [ -n "$dirt" ]; then
    echo "deploy-local: worktree $wt kept: it has changes besides untracked or ignored symlinks:$dirt"
    return 0
  fi
  if git -C "$repo" worktree remove --force "$wt" 2>/dev/null; then
    echo "deploy-local: removed worktree $wt"
  else
    echo "deploy-local: worktree $wt kept: git could not remove it"
  fi
  return 0
}
