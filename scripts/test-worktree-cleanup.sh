#!/usr/bin/env bash
# Self-test for scripts/lib/worktree-cleanup.sh in a temp repo. Run: scripts/test-worktree-cleanup.sh
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/worktree-cleanup.sh"
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
R="$T/repo"; W="$T/repo-worktrees"
git init -q -b main "$R"; git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo a >"$R/a"; git -C "$R" add a; git -C "$R" commit -qm one
mk() { git -C "$R" worktree add -q -b "$1" "$W/$1" main; }
fail() { echo "FAIL: $*"; exit 1; }
# 1. landed branch with a node_modules symlink: removed, branch kept
mk ok; ln -s /tmp "$W/ok/node_modules"
out="$(cleanup_landed_worktree "$R" "$W" ok main)"
echo "$out" | grep -q "removed worktree $W/ok" || fail "ok: $out"
[ ! -e "$W/ok" ] || fail "ok dir remains"
git -C "$R" rev-parse -q --verify refs/heads/ok >/dev/null || fail "branch deleted"
# 2. untracked real file: refused
mk dirty; echo x >"$W/dirty/new.txt"
out="$(cleanup_landed_worktree "$R" "$W" dirty main)"
echo "$out" | grep -q "kept: it has changes" && echo "$out" | grep -q "new.txt" || fail "dirty: $out"
[ -e "$W/dirty" ] || fail "dirty removed"
# 3. modified tracked file: refused
mk mod; echo y >>"$W/mod/a"
out="$(cleanup_landed_worktree "$R" "$W" mod main)"
echo "$out" | grep -q "kept: it has changes" || fail "mod: $out"
# 4. not an ancestor: kept
mk ahead; echo z >"$W/ahead/z"; git -C "$W/ahead" add z; git -C "$W/ahead" commit -qm two
out="$(cleanup_landed_worktree "$R" "$W" ahead main)"
echo "$out" | grep -q "not an ancestor" || fail "ahead: $out"
# 5. no worktree, or outside root: silent
[ -z "$(cleanup_landed_worktree "$R" "$W" nosuch main)" ] || fail "nosuch"
mkdir "$T/other"; [ -z "$(cleanup_landed_worktree "$R" "$T/other" ahead main)" ] || fail "outside root"
# 6. ignored real file (e.g. key.pem): refused
echo '*.pem' >"$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm ign
mk ign; echo k >"$W/ign/key.pem"
out="$(cleanup_landed_worktree "$R" "$W" ign main)"
echo "$out" | grep -q "kept: it has changes" && echo "$out" | grep -q "key.pem" && [ -e "$W/ign" ] || fail "ignored: $out"
# 7. status.showUntrackedFiles=no must not hide untracked files
mk hidden; echo x >"$W/hidden/secret.txt"; git -C "$R" config status.showUntrackedFiles no
out="$(cleanup_landed_worktree "$R" "$W" hidden main)"; git -C "$R" config --unset status.showUntrackedFiles
echo "$out" | grep -q "secret.txt" && [ -e "$W/hidden" ] || fail "showUntracked: $out"
# 8. failing git status counts as dirty
mk broken; echo "gitdir: /nonexistent" >"$W/broken/.git"
out="$(cleanup_landed_worktree "$R" "$W" broken main)"
echo "$out" | grep -q "kept" && [ -e "$W/broken" ] || fail "broken: $out"
# 9. batch (patch mode): cherry-picked branch is landed, partial pick is kept
mk b1; echo 1 >"$W/b1/b1.txt"; git -C "$W/b1" add .; git -C "$W/b1" commit -qm b1
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$(git -C "$W/b1" rev-parse HEAD)" >/dev/null
out="$(cleanup_landed_worktree "$R" "$W" b1 main patch)"
echo "$out" | grep -q "removed worktree $W/b1" || fail "patch landed: $out"
mk b2; echo 1 >"$W/b2/b2a.txt"; git -C "$W/b2" add .; git -C "$W/b2" commit -qm b2a
echo 2 >"$W/b2/b2b.txt"; git -C "$W/b2" add .; git -C "$W/b2" commit -qm b2b
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$(git -C "$W/b2" rev-parse HEAD~1)" >/dev/null
out="$(cleanup_landed_worktree "$R" "$W" b2 main patch)"
echo "$out" | grep -q "not every commit" && [ -e "$W/b2" ] || fail "patch partial: $out"
# 10. regenerable ignored paths are allowed, other ignored files (.env) still block
printf '%s\n' node_modules dist build '.venv*' __pycache__ '*.log' .wxt .yarn/cache .husky/_ .env '*.pem' >"$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm ign2
mk regen
mkdir -p "$W/regen/node_modules/x" "$W/regen/packages/a/node_modules/y" "$W/regen/dist" "$W/regen/build" "$W/regen/.venv-app" "$W/regen/pkg/__pycache__" "$W/regen/.yarn/cache" "$W/regen/.husky/_" "$W/regen/packages/extension/.wxt/types"
for f in node_modules/x/i dist/o build/o .venv-app/p pkg/__pycache__/c .yarn/cache/z .husky/_/h packages/a/node_modules/y/i run.log packages/extension/.wxt/types/t.d.ts; do echo 1 >"$W/regen/$f"; done
ln -s /tmp "$W/regen/linked_nm" 2>/dev/null || true
out="$(cleanup_landed_worktree "$R" "$W" regen main)"
echo "$out" | grep -q "removed worktree $W/regen" || fail "regen: $out"
mk envf; mkdir "$W/envf/node_modules"; echo 1 >"$W/envf/node_modules/i"; echo S=1 >"$W/envf/.env"
out="$(cleanup_landed_worktree "$R" "$W" envf main)"
echo "$out" | grep -q "\.env" && [ -e "$W/envf" ] || fail "env: $out"
echo "worktree-cleanup self-test: ok"
