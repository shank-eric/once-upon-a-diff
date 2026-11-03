# Sourced by deploy-local.sh. Removes a landed branch's worktree (and, for batch deploys, the branch: see cleanup_landed_branch).
#
#   cleanup_landed_worktree <repo> <worktrees-dir> <branch> <landed-into-ref> [patch]
#
# Removes the worktree checked out on <branch> under <worktrees-dir> when <branch> is an ancestor of
# <landed-into-ref>. With "patch" (batch deploys, which cherry-pick), landed means every commit of <branch> has a
# patch-id match in <landed-into-ref> (git cherry) instead. Untracked symlinks and regenerable ignored paths (node_modules, dist, build, .venv*, __pycache__, *.log, .yarn/cache, tool cache files such as .eslintcache and .prettiercache; never a generic folder like .cache or coverage, which can hold hand-made files) are forced past. Any other untracked, ignored or modified
# file makes it refuse and say so. Prints one "deploy-local:" line either way. Never fails the caller.
# Ignored paths that an install or build recreates. Anything else ignored (.env, *.pem, ...) blocks removal.
_regenerable() {
  case "$1" in
    node_modules | node_modules/* | */node_modules | */node_modules/*) return 0 ;;
    .yarn/cache | .yarn/cache/* | .yarn/install-state.gz | .husky/_ | .husky/_/*) return 0 ;;
    dist | dist/* | */dist | */dist/* | build | build/* | */build | */build/*) return 0 ;;
    .venv* | */.venv* | __pycache__ | */__pycache__ | */__pycache__/*) return 0 ;;
    .wxt | .wxt/* | */.wxt | */.wxt/*) return 0 ;;
    .eslintcache | */.eslintcache | .prettiercache | */.prettiercache | .stylelintcache | */.stylelintcache) return 0 ;;
    *.tsbuildinfo | .DS_Store | */.DS_Store | .pytest_cache | */.pytest_cache) return 0 ;;
    *.log) return 0 ;;
  esac
  return 1
}

# Succeeds only when every commit of local branch $2 has a patch-id match in local branch $3 and $2 has no merge
# commits of its own. Uses refs/heads/ names (a tag of the same name must not win) and no pipe (grep -q plus pipefail
# once let a big "+" list through). Any git failure means not landed.
_patch_landed() {
  local repo="$1" branch="$2" into="$3" out merges
  out="$(git -C "$repo" cherry "refs/heads/$into" "refs/heads/$branch" 2>/dev/null)" || return 1
  case $'\n'"$out" in *$'\n+'*) return 1 ;; esac
  merges="$(git -C "$repo" rev-list --merges "refs/heads/$into..refs/heads/$branch" 2>/dev/null)" || return 1
  [ -z "$merges" ]
}

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
    if ! _patch_landed "$repo" "$branch" "$into"; then
      echo "deploy-local: worktree $wt kept: not every commit of $branch is in $into by patch, or it has merge commits (batch deploy)"
      return 0
    fi
  elif ! git -C "$repo" merge-base --is-ancestor "refs/heads/$branch" "refs/heads/$into"; then
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
    case "${line:0:2}" in
      "??") [ -L "$wt/${p%/}" ] && continue ;;
      "!!") _regenerable "${p%/}" && continue ;;
    esac
    dirt="$dirt
  $line"
  done <<EOS
$out
EOS
  if [ -n "$dirt" ]; then
    echo "deploy-local: worktree $wt kept: it has changes besides untracked symlinks and regenerable ignored paths:$dirt"
    return 0
  fi
  if git -C "$repo" worktree remove --force "$wt" 2>/dev/null; then
    echo "deploy-local: removed worktree $wt"
  else
    echo "deploy-local: worktree $wt kept: git could not remove it"
  fi
  return 0
}

# Batch deploys: after cleanup_landed_worktree, delete a fully cherry-picked local branch.
#
#   cleanup_landed_branch <repo> <worktrees-dir> <branch> <landed-into-ref>
#
# Landed means `git cherry` shows only "-" lines. Removes the branch's worktree under <worktrees-dir> first (same
# dirty checks as cleanup_landed_worktree, never forced past a real change), then `git branch -D` and prints the
# tip sha so it can be restored with `git branch <branch> <sha>`. Skips main, master and deploy, a branch still
# checked out anywhere (the main checkout, the deploy worktree) and a dirty worktree. Never touches remotes.
# Sets DELETED_BRANCH_NOTE to "<branch>@<sha>" when it deleted one. Never fails the caller.
cleanup_landed_branch() {
  local repo="$1" root="$2" branch="$3" into="$4" tip
  DELETED_BRANCH_NOTE=""
  case "$branch" in main | master | deploy) return 0 ;; esac
  git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null || return 0
  if ! _patch_landed "$repo" "$branch" "$into"; then
    echo "deploy-local: branch $branch kept: not every commit is in $into by patch, or it has merge commits"
    return 0
  fi
  cleanup_landed_worktree "$repo" "$root" "$branch" "$into" patch || true
  tip="$(git -C "$repo" rev-parse "refs/heads/$branch")"
  if git -C "$repo" branch -D "$branch" >/dev/null 2>&1; then
    echo "deploy-local: deleted branch $branch (was $tip). Restore: git branch $branch $tip"
    DELETED_BRANCH_NOTE="$branch@$tip"
  else
    echo "deploy-local: branch $branch kept: it is still checked out in a worktree"
  fi
  return 0
}
