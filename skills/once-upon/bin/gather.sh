#!/bin/bash
# Fetch everything once-upon needs for one PR into a scratch folder. Read-only:
# every call is a GET (gh pr view/diff/checks, gh api reads, GraphQL queries).
#
#   gather.sh <number|url> [owner/repo] -o <dir>
#
# Writes pr.json, pr.diff, threads.json (review comments by thread), checks.json,
# viewed.tsv and checkouts.txt (local clones of the repo under the checkout folders:
# ONCE_UPON_DEV_DIR, else checkout_dirs in ~/.once-upon/config.json, else ~/Development).
set -euo pipefail
CONFIG="${ONCE_UPON_HOME:-$HOME/.once-upon}/config.json"
# gh_unset_github_token: true in config.json drops GITHUB_TOKEN so gh uses its own (keychain) login
[ "$(jq -r '.gh_unset_github_token // false' "$CONFIG" 2>/dev/null)" = true ] && unset GITHUB_TOKEN

PR="" REPO="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    */*/pull/*) REPO=$(sed -E 's#^https?://github.com/([^/]+/[^/]+)/pull/.*#\1#' <<<"$1")
                PR=$(sed -E 's#.*/pull/([0-9]+).*#\1#' <<<"$1"); shift ;;
    */*) REPO="$1"; shift ;;
    *) PR="$1"; shift ;;
  esac
done
[ -n "$PR" ] && [ -n "$OUT" ] || { echo "usage: gather.sh <number|url> [owner/repo] -o <dir>" >&2; exit 1; }
[ -n "$REPO" ] || REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# only owner/name and a number, so nothing here reaches gh as a flag, a file (@path) or another type
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "gather.sh: not an owner/repo: $REPO" >&2; exit 1; }
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "gather.sh: not a PR number: $PR" >&2; exit 1; }
OWNER=${REPO%/*} NAME=${REPO#*/}
mkdir -p "$OUT"
DIR="$(cd "$(dirname "$0")" && pwd)"

gh pr view "$PR" -R "$REPO" --json number,title,body,url,author,baseRefName,headRefName,baseRefOid,headRefOid,createdAt,updatedAt,mergedAt,closedAt,state,isDraft,additions,deletions,changedFiles,commits,reviews,reviewRequests,reviewDecision,mergeStateStatus,files > "$OUT/pr.json"

if ! gh pr diff "$PR" -R "$REPO" > "$OUT/pr.diff" 2> "$OUT/diff.err"; then
  echo "gh pr diff failed (often: diff too large). Build it from a local checkout instead:" >&2
  echo "  git -C <checkout> diff \$(jq -r .baseRefOid $OUT/pr.json)...\$(jq -r .headRefOid $OUT/pr.json) > $OUT/pr.diff" >&2
fi

# shellcheck disable=SC2016 # $owner, $name and $pr are GraphQL variables, not the shell's
gh api graphql -f owner="$OWNER" -f name="$NAME" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
  reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine
    comments(first:50){nodes{author{login} createdAt body}}}}}}}' \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | {path, line: (.line // .originalLine), resolved: .isResolved, outdated: .isOutdated, posts: [.comments.nodes[] | {by: .author.login, at: .createdAt, body}]}]' > "$OUT/threads.json"

gh pr checks "$PR" -R "$REPO" --json name,state,bucket,workflow,link > "$OUT/checks.json" 2>/dev/null || echo '[]' > "$OUT/checks.json"

"$DIR/viewed.sh" "$PR" "$REPO" > "$OUT/viewed.tsv"

# Local checkouts whose origin is this repo, newest base-branch commit first.
BASE=$(jq -r .baseRefName "$OUT/pr.json")
: > "$OUT/checkouts.txt"
if [ -n "${ONCE_UPON_DEV_DIR:-}" ]; then ROOTS=("$ONCE_UPON_DEV_DIR")
else
  ROOTS=()
  while IFS= read -r r; do [ -n "$r" ] && ROOTS+=("${r/#\~/$HOME}"); done < <(jq -r '.checkout_dirs // [] | .[]' "$CONFIG" 2>/dev/null || true)
  [ ${#ROOTS[@]} -gt 0 ] || ROOTS=("$HOME/Development")
fi
for g in $(find "${ROOTS[@]}" -maxdepth 4 -name .git -not -path '*/node_modules/*' 2>/dev/null | sort -u); do
  d=$(dirname "$g")
  url=$(git -C "$d" remote get-url origin 2>/dev/null || true)
  case "$url" in *[:/]"$REPO"|*[:/]"$REPO".git)
    when=$(git -C "$d" log -1 --format=%cI "origin/$BASE" 2>/dev/null || echo unknown)
    echo "$when	$d" >> "$OUT/checkouts.txt" ;;
  esac
done
sort -r -u -o "$OUT/checkouts.txt" "$OUT/checkouts.txt"

echo "Gathered $REPO#$PR into $OUT"
echo "Local checkouts (origin/$BASE last commit, path):"; sed 's/^/  /' "$OUT/checkouts.txt"
