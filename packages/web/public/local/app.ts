/*
 * The local page: one Preact tree drawn from the store (store.ts) into the shell's app element. A diff of local commits with the
 * same DOM shapes as GitHub's /changes page (local/diff/), so the very same story panel runs on it unchanged (local/mount.ts).
 *
 * Here the page owns the review state that GitHub would own: Viewed toggles and line notes go to the bridge, and notes are "fix
 * before push" items (local/diff/notes.ts). Other chapters' lines in a shared file fold away (local/diff/rows.ts, narrow.ts).
 * Create pull request pushes the branch and opens GitHub's compare page, on the reviewer's click (local/ship/pull-request.ts).
 * This module draws the page, mounts the panel again after the story was read again, and follows the commits (polls.ts).
 */
import { html, render, useEffect, useLayoutEffect, useMemo, useRef } from '/assets/preact.mjs';
import { chapterNumbers } from '/assets/panel/shell/overlay.ts';
import { store, type LocalState } from '/assets/local/store.ts';
import { bridge, page, PARAMS } from '/assets/local/page.ts';
import { reloadIfChanged } from '/assets/local/actions.ts';
import { mount, remount } from '/assets/local/mount.ts';
import { startLocalPolls } from '/assets/local/polls.ts';
import { ROUTES } from '/assets/contracts/routes.ts';
import { highlightsFor } from '/assets/local/diff/highlights.ts';
import { claimsFor } from '/assets/local/diff/rows.ts';
import { Files } from '/assets/local/diff/files.ts';
import { FileTree } from '/assets/local/diff/tree.ts';
import { Top } from '/assets/local/top.ts';
import { DialogHost } from '/assets/local/ship/dialogs.ts';
import { lookForPull } from '/assets/local/ship/pull-request.ts';
import type { LocalStoryData } from '/assets/local/page.ts';

/** How a step is named in a fold's text: "chapter 2", or the title of a chapter with no number. */
function stepNamer(chapters: LocalStoryData['chapters']) {
  const numbers = chapterNumbers(chapters);
  return (step: number) => {
    if (numbers[step - 1] != null) {
      return `chapter ${numbers[step - 1]}`;
    }
    return `“${String(chapters[step - 1].title || 'Since you read it').replace(/:.*$/, '')}”`;
  };
}

/** Follows the story and the commits: the polls (the open panel's own tick looks while it's open), and the PR look when the tab gets focus. */
function Follow() {
  useEffect(() => {
    // a hidden tab says it is still open (services/inbox/auto-stop.ts)
    const stop = startLocalPolls({
      closed: () => store.get().hidden,
      reload: (signal) => reloadIfChanged(undefined, signal),
      seen: (signal) => bridge.ask(ROUTES.storySeen, { params: PARAMS }, { signal }),
    });
    lookForPull(true); // Create pull request turns into Open PR #N once the branch has one
    const onFocus = () => lookForPull();
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return null;
}

function Reopen() {
  return html`<button class="ou-local-reopen" type="button" onClick=${() => {
    store.set({ hidden: false });
    mount({ ...page.lastUi });
  }}>Show story</button>`;
}

function Story(props: { state: LocalState }) {
  const { state } = props;
  const story = state.story as LocalStoryData;
  const { files, hide_whitespace: hideWhitespace } = story.local;
  // the page's budget of lines to highlight starts over each time the story was read again
  const highlights = useMemo(
    () => highlightsFor(files, hideWhitespace, page.hljs),
    [state.generation],
  );
  const claims = claimsFor(story.chapters);
  const stepName = useMemo(() => stepNamer(story.chapters), [story.chapters]);
  const rels = useMemo(() => files.map((file) => file.rel), [files]);
  // after the story was read again: the scroll is where it was, and the panel is mounted again on the new DOM
  const drawn = useRef(state.generation);
  useLayoutEffect(() => {
    if (drawn.current === state.generation) {
      return;
    }
    drawn.current = state.generation;
    if (state.scrollKeep !== null) {
      window.scrollTo({ top: state.scrollKeep });
    }
    remount();
  }, [state.generation]);
  // a note link: its file is unfolded and drawn now, so the note is there to scroll to
  useLayoutEffect(() => {
    if (!state.pendingScroll) {
      return;
    }
    const row = document.querySelector(
      `.ou-local-note-row[data-note="${CSS.escape(state.pendingScroll.note)}"]`,
    );
    if (row) {
      window.scrollTo({
        top: row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3,
      });
    }
    store.set({ pendingScroll: null });
  }, [state.pendingScroll]);
  return html`<${Top} state=${state} />
    <div class="ou-local-layout"><${FileTree} rels=${rels} />
    <${Files} state=${state} highlights=${highlights} claims=${claims} stepName=${stepName} /></div>
    ${state.hidden ? html`<${Reopen} />` : null}
    <${DialogHost} story=${story} dialog=${state.ship.dialog} />
    <${Follow} />`;
}

export function LocalApp(props: { state: LocalState }) {
  const { state } = props;
  if (state.loadError !== null) {
    return html`<p class="ou-local-error">Couldn't load the story: ${state.loadError}</p>`;
  }
  if (!state.story) {
    return html`<p class="ou-local-muted ou-local-loading">Loading the story…</p>`;
  }
  return html`<${Story} state=${state} />`;
}

/** Draws the page into `container` from the store now, and each time the store changes. */
export const drawInto = (container: HTMLElement) =>
  store.attach((state) => render(html`<${LocalApp} state=${state} />`, container));
