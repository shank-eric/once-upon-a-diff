#!/bin/bash
# Print "<VIEWED|UNVIEWED|DISMISSED>\t<path>" for every file in a PR, as the
# signed-in gh user has marked them on GitHub. Read-only GraphQL query.
#   viewed.sh <number> <owner/repo>
set -euo pipefail
[ "$(jq -r '.gh_unset_github_token // false' "${DIFF_STORY_HOME:-$HOME/.diff-story}/config.json" 2>/dev/null)" = true ] && unset GITHUB_TOKEN
PR="$1" REPO="$2"
# shellcheck disable=SC2016 # $owner, $name and $pr are GraphQL variables, not the shell's
gh api graphql --paginate -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){
  files(first:100, after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}' \
  --jq '.data.repository.pullRequest.files.nodes[] | "\(.viewerViewedState)\t\(.path)"'
