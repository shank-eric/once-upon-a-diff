/*
 * The top bar: the range, its size, the diff view, Hide whitespace, the notes toggle and its Send, then Approve, Push and Create
 * pull request (ship/). The list of notes opens under it. Send hands every draft note to a Claude session as one fix request:
 * it is the panel's own Send (panel/src/fixes/fixes.ts), so it sends the same request and shows the same message, and the
 * header only asks the panel to run it. It is off with no note to send, and while the panel is closed.
 */
import { html, useState } from '/assets/preact.mjs';
import { useBusy } from '/assets/ui-kit/components/action-button.ts';
import { plural } from '/assets/domain/text.ts';
import { page, usage } from '/assets/local/page.ts';
import { setPref } from '/assets/local/actions.ts';
import { NotesList, toggleText } from '/assets/local/diff/notes.ts';
import { ApproveButton } from '/assets/local/ship/approve.ts';
import { PushButton } from '/assets/local/ship/push.ts';
import { PrButtons } from '/assets/local/ship/pull-request.ts';
import type { LocalStoryData } from '/assets/local/page.ts';
import type { LocalState } from '/assets/local/store.ts';
import type { LocalStory } from '/assets/types.ts';

/**
 * "repo · base abc1234 → head def5678 · branch". The page is drawn once the bridge has made the diff, so both commits are known. Its
 * texts are single strings, so the line's text nodes are the ones the old page had (the browser test reads the first, which names the repo's folder).
 */
const Range = (props: { local: LocalStory }) => {
  const { local } = props;
  const base = ` ${local.base_oid!.slice(0, 9)} → `;
  const head = ` ${local.head_oid!.slice(0, 9)}${local.branch ? ` · ${local.branch}` : ''}`;
  return html`${`${local.repo} · `}<code>${local.base}</code>${base}<code>${local.head}</code>${head}`;
};

/** "3 commits · 4 files +10 −2" */
const Size = (props: { local: LocalStory }) => {
  const { local } = props;
  const added = local.files.reduce((sum, file) => sum + file.stats.added, 0);
  const removed = local.files.reduce((sum, file) => sum + file.stats.removed, 0);
  return html`${plural(local.commits.length, 'commit')} · ${plural(local.files.length, 'file')} <span class="ou-local-plus">+${added}</span> <span class="ou-local-minus">−${removed}</span>`;
};

/**
 * Shown on a story pinned to a branch (not HEAD) whose branch has moved since it was told: the diff below is still the
 * commits it was told over, and this gives the old and new commit so a restack is not mistaken for the same work.
 */
function Moved(props: { local: LocalStory }) {
  const { local } = props;
  const { moved } = local;
  if (!moved) {
    return null;
  }
  const parts = [
    moved.head_oid &&
      html`<code>${local.head}</code> ${local.head_oid!.slice(0, 9)} → ${moved.head_oid.slice(0, 9)}`,
    moved.base_oid &&
      html`<code>${local.base}</code> ${local.base_oid!.slice(0, 9)} → ${moved.base_oid.slice(0, 9)}`,
  ].filter(Boolean);
  const told = parts.map((part, i) => html`${i > 0 && ', '}${part}`);
  // a storyless review is followed by Review again, which re-pins it to the branch's tip
  const follow = local.storyless
    ? html`Click Review on its card on the board to see the new commits.`
    : html`Tell the story again (<code>once-upon local</code>) to follow it.`;
  return html`<div class="ou-local-moved" role="status">
    <strong>Branch moved since this story was told.</strong> This is still the diff of ${told}.
    ${follow}
  </div>`;
}

const WS_TITLE =
  "Draw the diff with git diff -w, like GitHub's Hide whitespace. Remembered for every local story.";

/** Hide whitespace: off while the change is being saved, and back on when it has been (or failed). */
function WhitespaceToggle(props: { hide: boolean }) {
  const { busy, run } = useBusy();
  const change = (event: Event) => {
    const box = event.currentTarget as HTMLInputElement;
    return run('save', () => setPref({ hideWhitespace: box.checked }, 'Hide whitespace'));
  };
  return html`<label class="ou-local-ws" title=${WS_TITLE}><input type="checkbox" class="ou-local-ws-toggle" checked=${props.hide} disabled=${busy !== null} onChange=${change} /> Hide whitespace</label>`;
}

/** A draft note: not sent to a session yet, and not fixed. */
const draftCount = (story: LocalStoryData) =>
  story.local.notes.filter((note) => !note.sent && !note.fixed).length;

/** The header's Send button: "Send 2 notes", off when there are none, or when the panel that sends them is closed. */
function SendButton(props: { story: LocalStoryData; panelOpen: boolean }) {
  const drafts = draftCount(props.story);
  let off = '';
  if (!drafts) {
    off = 'No notes to send: add one by clicking a line number in the diff';
  } else if (!props.panelOpen) {
    off = 'Show the story to send: the panel sends the notes';
  }
  const title =
    off || 'Hands every draft note to a Claude session as one request. Same as Send in the panel.';
  return html`<button type="button" class="ou-local-send" disabled=${!!off} title=${title} onClick=${() => page.overlay?.sendFixes()}>${drafts ? `Send ${plural(drafts, 'note')}` : 'Send'}</button>`;
}

export function Top(props: { state: LocalState }) {
  const { state } = props;
  const story = state.story as LocalStoryData;
  const { local } = story;
  const [notesOpen, setNotesOpen] = useState(false);
  const split = local.diff_view === 'split';
  const view = (want: 'unified' | 'split') => () => {
    if (want !== local.diff_view) {
      setPref({ diffView: want }, 'the diff view');
    }
  };
  return html`<header class="ou-local-top">
    <div class="ou-local-top-main">
      <h1>${story.title}</h1>
      <div class="ou-local-muted"><${Range} local=${local} /> · <${Size} local=${local} /></div>
      <${Moved} local=${local} />
    </div>
    <div class="ou-local-view" role="group" aria-label="Diff view"><button type="button" data-diff-view="unified" aria-pressed=${String(!split)} onClick=${view('unified')}>Unified</button><button type="button" data-diff-view="split" aria-pressed=${String(split)} onClick=${view('split')}>Split</button></div>
    <${WhitespaceToggle} hide=${local.hide_whitespace} />
    <button type="button" class="ou-local-notes-toggle" aria-expanded=${String(notesOpen)} onClick=${() => {
      usage.count('local.notes.toggle');
      setNotesOpen(!notesOpen);
    }}>${toggleText(local.notes)}</button>
    <span class="ou-local-send-holder"><${SendButton} story=${story} panelOpen=${state.panelOpen} /></span>
    <span class="ou-local-approve-holder"><${ApproveButton} story=${story} ship=${state.ship} /></span>
    <span class="ou-local-push-holder"><${PushButton} story=${story} ship=${state.ship} /></span>
    <span class="ou-local-pr-holder"><${PrButtons} story=${story} ship=${state.ship} /></span>
  </header>
  <${NotesList} notes=${local.notes} storyId=${story.id} open=${notesOpen} />`;
}
