# Structure proposal

Where the repo's layout stands after the panel and content-script pass, what still feels cramped, and a way to get the rest into shape in small steps that change no behavior. Nothing below the "Done" section has been started: each step waits for a go-ahead.

Line counts are after `yarn format` (Prettier at 100 columns), so they run about 1.6 times the pre-format counts.

## Done in this pass

- **Formatting and lint.** Prettier at 100 columns over the whole repo, braces on every block (`curly: all`), and `yarn lint` runs ESLint plus Prettier's check. `id-length` (3 or more, with `e`, `i`, `j`, `k`, `id`, `ok`, `el`, `pr`, `fs` allowed), `no-nested-ternary`, `no-sequences` and `no-unused-expressions` are errors in `src/js/` and warnings everywhere else.
- **The panel.** `src/js/shared/overlay.js` (3,246 lines) is now a 243-line entry plus 21 modules in `src/js/shared/panel/`, each with one job (see the README's Code layout). The modules share one `context` object and reach each other through it at call time, so there are no import cycles. Exports, rendered HTML, data attributes and `opts` are unchanged.
- **The content scripts.** `content/index.js` is a 45-line router by page kind. The pages are in `content/pages/`, the shared widgets in `content/ui/`.
- **Shared helpers.** What was copied between the panel, the content scripts, the local page and the bridge now has one home:

| Helper | Before | After |
| --- | --- | --- |
| `escapeHtml` | 6 copies, ≈6 lines each (overlay, tag, notice, status, local.js, server.mjs) | `shared/util/html.js`, 23 lines with `unescapeHtml` |
| `shortSha` | 3 copies (overlay, tag, builds.mjs) | `shared/util/text.js` |
| Clock and date-time formats | 4 copies (tag, status, overlay's backstory and questions) | `shared/util/time.js`, 29 lines |
| Clipboard write | 4 copies (3 in the overlay, content/copy.js) | `shared/util/clipboard.js`, 16 lines |
| PR path patterns | 4 regexes plus `isListPage` and `rangeOfPath` | `shared/util/github-paths.js`, 71 lines, with `pageKindOf` |
| Bridge messaging (`alive`, `bridge`) | 3 copies, ≈18 lines each | `content/bridge.js`, 24 lines |
| Key-event isolation | 5 loops | `shared/util/dom.js` `stopKeyEvents` |
| Story tag shadow host | 2 copies (list, Conversation tab) | `content/ui/tag-host.js`, 34 lines |
| `gh api` wrapper | 3 copies, 15 to 30 lines each (freshness, drafts, review) | `bridge/lib/util/gh.mjs`, 27 lines |
| JSON read with fallback, pretty and atomic writes | 6 readers, 5 writers, 1 atomic writer | `bridge/lib/util/json-file.mjs`, 26 lines |
| `REPO_RE` | 2 copies | `repos.mjs` only |

Net, those two helper commits removed 351 lines and added 412, most of the new lines being doc comments and the two new test files.

## The layout now

| Area | Files | Lines | Notes |
| --- | --- | --- | --- |
| `src/js/shared/` | overlay.js, 21 panel modules, 6 util modules, settings.js | 4,344 | The largest module is drafts.js at ≈410 |
| `src/js/content/` | router, bridge, storage, 4 pages, 6 ui modules | 1,685 | files-changed.js is 500 |
| `src/js/` other | background.js, options.js, content.js | 145 | |
| `bridge/bin/diff-story.mjs` | 1 | 633 | 18 commands in one file |
| `bridge/lib/` | 19 modules, util/ | 5,246 | backstory 1,130, server 834, stories 528 |
| `bridge/public/` | local page: local.js, split, narrow, syntax, css | ≈1,200 | local.js is 691 and still uses short names |
| `skills/pr-story/bin/` | pr-story.mjs, overlay.js, gather.sh, viewed.sh | ≈1,880 | overlay.js is an older copy of the panel |
| `test/` | 22 unit test files, 2 browser tests, fixtures | 5,656 | load-test.mjs is 1,040 |
| `scripts/` | make-icons, vendor-hljs | 160 | |
| Docs | README, GETTING-STARTED, two SKILL.md files | ≈840 | |

## What still hurts

1. **`bridge/lib/server.mjs`.** `createBridge` is one ≈680-line function holding every route, the request guards, the inbox, builds and drafts calls, and the two HTML pages (`indexPage`, `localPage`). Adding a route means reading all of it.
2. **`bridge/lib/backstory.mjs` (1,130 lines).** Four jobs in one file: reading the commit range, finding candidate Claude Code transcripts, running session-story's extractor, and matching the evidence into a timeline. The file's own `// ----------` headings already mark the seams.
3. **`bridge/bin/diff-story.mjs` (633 lines).** Argument parsing, the usage text and all 18 commands live in one file, and the usage block at the top has to be kept in step with the code by hand.
4. **`bridge/lib/stories.mjs` (528 lines).** The `StoryStore` class, reading meta and chapters, the backstory normalizer and the local diff refresh are mixed together.
5. **The skill duplicates the bridge.** `skills/pr-story/bin/pr-story.mjs` has its own `parseUnifiedDiff` (also `bridge/lib/diff.mjs`), `entryOf` (also `stories.mjs`, slightly different: the bridge's keeps backstory notes) and `textRefsOf` (the same rule as `bridge/lib/refs.mjs`, which its comment admits). It already imports `bridge/lib/config.mjs` from the repo, so it could import the rest too.
6. **`skills/pr-story/bin/overlay.js` (871 lines)** is the panel's ancestor, pasted into the page as a snippet for the skill's "GitHub mode". Every panel fix lands in only one of the two. If Diff Story Mode is now the way to show a story on GitHub, this snippet could go, or be generated from the panel modules with a small bundler step.
7. **Short names outside `src/js/`.** ESLint counts ≈530 short names in `bridge/`, ≈300 in `test/`, ≈150 in `skills/` and ≈30 in `scripts/`, plus ≈25 nested ternaries. They're warnings today.
8. **`bridge/public/local.js` (691 lines)** draws the local page's diff, folds, notes and Viewed state in one module, and keeps its own copy of the panel mount.
9. **Tests mirror old files, not modules.** `test/extension/load-test.mjs` is one 1,040-line script, and the unit tests are named for features (`since`, `pills`, `refs`) that now map onto specific modules.
10. **Naming.** A few names no longer say what they hold: `refs.mjs` (bridge, text line references) next to `file-refs.js` (panel), `place.mjs` (where story folders live), `health.mjs` (listeners and auto-answer), and `local.mjs` versus `public/local.js`.

## A target tree

```text
bridge/
  bin/diff-story.mjs            argument parsing and dispatch only
  cli/                          one file per command group
    serve.mjs  setup.mjs  stories.mjs  inbox.mjs  builds.mjs  drafts.mjs  doctor.mjs  backstory.mjs
  server/
    index.mjs                   createBridge: guards, body parsing, the route table
    routes/                     stories.mjs  questions.mjs  builds.mjs  drafts.mjs  reads.mjs  prefs.mjs  status.mjs
    pages.mjs                   the index and local HTML pages
    assets.mjs                  static and shared-module serving
  backstory/
    range.mjs  transcripts.mjs  extractor.mjs  evidence.mjs  timeline.mjs
  stories/
    store.mjs  meta.mjs  chapters.mjs (entryOf, text refs)  local-diff.mjs  placement.mjs (was place.mjs)
  github/                       gh-backed: freshness.mjs  drafts.mjs  review.mjs
  listeners/                    health.mjs split into listeners.mjs and auto-answer.mjs
  util/                         gh.mjs  json-file.mjs  git.mjs  diff.mjs
  public/
    local/                      local.js split into diff-view.js  folds.js  notes.js  mount.js
    split.js  narrow.js  syntax.js  local.css  vendor/
src/js/                         as it is now
skills/pr-story/bin/            pr-story.mjs importing bridge/stories/chapters.mjs and bridge/util/diff.mjs
test/
  unit/bridge/  unit/panel/  unit/content/  unit/util/
  browser/extension.mjs  browser/expand.mjs  browser/helpers.mjs
  fixtures/
docs/
```

## Migration order

Each step is its own commit, keeps `yarn test`, `yarn test:extension`, `yarn test:expand` and `yarn lint` green, and changes no behavior. A rough size is given where there's a basis for one.

1. **Short names in `bridge/lib/`**, module by module (≈530 warnings), then turn the rules into errors for `bridge/`. Done one module per commit, the diffs stay readable.
2. **Split `server.mjs`**: move `indexPage` and `localPage` to `server/pages.mjs`, asset serving to `server/assets.mjs`, then the route groups into `server/routes/*` behind a route table. The bridge API tests in `test/bridge.test.mjs` cover every route.
3. **Split `backstory.mjs`** along its existing headings. `test/backstory.test.mjs` covers the public `findBackstory` and `briefOf`.
4. **Split `stories.mjs`** into store, meta, chapters and local diff, and rename `place.mjs` to `stories/placement.mjs`.
5. **The CLI**: one module per command group under `bridge/cli/`, and the usage text built from a command table so it can't drift.
6. **The skill imports the bridge's helpers**: `parseUnifiedDiff`, `entryOf` and the text-ref rule from the bridge, dropping its copies. Worth confirming first that the skill is only ever run from this repo's checkout (its `DSM` path assumes so today).
7. **Decide the skill's overlay snippet**: retire it, or generate it from `src/js/shared/panel/` at build time. This one is a product call, not a refactor.
8. **`bridge/public/local.js`**: split into the diff view, folds, notes and the panel mount, with the same naming rules.
9. **Tests**: move unit tests under `test/unit/<area>/` and split `load-test.mjs` into the options page, the GitHub panel, the PR list and the local page, sharing one browser setup. Then the naming rules for `test/` and `scripts/`.
10. **Rename the leftovers** (`health.mjs`, `refs.mjs`) once the folders above exist, so each name says what its folder and file hold.

Steps 1 to 5 are independent of each other and could go in any order. Steps 6 and 7 need a decision about the skill first.
