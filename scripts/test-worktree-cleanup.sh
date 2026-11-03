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
# 10b. a landed worktree holding only tool caches is removed; the same plus an untracked file, or a tracked change, is kept
printf '%s\n' .eslintcache .prettiercache '*.tsbuildinfo' .env '*.pem' '*.secret' >"$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm ign3
mk caches; mkdir -p "$W/caches/packages/web"
for f in .eslintcache .prettiercache packages/web/.eslintcache packages/web/x.tsbuildinfo; do echo 1 >"$W/caches/$f"; done
out="$(cleanup_landed_worktree "$R" "$W" caches main)"
echo "$out" | grep -q "removed worktree $W/caches" && [ ! -e "$W/caches" ] || fail "caches only: $out"
mk cachedirty; echo 1 >"$W/cachedirty/.eslintcache"; echo x >"$W/cachedirty/new.txt"
out="$(cleanup_landed_worktree "$R" "$W" cachedirty main)"
echo "$out" | grep -q "new.txt" && ! echo "$out" | grep -q "eslintcache" && [ -e "$W/cachedirty" ] || fail "caches + untracked: $out"
mk cachemod; echo 1 >"$W/cachemod/.prettiercache"; echo y >>"$W/cachemod/a"
out="$(cleanup_landed_worktree "$R" "$W" cachemod main)"
echo "$out" | grep -q "kept: it has changes" && [ -e "$W/cachemod" ] || fail "caches + modified: $out"
# 10c. generic folder names are not caches: hand-made or secret files under .cache or coverage keep the worktree
mk gen1; mkdir "$W/gen1/.cache"; echo S=1 >"$W/gen1/.cache/.env"
out="$(cleanup_landed_worktree "$R" "$W" gen1 main)"
echo "$out" | grep -q "\.cache/\.env" && [ -e "$W/gen1" ] || fail ".cache/.env: $out"
mk gen2; mkdir -p "$W/gen2/pkg/coverage"; echo k >"$W/gen2/pkg/coverage/key.secret"
out="$(cleanup_landed_worktree "$R" "$W" gen2 main)"
echo "$out" | grep -q "key.secret" && [ -e "$W/gen2" ] || fail "pkg/coverage/key.secret: $out"
printf '%s\n' .eslintcache .prettiercache '*.tsbuildinfo' .env '*.pem' '*.secret' /data/ >"$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm ign4
mk gen3; mkdir -p "$W/gen3/data/coverage"; echo 1,2 >"$W/gen3/data/coverage/survey.csv"
out="$(cleanup_landed_worktree "$R" "$W" gen3 main)"
echo "$out" | grep -q "survey.csv" && [ -e "$W/gen3" ] || fail "data/coverage/survey.csv: $out"
# 11. batch: landed branch loses its worktree AND its branch, tip is reported; dirty one keeps both
mk l1; echo 1 >"$W/l1/l1.txt"; git -C "$W/l1" add .; git -C "$W/l1" commit -qm l1
L1TIP="$(git -C "$W/l1" rev-parse HEAD)"
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$L1TIP" >/dev/null
out="$(cleanup_landed_branch "$R" "$W" l1 main)"
echo "$out" | grep -q "deleted branch l1 (was $L1TIP)" || fail "branch landed: $out"
[ ! -e "$W/l1" ] || fail "l1 worktree remains"
git -C "$R" rev-parse -q --verify refs/heads/l1 >/dev/null && fail "l1 branch remains"
mk l2; echo 2 >"$W/l2/l2.txt"; git -C "$W/l2" add .; git -C "$W/l2" commit -qm l2
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$(git -C "$W/l2" rev-parse HEAD)" >/dev/null
echo dirt >"$W/l2/scratch.txt"
out="$(cleanup_landed_branch "$R" "$W" l2 main)"
echo "$out" | grep -q "kept: it has changes" && echo "$out" | grep -q "branch l2 kept" || fail "branch dirty: $out"
[ -e "$W/l2" ] && git -C "$R" rev-parse -q --verify refs/heads/l2 >/dev/null || fail "l2 lost"
# 12. unlanded and protected branches are never deleted
out="$(cleanup_landed_branch "$R" "$W" ahead main)"
git -C "$R" rev-parse -q --verify refs/heads/ahead >/dev/null || fail "ahead deleted: $out"
cleanup_landed_branch "$R" "$W" main main >/dev/null; git -C "$R" rev-parse -q --verify refs/heads/main >/dev/null || fail "main deleted"
# 13. regressions: big unlanded list (pipefail+grep -q), same-named tags, merge commits
mk big
{ for i in $(seq 1 1600); do printf 'commit refs/heads/big\ncommitter t <t@t> %s +0000\ndata 1\nx\n' "$((1000000+i))"; [ "$i" = 1 ] && echo 'from refs/heads/main^0'; printf 'M 644 inline f%s.txt\ndata 2\nx\n\n' "$i"; done; } | git -C "$R" fast-import --quiet
git -C "$W/big" reset -q --hard big
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$(git -C "$R" rev-parse big)" >/dev/null 2>&1 || git -C "$R" cherry-pick --abort 2>/dev/null || true
out="$(cleanup_landed_branch "$R" "$W" big main)"
git -C "$R" rev-parse -q --verify refs/heads/big >/dev/null && [ -e "$W/big" ] || fail "big deleted: $out"
mk tg
echo t >"$W/tg/t.txt"; git -C "$W/tg" add .; git -C "$W/tg" commit -qm tg1
git -C "$R" cherry-pick "$(git -C "$W/tg" rev-parse HEAD)" >/dev/null
echo u >"$W/tg/u.txt"; git -C "$W/tg" add .; git -C "$W/tg" commit -qm tg2
git -C "$R" tag tg "$(git -C "$W/tg" rev-parse HEAD~1)"
out="$(cleanup_landed_branch "$R" "$W" tg main)"
git -C "$R" rev-parse -q --verify refs/heads/tg >/dev/null || fail "tag-shadowed branch deleted: $out"
mk tm
echo m >"$W/tm/m.txt"; git -C "$W/tm" add .; git -C "$W/tm" commit -qm tm1
git -C "$R" tag main "$(git -C "$W/tm" rev-parse HEAD)"
out="$(cleanup_landed_branch "$R" "$W" tm main)"
git -C "$R" tag -d main >/dev/null
git -C "$R" rev-parse -q --verify refs/heads/tm >/dev/null || fail "tag named main fooled it: $out"
mk mg
mk side
echo s >"$W/side/s.txt"; git -C "$W/side" add .; git -C "$W/side" commit -qm side
git -C "$R" cherry-pick "$(git -C "$W/side" rev-parse HEAD)" >/dev/null
git -C "$W/mg" merge -q --no-commit --no-ff side 2>/dev/null || true
echo evil >"$W/mg/evil.txt"; git -C "$W/mg" add .; git -C "$W/mg" commit -qm merge
out="$(cleanup_landed_branch "$R" "$W" mg main)"
git -C "$R" rev-parse -q --verify refs/heads/mg >/dev/null && [ -e "$W/mg/evil.txt" ] || fail "merge branch deleted: $out"
echo "worktree-cleanup self-test: ok"
