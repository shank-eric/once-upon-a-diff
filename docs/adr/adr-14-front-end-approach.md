# ADR-14: Front-end approach: Preact and htm, vendored, one region at a time

Decided 10/29. Built for the board page, as of main at 0741c6c. At that point the story panel, the local page and the extension's tags still drew with `html` and `setHtml`; the updates below say when each moved. What was done and what was left is in ADR-16.

Update 11/3: the panel's frame, body, file list and viewed, change and working marks draw with Preact (the first of two branches). The panel names the vendored file as the pages do, `/assets/preact.mjs`: the bridge serves it, and the extension's Vite config aliases it to `packages/web/public/vendor/preact.mjs`, so both run the same bytes. Ask, drafts, fixes, rebuild and freshness still write strings into slots the body leaves, and the story's markdown stays a string renderer (`parse-markup.ts` turns its output into nodes).

Update 11/3 (second branch, first half): the Ask dock (the questions, the Ask box, the dock's header) and the status light with its checks, hint and who line draw with Preact too. Each part still keeps its own data and says `shell.redraw()`; the dock and the light are drawn by the parts' views (`chatDock.view()`, `statusLight.lightView()`...), and the markup a part builds as a string (an answer's markdown, the hint and who lines, which the bridge's tests read) is turned into nodes by `markup.ts`, which gives its jump links and Mark viewed pills their own handlers. Drafts, fixes, rebuild and freshness are the second half.

Update 11/3 (second branch, second half): the drafted comments with their buttons and counts, Fix before push with its editor, the working banner, the freshness line, the "Since you read it" banner and the Rebuild box draw with Preact, and the whole panel is on it. The body has no delegated click handler: every control and link has its own, and `data-rel` links jump through `refs.jumpProps`. A part works out its state in its `render()` (the counts, the clock-dependent lines) and the view draws it, so a count and the rows it counts come from one pass; the pure helpers (`draftView`, `requestLine`, `rebuildLine`) stay in files with no Preact, and the parts are `drafts-part.ts`, `freshness-part.ts` and `rebuild-part.ts`. `parse-markup.ts` still reads the story's markdown. `panel/test/no-string-dom.test.ts` pins where the panel still writes into the DOM by hand (the frame, the dock's drag, the host page's nodes), counting each write.

Update 11/4 and 11/5: the rest of the plan was carried out. The extension's tags, the story tag, its answers badge and the listen notice draw with Preact with no markup strings (11/4, 5dfe7d7), and the local page is one Preact tree drawn from one store (11/5, f734e66), so every region named under "Adopt it one region at a time" is on it. The generic components are in `packages/ui-kit` (ADR-15). What is left of `html` and `setHtml` is a few hand writes, pinned by a `no-string-dom` test in the panel, the extension, `ui-kit` and `web` (each counts through `test-kit`'s `dom-writes`). The "two idioms live side by side" consequence below no longer holds, and question 6 below is answered: the local page's diff view is components. The vendored file and the rule that the bridge serves it unchanged stand.

## Context

The pages and the panel build their UI the same way. `html`, a tagged template in `packages/domain/src/html.ts`, makes an escaped string, and `setHtml` puts it in with `innerHTML`. Clicks are handled by event delegation on `data-` attributes. That's about 12.8k lines across the story panel, the bridge's pages and the extension's content UI.

It held up for the panel, but the board showed the strain:

- `public/board.ts` was 1,751 lines with 16 module-level `let`s, seven `localStorage` keys that each had their own read function, and one click listener of about 365 lines that dispatched on `data-` attributes.
- Every 3 s `render()` rebuilt the whole board as one string, compared it to the last string, and replaced the page's HTML if it changed. It then put focus, the voice panel's scroll and any half-typed Add form back by hand.

Two constraints narrow the choice:

- **No build step for the panel and the bridge's pages.** The bridge serves `.ts` files with their types stripped (`packages/server/src/assets.ts`), and the same panel source runs on the local page. JSX would need a compile step on the bridge, or a build for `public/` and the other served packages. The pages' policy is `script-src 'self'`, so inline scripts, and so an inline import map, are out too.
- **The panel lives in a shadow root** on GitHub's page (and on the local page), and it must not touch GitHub's React tree. Whatever renders it has to work in a shadow root.

The extension is built by WXT (Vite), so it can bundle anything. The constraint is on the bridge-served side, and the panel is shared by both.

## Decision

- **Use Preact with htm**: htm's tagged templates give markup written like today's `html` templates with no compile step, and Preact does the rendering, with keyed diffing and components. `@preact/signals` is optional and not part of this decision.
- **Vendor it as one ESM file**, `htm/preact/standalone`, in `packages/web/public/vendor/` (`preact.mjs`, built by `packages/web/scripts/vendor-preact.ts`, served at `/assets/preact.mjs`), the way `highlight.mjs` is vendored (`scripts/vendor-hljs.ts`, served at `/assets/highlight.mjs`). The bridge serves it unchanged. A `preact.mjs.sha256` beside it is checked by a test and by the deploy script. No build step is added for the bridge pages or the panel.
- **Adopt it one region at a time, starting on the board page.** The board has no host page to fight and the most hand-restored state. The voice panel went first, then the rest of the board page (the header, the columns, the Backlog and the Worktrees lane) as one Preact tree. The local page, the panel (part by part, behind the same `context` until each part draws itself) and the extension's tags come after, whenever it suits. The old `html`/`setHtml` code keeps working next to the new until the last region moves.

### Options considered

| Option | Size (min+gz, approx.) | What it would be | Why not chosen |
|---|---|---|---|
| **Preact and htm** | ≈4–5 KB and ≈1 KB | chosen | |
| lit-html (or full Lit) | ≈3 KB (≈5–6 KB for Lit) | no build either. The template shape is closest to today's `html`, with `@click=${fn}` for events and `repeat()` for keyed lists, so the rewrite per template is smallest | It fixes the redraw but not where state lives, which is the other half of the board's problem. Full Lit means web components with a shadow root each, which could fight the board's shared stylesheet. Lit's decorators can't be type-stripped, so it would use plain `static properties` |
| A small homegrown helper | 0 KB | a `mount(el, view, state)` that re-renders on `setState`, plus `idiomorph` or similar (≈3 KB) to keep focus and scroll | It fixes the redraw, not the state spread, and adds another in-house piece to trace, which is the problem being solved |
| Stay as is | 0 | splitting `public/board.ts` into modules, with no new library | Splitting helps tracing, but the whole-page redraw and the hand-restored focus and scroll stay, and the board keeps growing in one file |

Preact's draw is that one piece covers both halves. Keyed diffing removes the hand restore, and components with state replace the module `let`s. A handler on the element it belongs to replaces the click switch. It reads like React, which many people know.

## Consequences

- The board page's redraw and restore code, the 7 `localStorage` read functions and the click switch are gone, replaced by components, `useSetting` and handlers on the elements. `packages/web/public/board.ts` is about 230 lines.
- Two idioms live side by side until the last region moves. (Since 11/5 the last region has moved.)
- **A third-party file to keep current.** It's one vendored file, updated by a script like highlight.js's, and the extension must bundle the same version. A `.d.mts` next to it types it for the editor and the tests, as `highlight.d.mts` does.
- **Bare imports don't resolve in the browser.** The panel's source is served to the local page type-stripped and also bundled by WXT, so it has to import the library one way that works for both. Either `assets.ts` rewrites the import while serving, or the panel imports a relative path to the vendored file.
- Preact puts event handlers on the elements it renders, so it doesn't depend on document-level delegation, which a shadow root retargets. The panel's host element and shadow root stay as they are.
- The `html`, `setHtml` and `innerHTML` code is the part with escaping rules. Components that use htm escape by default, but a region that still builds strings keeps the old care.
- Hooks and keyed lists are new idioms for this codebase.

## Questions it left, and how they came out

1. **How do the panel's imports resolve on both sides?** By a rewrite in `packages/server/src/assets.ts`: `forBrowser` turns the package specifiers into `/assets/` URLs as the bridge serves a module (`@once-upon-a-diff/{panel,protocol,host-github}/*` on 10/29; since 11/5 `{panel,contracts,github-page,bridge-client,ui-kit,domain}`, after the renames in ADR-15 and ADR-17), and a test (`packages/bridge/test/assets-graph.test.ts`) walks every import from the two page scripts. The vendored Preact is the one bare-looking path, `/assets/preact.mjs`.
2. **Does the vendored htm build need `unsafe-eval`?** The pages' policy is unchanged (`script-src 'self'`) and has no `unsafe-eval`. The board's tests run in linkedom, which does not enforce a policy, so the board page's first load in a browser under the policy is Eric's by-eye check.
3. **Plain hooks or `@preact/signals`?** Plain hooks. The board has `useSetting`, `useFocus` and effects in `packages/web/public/board/shared.ts`, and no signals dependency.
4. **Which region first?** The voice panel, then the rest of the board page.
5. **Should the `localStorage` helper and `gateText` be done first?** Yes, and they were, before the first region.
6. **Answered 11/5:** the panel's conversion finished on 11/3 (ADR-16), and the local page, diff view included, became one Preact tree on 11/5 (f734e66). It had been half answered: the open part was whether the diff view, which builds its DOM to match GitHub's, should become components or stay strings.
