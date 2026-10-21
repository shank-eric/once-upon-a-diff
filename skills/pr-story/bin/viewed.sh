#!/bin/bash
# Print "<VIEWED|UNVIEWED|DISMISSED>\t<path>" for every file in a PR, as the
# signed-in user (Eric) has marked them on GitHub. Read-only GraphQL query.
#   viewed.sh <number> <owner/repo>
set -euo pipefail
unset GITHUB_TOKEN
PR="$1" REPO="$2"
gh api graphql --paginate -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$PR" -f query='
query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){
  files(first:100, after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}' \
  --jq '.data.repository.pullRequest.files.nodes[] | "\(.viewerViewedState)\t\(.path)"'
