# ADR-23: Pixel checks in the browser test, with strict thresholds and baselines in git

Decided 11/5, built in bbe010f, with the textarea rule added in d21183d. Descriptive, of the code on main at 168b6b1. No earlier ADR covered it. It is the CSS side of the browser test that [ADR-12](adr-12-one-panel-two-hosts.md) mentions (which reads public PRs while logged out).

## Context

The panel, the local page, the board and the extension's tags are styled by CSS that several packages share: the theme tokens in `ui-kit` (9e6f4d5) and each package's own sheet. The DOM tests and the panel's DOM goldens check structure, not looks, so a rename of a colour token, or an alias layer that produces a nearly right colour, passed every test. The theme-tokens branch was about to rename colours across all of them.

## Decision

- **`yarn test:extension` ends with pixel checks.** `packages/bridge/test/browser/pixels.ts` compares a screenshot with `packages/bridge/test/browser/pixels/<platform>/<name>.png`, committed to git, using pixelmatch and pngjs (pinned dev dependencies of the shell). There are 7 screens, each shot in light and dark by emulated `prefers-color-scheme`, so 14 baselines: the panel on a PR's `/files` page, the local page (`local-story`, `local-qa` and `local-error`, with its status route aborted so the danger colours show), the board, a toast and a story tag.
- **Strict.** The per-pixel threshold is 0.005 in OKLab distance, with anti-aliased pixels counted, and no differing pixel is allowed. 0.01 and pixelmatch's default 0.1 both pass `#cf222e` against `#d1242f`, the nearly right colour an alias layer produces, and that is what the check is for.
- **Steady shots.** Before each shot the mouse is parked off the page, focus is dropped through shadow roots, the page is scrolled to the top, and fonts and two frames are done. A shot is taken until two in a row match (up to six, 700 ms apart) and fails loudly if none do. Clocks are masked (dates, `Elapsed`, the request line, the board's ages), the local header's temp folder reads `<repo>`, the git env is fixed so shas repeat, and the Claude and dev folders point at empty temp folders with the board's status source set to the registry, so the board shows none of this machine and does not depend on iTerm. Textareas have no resize grip in a shot (d21183d): with it drawn, the Ask button's rounded corners came out of the raster two ways in 4 of 10 runs, and without it the suite passed 10 runs in a row.
- **The panel on GitHub is shot against a pinned palette.** GitHub's own Primer colours (light and dark values) are pinned on the page, so the shot looks as on GitHub, does not move when github.com's CSS does, and is the same before and after a change in the UI's own fallbacks. A fast test (`packages/bridge/test/pixels.test.ts`) checks the palette covers every Primer name the panel, `ui-kit` and the content CSS read.
- **The test reads two fixed public PRs**, `shank-eric/inbox-in-gmail#91` (a story's PR, merged, 4 files) and `#92` (no story), logged out, and never port 4823 or Eric's GitHub (`AGENTS.md`).
- **A miss writes the evidence.** `packages/bridge/test-results/pixel-diff/<name>-actual.png` and `-diff.png`, and the pixel count. `UPDATE_SNAPSHOTS=1` (or `--update-snapshots`) rewrites the baselines and says created, updated (N px) or unchanged, and the diff of the PNGs is reviewed like any other change.
- **Baselines are per platform.** Only `darwin` exists. Another platform prints one SKIP line, and `pixels.test.ts` (in the fast suite, with the strictness cases) fails if the darwin folder is missing a shot.

## Consequences

- A CSS change that moves a pixel fails `yarn test:extension` until its baselines are rewritten and reviewed, which is the point: the theme-tokens change was proved by 14 of 14 shots matching, and a one-shade change to `--ou-local-del-fg` fails `local-story-light` with a diff image.
- The suite is a heavy run (a headless browser, one at a time: `AGENTS.md`), and it is not in `yarn test`, so CI (which runs `yarn test` and builds the extension, but not `test:extension`) does not run it.
- Baselines are images in git (about 700 KB for darwin), and a platform or a font change that moves glyphs would fail every shot.
- A change that should alter the look rewrites the baselines in the same commit, so a reviewer sees the image diff beside the CSS.
- One flake was found and removed (the resize grip). Why the grip touched the button's raster is not pinned down: the evidence is that taking it away took the flake with it.
