#!/usr/bin/env bash
# Puts the `once-upon` command on your PATH from this checkout: `npm link` on packages/bridge,
# whose package.json `bin` names bin/once-upon.mjs. The link points into the checkout, so moving
# packages around inside the repo needs no change here. Re-run it after moving the checkout itself.
# Others who don't clone can use `npx`/`npm i -g` once the package is published.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "Node 24 or newer is needed (this shell has $(node -v)). Run \`fnm use\` or \`nvm use\` in the repo, then re-run." >&2
  exit 1
fi

# yarn installs the workspace's dependencies, which the command loads from the checkout
[ -d "$root/node_modules" ] || (cd "$root" && yarn)

(cd "$root/packages/bridge" && npm link)

if command -v once-upon >/dev/null 2>&1; then
  echo "once-upon is linked: $(command -v once-upon)"
else
  echo "once-upon is linked but not on PATH yet: add $(npm prefix -g)/bin to PATH" >&2
fi
echo "The link lives in this Node version's global bin: re-run this script after switching Node or upgrading it."
echo "It runs under the \`node\` first on PATH, so keep a Node 24 as your default (fnm: \`fnm default 24\`)."
echo "To remove it: npm unlink -g once-upon-a-diff"
