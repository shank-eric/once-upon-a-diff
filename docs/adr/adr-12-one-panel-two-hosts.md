# ADR-12: One panel on GitHub's page and on a page that copies its DOM

Descriptive, of the code on main at 0741c6c (10/29). It was first drafted on 10/27 against the panel's old home in `shared`. Since 11/5: the diff-page reader is the `packages/github-page` package (ADR-17 named it `host-github`; it was renamed on 11/5), the panel's size below is of 10/29, and the shared helpers are `packages/ui-kit` and `packages/domain`.

## Context

The same story should read the same way on a GitHub PR and on local commits before push. The panel is the biggest piece of UI (`packages/panel`, about 5,900 lines on 10/29), and two copies would drift.

## Decision

- **One panel**, the `packages/panel` package: `shell/overlay.ts` composes it from region folders (`ask`, `drafts`, `fixes`, `reading`, `rebuild`) beside `host/`, `state/`, `shell/`, `components/` and `css/`, and it is drawn in a shadow root so the host page's CSS can't reach it. It has no host in it. Each app hands `storyOverlay` a `PanelHost` (`panel/src/host/host.ts`): the host page's diff adapter and the bridge's typed client, and `host/bridge-options.ts` builds the calls both hosts make the same way.
- **On GitHub** the extension's content script docks it on `/changes` (React) and classic `/files`. The diff-page reader, `packages/github-page/src/diff-dom.ts`, finds files, lines and Viewed toggles in both DOMs.
- **On the local page** the bridge draws the diff "with the same DOM shapes as GitHub's `/changes` page" (`packages/web/public/local/diff/table.ts`), so the same `diff-dom.ts` code finds the same things. Both apps inject it into the panel, and the panel never imports it (a lint rule says so). It lives in its own package, `github-page` (in `shared` until 11/3), because the local page can't import the extension. The bridge serves the panel and the shared packages to the page type-stripped, with their package imports rewritten to `/assets/` URLs (`packages/server/src/assets.ts`).
- **The panel only touches GitHub controls on a click:** expanders and Load diff to reach a line, and one file's Viewed toggle through its Mark viewed button. It never touches comment, review or resolve controls.
- **Placement rules are shared with the skill.** `finishedInOf` (in `packages/domain/src/chapters.ts`), text refs and hunk coverage are imported by the skill helper too, so `file-map.json` matches the panel.

## Consequences

- A feature lands on both hosts at once, and the local page tests panel behavior without GitHub.
- **GitHub's DOM is a dependency, copied.** When GitHub changes `/changes`, the panel can break on GitHub, and the local page then keeps the old shape until someone copies the new one. The two can disagree without anyone noticing.
- Some things can't match. The local page folds lines by chapter and has its own Split view and Hide whitespace. On GitHub the filter is by file only, and whitespace rides on `?w=1`.
- Panel state is saved in different places per host: `chrome.storage` per PR on GitHub, and `state/<id>/ui.json` on the local page.
- Browser tests use public PRs while logged out, which redirects `/changes` to `/files`. The logged-in React `/changes` is checked by hand. Refined GitHub compatibility comes from reading its source, not from running it.

## Open questions

1. Should `diff-dom.ts` have a small DOM-shape contract test that both the local page and a saved GitHub fixture must pass, so drift shows up?
2. Should the panel's saved state live in one place (the bridge) for both hosts?
