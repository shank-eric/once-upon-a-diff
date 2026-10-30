# Working on Once Upon a Diff

The repo is a Yarn workspaces monorepo in TypeScript, on Node 24 (`.nvmrc`: run `fnm use` or `nvm use` in the repo). Yarn runs the package scripts with the Node it runs on, so an older one stops them with one line saying so. The [README](README.md#code-layout) lays out the four packages: `packages/protocol` (the wire types, the route table and the request schemas), `packages/shared` (the panel and the helpers both sides use), `packages/bridge` (the bridge, the `once-upon` CLI and the local page) and `packages/extension` (the WXT extension). The skills stay in `skills/`.

## The everyday loop

```bash
yarn            # once, and after a pull
yarn dev        # rebuilds the extension on every change and reloads it in Chrome
yarn bridge     # in another tab: the bridge on your configured port
```

Load `packages/extension/.output/chrome-mv3` unpacked once. `yarn dev` and `yarn build` both write that folder, and the manifest's fixed key keeps the extension's ID (and its saved port and token) the same whichever made it. After a `yarn dev` session, run `yarn build`: the dev build's options page loads from the dev server, which is gone once you stop it.

The bridge has no build step. Node 24 strips the types and runs the `.ts` files as they are (the entries Node starts, `bin/once-upon.mjs` and the skill's `bin/story.mjs`, are plain JavaScript so an older Node can say it's too old instead of failing to load a `.ts`), so a change to the bridge needs a restart of `yarn bridge`, and a change to the panel or the local page needs only a reload of the local page (the bridge serves those modules type-stripped, re-read when the file changes). The extension bundles its own copy of the panel, so for GitHub, `yarn dev` picks the change up. The stylesheets the content scripts link (`panel/*.css`, `content/ui/*.css`) are copied into the build as they are rather than bundled, so a change to one shows after a `yarn build` (or a restart of `yarn dev`).

## Before you commit

```bash
yarn typecheck       # every package, strict
yarn lint
yarn format:check
yarn test            # every package's unit tests
yarn test:extension  # and yarn test:expand, when you touched the panel or the extension
```

The pre-commit hook runs ESLint and Prettier's check on what's staged.

## Writing TypeScript here

- Strict everywhere, and no `any`. Type JSON where it's read (`readJson<T>`, `JSON.parse(...) as T`), and keep casts for the places the DOM or a parsed file forces them, with a word on why when it isn't obvious.
- Only syntax Node can strip: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` checks), and `import type` for types (`verbatimModuleSyntax`). A class declares its fields with `declare`.
- Imports name the file, `.ts` included (`./reads.ts`). Across packages, import by name: `@once-upon-a-diff/shared/util/html`, `once-upon-a-diff/stories/chapters`. Inside `packages/shared`, keep imports relative: the local page loads those files straight into the browser. The panel names the shared helpers and the protocol by package, and the bridge rewrites those specifiers to `/assets/` URLs when it serves them.
- Package boundaries are lint rules (`eslint.boundaries.mjs`, run by `yarn lint`): the server (`bridge/src`) and the pages (`web/public`) never import each other, nothing imports an app (the pages, the extension), `shared` never imports the bridge, the panel or the apps, the panel (`packages/panel`) imports only the protocol and the shared helpers and is handed its host adapters (`shared/src/host`) instead of importing them, the panel's regions (`ask`, `drafts`, `fixes`, `reading`, `rebuild`) and the board page's (`header`, `columns`, `backlog`, `worktrees`, `voice`) import no other region, the extension never imports the bridge source, nothing that ships to the browser imports a Node built-in, the protocol imports nothing but Valibot, its `domain/` folder imports nothing at all, and no page, shared module, panel file or the extension imports `schemas.ts`. Tests and scripts are exempt. The rules for the packages still to come are in that file, commented out.
- The bridge and its clients share their data shapes and calls through `packages/protocol`. A new route is an entry in `src/routes.ts` (with its `keys`, which the bridge's tests compare with `page-key.ts`), a schema in `src/schemas.ts` if it takes a body, and a handler that calls `parseBody`. A page or the extension calls it with `bridge.call(ROUTES.name, {params, query, body})`. Change a shape there, and every side's typecheck says what to update.

## A release

`yarn zip` builds the Chrome Web Store zip into `packages/extension/.output/store/`, without the manifest's `key` (the store signs with its own). The `key` in `wxt.config.ts` is the public half of a key kept outside the repo; it only matters for signing a `.crx` or keeping the extension's ID on a first store upload.
