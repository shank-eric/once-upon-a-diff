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
printf '%s\n' node_modules dist build '.venv*' __pycache__ '*.log' .wxt .output .yarn/cache .husky/_ .env '*.pem' >"$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm ign2
mk regen
mkdir -p "$W/regen/node_modules/x" "$W/regen/packages/a/node_modules/y" "$W/regen/dist" "$W/regen/build" "$W/regen/.venv-app" "$W/regen/pkg/__pycache__" "$W/regen/.yarn/cache" "$W/regen/.husky/_" "$W/regen/packages/extension/.wxt/types"
for f in node_modules/x/i dist/o build/o .venv-app/p pkg/__pycache__/c .yarn/cache/z .husky/_/h packages/a/node_modules/y/i run.log packages/extension/.wxt/types/t.d.ts; do echo 1 >"$W/regen/$f"; done
ln -s /tmp "$W/regen/linked_nm" 2>/dev/null || true
out="$(cleanup_landed_worktree "$R" "$W" regen main)"
echo "$out" | grep -q "removed worktree $W/regen" || fail "regen: $out"
mk envf; mkdir "$W/envf/node_modules"; echo 1 >"$W/envf/node_modules/i"; echo S=1 >"$W/envf/.env"
out="$(cleanup_landed_worktree "$R" "$W" envf main)"
echo "$out" | grep -q "\.env" && [ -e "$W/envf" ] || fail "env: $out"
mk outonly; mkdir -p "$W/outonly/packages/client/extension/.output/chrome-mv3"; echo 1 >"$W/outonly/packages/client/extension/.output/chrome-mv3/m.json"
out="$(cleanup_landed_worktree "$R" "$W" outonly main)"
echo "$out" | grep -q "removed worktree $W/outonly" && [ ! -e "$W/outonly" ] || fail "extension .output only: $out"
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
# 14. a landed worktree's local story folder (.once-upon/<id>/, ignored) moves to <home>/<id>/ and the worktree goes
printf '# x\n/.once-upon/\n' >>"$R/.git/info/exclude"
export ONCE_UPON_HOME="$T/home"
story() { mkdir -p "$W/$1/.once-upon/$2"; echo '{}' >"$W/$1/.once-upon/$2/meta.json"; echo '{}' >"$W/$1/.once-upon/$2/chapters.json"; echo d >"$W/$1/.once-upon/$2/local.diff"; }
mk st; story st local-st-feat; echo 1 >"$W/st/.eslintcache"
out="$(cleanup_landed_worktree "$R" "$W" st main)"
echo "$out" | grep -q "moved story folder .once-upon/local-st-feat to $T/home/local-st-feat" && echo "$out" | grep -q "removed worktree $W/st" || fail "story: $out"
[ ! -e "$W/st" ] && [ -f "$T/home/local-st-feat/chapters.json" ] && [ -f "$T/home/local-st-feat/local.diff" ] || fail "story folder not kept outside"
# two story folders, patch mode through cleanup_landed_branch: both kept, worktree and branch go
mk st2; story st2 local-a; story st2 local-b; echo 3 >"$W/st2/s2.txt"; git -C "$W/st2" add s2.txt; git -C "$W/st2" commit -qm s2
GIT_COMMITTER_DATE=2001-01-01T00:00:00 git -C "$R" cherry-pick "$(git -C "$W/st2" rev-parse HEAD)" >/dev/null
out="$(cleanup_landed_branch "$R" "$W" st2 main)"
[ ! -e "$W/st2" ] && [ -f "$T/home/local-a/meta.json" ] && [ -f "$T/home/local-b/meta.json" ] && echo "$out" | grep -q "deleted branch st2" || fail "two stories: $out"
# a story folder plus another real file: nothing moves, worktree kept
mk st3; story st3 local-c; echo x >"$W/st3/new.txt"
out="$(cleanup_landed_worktree "$R" "$W" st3 main)"
echo "$out" | grep -q "new.txt" && [ -f "$W/st3/.once-upon/local-c/meta.json" ] && [ ! -e "$T/home/local-c" ] || fail "story+dirt: $out"
# the home already has that id: worktree kept, nothing overwritten
mk st4; story st4 local-st-feat; echo mine >"$T/home/local-st-feat/keep.txt"
out="$(cleanup_landed_worktree "$R" "$W" st4 main)"
echo "$out" | grep -q "no place to go" && [ -e "$W/st4" ] && [ -f "$T/home/local-st-feat/keep.txt" ] || fail "story exists: $out"
# a folder under .once-upon that is not a story (no chapters.json) is still unknown ignored files
mk st5; mkdir -p "$W/st5/.once-upon/notes"; echo n >"$W/st5/.once-upon/notes/n.txt"
out="$(cleanup_landed_worktree "$R" "$W" st5 main)"
echo "$out" | grep -q "kept: it has changes" && [ -e "$W/st5" ] || fail "non-story: $out"
unset ONCE_UPON_HOME
# 15. a cherry-pick onto changed context is still landed (git cherry says "+": patch-id hashes context); a different change is not
printf '%s\n' l1 l2 l3 l4 l5 l6 l7 l8 l9 l10 >"$R/ctx"; git -C "$R" add ctx; git -C "$R" commit -qm ctx
mk idle; mk idle2
for b in idle idle2; do sed -i.bak "s/^l7\$/l7 changed by $b/" "$W/$b/ctx"; rm -f "$W/$b/ctx.bak"; git -C "$W/$b" commit -qam "$b"; done
sed -i.bak 's/^l4$/l4 reworded/' "$R/ctx"; rm -f "$R/ctx.bak"; git -C "$R" commit -qam "reword l4, in the context of both"
git -C "$R" cherry-pick "$(git -C "$W/idle" rev-parse HEAD)" >/dev/null
git -C "$R" cherry main idle | grep -q '^+' && git -C "$R" cherry main idle2 | grep -q '^+' || fail "idle fixture: git cherry matched, so it tests nothing"
out="$(cleanup_landed_branch "$R" "$W" idle main)"
echo "$out" | grep -q "deleted branch idle " && [ ! -e "$W/idle" ] || fail "idle (changed context): $out"
out="$(cleanup_landed_branch "$R" "$W" idle2 main)"
echo "$out" | grep -q "branch idle2 kept" && [ -e "$W/idle2" ] || fail "idle2 (other change): $out"
# 16. a branch whose +/- lines match a different main commit in the same file, but is not on main, is kept
printf '%s\n' a b c d e f g h i j k l >"$R/lines"; git -C "$R" add lines; git -C "$R" commit -qm lines
mk lineb
sed -i.bak 's/^b$/b\
NEW/' "$W/lineb/lines"; rm -f "$W/lineb/lines.bak"; git -C "$W/lineb" commit -qam "lineb adds NEW after b"
sed -i.bak 's/^j$/j\
NEW/' "$R/lines"; rm -f "$R/lines.bak"; git -C "$R" commit -qam "main adds NEW after j"
git -C "$R" cherry main lineb | grep -q '^+' || fail "lineb fixture: git cherry matched, so it tests nothing"
out="$(cleanup_landed_branch "$R" "$W" lineb main)"
echo "$out" | grep -q "branch lineb kept" && [ -e "$W/lineb" ] && git -C "$R" rev-parse -q --verify refs/heads/lineb >/dev/null || fail "lineb (same lines elsewhere): $out"
# 17. a cherry-pick onto changed context that main then edited again is landed (the whole-branch merge no longer matches, the
# commit's +/- lines and its merge at the landing commit do); similar but not identical lines, or the same lines
# on a different spot, are not
printf '%s\n' m1 m2 m3 m4 m5 m6 m7 m8 m9 m10 >"$R/more"; git -C "$R" add more; git -C "$R" commit -qm more
mk late; mk similar
sed -i.bak "s/^m7\$/m7 changed by late/" "$W/late/more"; rm -f "$W/late/more.bak"; git -C "$W/late" commit -qam late
sed -i.bak "s/^m7\$/m7 changed by similar/" "$W/similar/more"; rm -f "$W/similar/more.bak"; git -C "$W/similar" commit -qam similar
sed -i.bak 's/^m5$/m5 reworded/' "$R/more"; rm -f "$R/more.bak"; git -C "$R" commit -qam "reword m5, in the context of the change"
git -C "$R" cherry-pick "$(git -C "$W/late" rev-parse HEAD)" >/dev/null
sed -i.bak 's/^m7 changed by late$/m7 changed by late, then by main/' "$R/more"; rm -f "$R/more.bak"; git -C "$R" commit -qam "main edits the line again"
git -C "$R" cherry main late | grep -q '^+' || fail "late fixture: git cherry matched, so it tests nothing"
[ "$(git -C "$R" merge-tree --write-tree main late 2>/dev/null | head -1)" != "$(git -C "$R" rev-parse 'main^{tree}')" ] || fail "late fixture: the merge no-op matched, so it tests nothing"
out="$(cleanup_landed_branch "$R" "$W" late main)"
echo "$out" | grep -q "deleted branch late " && [ ! -e "$W/late" ] || fail "late (main edited it again): $out"
out="$(cleanup_landed_branch "$R" "$W" similar main)"
echo "$out" | grep -q "branch similar kept" && [ -e "$W/similar" ] || fail "similar (not identical lines): $out"
# same +/- lines as a main commit, added at a different spot: kept, though main edited the file again
mk spot
sed -i.bak 's/^m2$/m2\
SPOT/' "$W/spot/more"; rm -f "$W/spot/more.bak"; git -C "$W/spot" commit -qam "spot adds SPOT after m2"
sed -i.bak 's/^m9$/m9\
SPOT/' "$R/more"; rm -f "$R/more.bak"; git -C "$R" commit -qam "main adds SPOT after m9"
sed -i.bak 's/^m9$/m9 again/' "$R/more"; rm -f "$R/more.bak"; git -C "$R" commit -qam "main edits m9"
out="$(cleanup_landed_branch "$R" "$W" spot main)"
echo "$out" | grep -q "branch spot kept" && [ -e "$W/spot" ] && git -C "$R" rev-parse -q --verify refs/heads/spot >/dev/null || fail "spot (same lines elsewhere, later edit): $out"
# 18. a later branch commit that only deletes lines an earlier branch commit added is not landed through an unrelated main
# commit that deleted the same text, even when the earlier commit alone was picked
printf '%s\n' d1 d2 d3 d4 d5 d6 DX d7 d8 d9 d10 d11 d12 d13 d14 >"$R/del"; git -C "$R" add del; git -C "$R" commit -qm del
mk fixup
sed -i.bak -e 's/^d2$/d2\
DX/' -e 's/^d13$/d13\
DY/' "$W/fixup/del"; rm -f "$W/fixup/del.bak"; git -C "$W/fixup" commit -qam "fixup A"
sed -i.bak '3d' "$W/fixup/del"; rm -f "$W/fixup/del.bak"; git -C "$W/fixup" commit -qam "fixup B drops the DX that A added"
sed -i.bak '/^DX$/d' "$R/del"; rm -f "$R/del.bak"; git -C "$R" commit -qam "main drops its own DX"
git -C "$R" cherry-pick "$(git -C "$W/fixup" rev-parse HEAD~1)" >/dev/null
sed -i.bak 's/^DY$/DY2/' "$R/del"; rm -f "$R/del.bak"; git -C "$R" commit -qam "main edits DY"
git -C "$R" cherry main fixup | grep -q '^+' || fail "fixup fixture: git cherry matched everything, so it tests nothing"
out="$(cleanup_landed_branch "$R" "$W" fixup main)"
echo "$out" | grep -q "branch fixup kept" && [ -e "$W/fixup" ] && git -C "$R" rev-parse -q --verify refs/heads/fixup >/dev/null || fail "fixup (delete of an unpicked add): $out"
# 19. a cherry-pick onto changed context that main then reverted is not landed
printf '%s\n' r1 r2 r3 r4 r5 r6 r7 >"$R/rev"; git -C "$R" add rev; git -C "$R" commit -qm rev
mk reverted
sed -i.bak 's/^r4$/r4 changed/' "$W/reverted/rev"; rm -f "$W/reverted/rev.bak"; git -C "$W/reverted" commit -qam reverted
sed -i.bak 's/^r2$/r2 ctx/' "$R/rev"; rm -f "$R/rev.bak"; git -C "$R" commit -qam "reword r2, in the context of the change"
git -C "$R" cherry-pick "$(git -C "$W/reverted" rev-parse HEAD)" >/dev/null
git -C "$R" revert --no-edit HEAD >/dev/null
git -C "$R" cherry main reverted | grep -q '^+' || fail "reverted fixture: git cherry matched, so it tests nothing"
out="$(cleanup_landed_branch "$R" "$W" reverted main)"
echo "$out" | grep -q "branch reverted kept" && [ -e "$W/reverted" ] && git -C "$R" rev-parse -q --verify refs/heads/reverted >/dev/null || fail "reverted (pick then revert): $out"
echo "worktree-cleanup self-test: ok"
