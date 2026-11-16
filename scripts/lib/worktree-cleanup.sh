# Sourced by deploy-local.sh. Removes a landed branch's worktree (and, for batch deploys, the branch: see cleanup_landed_branch).
#
#   cleanup_landed_worktree <repo> <worktrees-dir> <branch> <landed-into-ref> [patch]
#
# Removes the worktree checked out on <branch> under <worktrees-dir> when <branch> is an ancestor of
# <landed-into-ref>. With "patch" (batch deploys, which cherry-pick), landed means every commit of <branch> has a
# patch-id match in <landed-into-ref> (git cherry) instead. Untracked symlinks and regenerable ignored paths (node_modules, dist, build, .venv*, __pycache__, *.log, .yarn/cache, tool cache files such as .eslintcache and .prettiercache; never a generic folder like .cache or coverage, which can hold hand-made files) are forced past. A local story's folder (ignored `.once-upon/<id>/` holding meta.json and chapters.json) is moved
# to <home>/<id>/ (home is $ONCE_UPON_HOME, else ~/.once-upon), where the bridge still serves it, before the worktree goes; a
# folder already there keeps the worktree. Any other untracked, ignored or modified file makes it refuse and say so. Prints one "deploy-local:" line either way. Never fails the caller.
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

# Succeeds when commit $2 is in the line of $3 through a main commit with the same added and removed lines: some commit of
# $3 since their merge base has the same zero-context patch-id (git hashes no context and no line numbers), and redoing
# $2 onto that commit's own parent gives exactly that commit (`merge-tree --write-tree --merge-base=<$2's parent> <main
# commit's parent> $2` equals the main commit's tree). The merge is what pins the position: the same lines added somewhere
# else in the file merge in a second time and differ, and a later branch commit that only deletes lines an earlier one
# added cannot match, because the main commit's parent never had them. It is taken at the landing commit, not the tip, so
# later edits of main do not count against it; but a later main commit that undoes it (a `This reverts commit <it>`
# message, or the reverse patch-id of its diff) means not landed: the change is not on main. A conflict, a root commit or
# any git failure means not landed.
_commit_landed() {
  local repo="$1" commit="$2" into="$3" parent base want cands m merged mparent rev later
  parent="$(git -C "$repo" rev-parse --verify -q "$commit^" 2>/dev/null)" || return 1
  base="$(git -C "$repo" merge-base "refs/heads/$into" "$commit" 2>/dev/null)" || return 1
  want="$(git -C "$repo" log -1 --no-merges --format=%H -p -U0 "$commit" 2>/dev/null | git patch-id --stable 2>/dev/null)" || return 1
  want="${want%% *}"
  [ -n "$want" ] || return 1
  cands="$(git -C "$repo" log --no-merges --format=%H -p -U0 "$base..refs/heads/$into" 2>/dev/null | git patch-id --stable 2>/dev/null)" || return 1
  while read -r id m; do
    [ "$id" = "$want" ] || continue
    mparent="$(git -C "$repo" rev-parse --verify -q "$m^" 2>/dev/null)" || continue
    merged="$(git -C "$repo" merge-tree --write-tree "--merge-base=$parent" "$mparent" "$commit" 2>/dev/null)" || continue
    merged="${merged%%$'\n'*}"
    [ -n "$merged" ] && [ "$merged" = "$(git -C "$repo" rev-parse "$m^{tree}" 2>/dev/null)" ] || continue
    later="$(git -C "$repo" log --format=%H --grep="This reverts commit $m" "$m..refs/heads/$into" 2>/dev/null)" || continue
    [ -z "$later" ] || continue
    rev="$(git -C "$repo" diff -U0 "$m" "$mparent" 2>/dev/null | git patch-id --stable 2>/dev/null)" || continue
    rev="${rev%% *}"
    [ -n "$rev" ] || continue
    later="$(git -C "$repo" log --no-merges --format=%H -p -U0 "$m..refs/heads/$into" 2>/dev/null | git patch-id --stable 2>/dev/null)" || continue
    case $'\n'"$later" in *$'\n'"$rev "*) continue ;; esac
    return 0
  done <<<"$cands"
  return 1
}

# Succeeds only when local branch $2 is landed in local branch $3 and has no merge commits of its own. Landed means
# every commit of $2 has a patch-id match in $3 (git cherry), or else merging $2 into $3 changes nothing: `git
# merge-tree --write-tree` succeeds without a conflict and prints a tree equal to $3's. That second test covers a
# cherry-pick onto lines main has since changed (the patch-id hashes the context, so git cherry says "+") and, unlike
# a patch-id of the bare added and removed lines, cannot match an unrelated main commit that edits the same text
# elsewhere in the file. When main also changed those lines again after the pick, the merge no longer matches, so each
# "+" commit is checked on its own by _commit_landed (the bare patch-id, pinned by a merge at the landing commit).
# Uses refs/heads/ names (a tag of the same name must not win) and no pipe into grep -q (grep -q plus pipefail once let
# a big "+" list through). Any git failure or conflict means not landed.
_patch_landed() {
  local repo="$1" branch="$2" into="$3" out merges merged line
  out="$(git -C "$repo" cherry "refs/heads/$into" "refs/heads/$branch" 2>/dev/null)" || return 1
  merges="$(git -C "$repo" rev-list --merges "refs/heads/$into..refs/heads/$branch" 2>/dev/null)" || return 1
  [ -z "$merges" ] || return 1
  case $'\n'"$out" in *$'\n+'*) ;; *) return 0 ;; esac
  merged="$(git -C "$repo" merge-tree --write-tree "refs/heads/$into" "refs/heads/$branch" 2>/dev/null)" && {
    merged="${merged%%$'\n'*}"
    [ -z "$merged" ] || [ "$merged" != "$(git -C "$repo" rev-parse "refs/heads/$into^{tree}" 2>/dev/null)" ] || return 0
  }
  while IFS= read -r line; do
    case "$line" in
      "- "*) ;;
      "+ "*) _commit_landed "$repo" "${line#+ }" "$into" || return 1 ;;
      *) return 1 ;;
    esac
  done <<<"$out"
  return 0
}

# A local story's folder in worktree $1: succeeds (prints nothing) when `.once-upon/<id>` is a real folder with meta.json
# and chapters.json under a plain id. Sets nothing; callers move it.
_story_folder() {
  local wt="$1" id="$2"
  case "$id" in "" | . | .. | */* | .* | *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ -d "$wt/.once-upon/$id" ] && [ ! -L "$wt/.once-upon/$id" ] || return 1
  [ -f "$wt/.once-upon/$id/meta.json" ] && [ -f "$wt/.once-upon/$id/chapters.json" ]
}

cleanup_landed_worktree() {
  local repo="$1" root="$2" branch="$3" into="$4" mode="${5:-}" wt="" line cur dirt p out id home d
  local stories=()
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
      "!!")
        _regenerable "${p%/}" && continue
        case "${p%/}" in
          .once-upon | .once-upon/*)
            id="${p%/}"
            id="${id#.once-upon}"
            id="${id#/}"
            if [ -z "$id" ]; then # the whole folder, listed as one: every child must be a story folder
              for d in "$wt/.once-upon"/* "$wt/.once-upon"/.[!.]*; do
                [ -e "$d" ] || [ -L "$d" ] || continue
                if _story_folder "$wt" "${d##*/}"; then stories+=("${d##*/}"); else dirt="$dirt
  !! .once-upon/${d##*/}"; fi
              done
              continue
            fi
            id="${id%%/*}"
            if _story_folder "$wt" "$id"; then stories+=("$id"); continue; fi
            ;;
        esac
        ;;
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
  home="${ONCE_UPON_HOME:-$HOME/.once-upon}"
  for id in ${stories[@]+"${stories[@]}"}; do
    [ -d "$wt/.once-upon/$id" ] || continue # listed once per file, moved once
    if [ -e "$home/$id" ] || [ -L "$home/$id" ]; then
      echo "deploy-local: worktree $wt kept: its story folder .once-upon/$id has no place to go, $home/$id exists"
      return 0
    fi
    mkdir -p "$home" && mv "$wt/.once-upon/$id" "$home/$id" 2>/dev/null || {
      echo "deploy-local: worktree $wt kept: could not move its story folder .once-upon/$id to $home/$id"
      return 0
    }
    echo "deploy-local: moved story folder .once-upon/$id to $home/$id"
  done
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
