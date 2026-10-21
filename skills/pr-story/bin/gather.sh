#!/bin/bash
# Fetch everything pr-story needs for one PR into a scratch folder. Read-only:
# every call is a GET (gh pr view/diff/checks, gh api reads, GraphQL queries).
#
#   gather.sh <number|url> [owner/repo] -o <dir>
#
# Writes pr.json, pr.diff, comments.json, threads.json, checks.json,
# viewed.tsv and checkouts.txt (local clones of the repo under ~/Development).
set -euo pipefail
unset GITHUB_TOKEN   # the yarn-only token shadows the keychain login

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
OWNER=${REPO%/*} NAME=${REPO#*/}
mkdir -p "$OUT"
DIR="$(cd "$(dirname "$0")" && pwd)"

gh pr view "$PR" -R "$REPO" --json number,title,body,url,author,baseRefName,headRefName,baseRefOid,headRefOid,createdAt,updatedAt,mergedAt,closedAt,state,isDraft,additions,deletions,changedFiles,commits,reviews,reviewRequests,reviewDecision,mergeStateStatus,files > "$OUT/pr.json"

if ! gh pr diff "$PR" -R "$REPO" > "$OUT/pr.diff" 2> "$OUT/diff.err"; then
  echo "gh pr diff failed (often: diff too large). Build it from a local checkout instead:" >&2
  echo "  git -C <checkout> diff \$(jq -r .baseRefOid $OUT/pr.json)...\$(jq -r .headRefOid $OUT/pr.json) > $OUT/pr.diff" >&2
fi

gh api --paginate "repos/$REPO/pulls/$PR/comments" --jq '.[]' | jq -s . > "$OUT/comments.json"

gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){
  reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine
    comments(first:50){nodes{author{login} createdAt body}}}}}}}' \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | {path, line: (.line // .originalLine), resolved: .isResolved, outdated: .isOutdated, posts: [.comments.nodes[] | {by: .author.login, at: .createdAt, body}]}]' > "$OUT/threads.json"

gh pr checks "$PR" -R "$REPO" --json name,state,bucket,workflow,link > "$OUT/checks.json" 2>/dev/null || echo '[]' > "$OUT/checks.json"

"$DIR/viewed.sh" "$PR" "$REPO" > "$OUT/viewed.tsv"

# Local checkouts whose origin is this repo, newest base-branch commit first.
BASE=$(jq -r .baseRefName "$OUT/pr.json")
: > "$OUT/checkouts.txt"
for g in $(find "$HOME/Development" -maxdepth 4 -name .git -not -path '*/node_modules/*' 2>/dev/null); do
  d=$(dirname "$g")
  url=$(git -C "$d" remote get-url origin 2>/dev/null || true)
  case "$url" in *[:/]"$REPO"|*[:/]"$REPO".git)
    when=$(git -C "$d" log -1 --format=%cI "origin/$BASE" 2>/dev/null || echo unknown)
    echo "$when	$d" >> "$OUT/checkouts.txt" ;;
  esac
done
sort -r -o "$OUT/checkouts.txt" "$OUT/checkouts.txt"

echo "Gathered $REPO#$PR into $OUT"
echo "Local checkouts (origin/$BASE last commit, path):"; sed 's/^/  /' "$OUT/checkouts.txt"
