/** The editors strip above the columns. */
import { html } from '/assets/preact.mjs';
import type { BoardEditor } from '/assets/types.ts';
import { plural } from '/assets/protocol/domain/text.ts';
import { SessionLink, type Api } from '/assets/board/shared.ts';
import { agentMark, stateNote } from '/assets/board/columns/agent.ts';
import { since } from '/assets/ui/time.ts';

/**
 * The editors strip, above the columns: a row for each editor (a session running a repo's queue) with its lane, its slots
 * in use (only its running authors hold one) and the authors it controls, each with where it stands.
 */
export function Editors(props: { editors: BoardEditor[]; now: number; api: Api }) {
  const { editors, now, api } = props;
  if (!editors.length) {
    return null;
  }
  return html`<section class="ou-board-editors" aria-label="Editors"><ul>${editors.map(
    (editor) =>
      html`<li key=${editor.session} class="ou-board-editor" data-editor=${editor.name}>
        <strong>${editor.label}</strong> <span class="ou-board-voice-status">Editor</span>
        <span class="ou-local-muted" data-editor-slots>${editor.in_use} of ${editor.slots} slots · ${plural(editor.authors.length, 'author')} · <${SessionLink} bridge=${api.bridge} session=${editor.session} canFocus=${editor.can_focus} name="Open in iTerm" title="Bring the editor's iTerm tab to the front" />${editor.since && ` · since ${since(editor.since, now)}`}</span>
        ${
          editor.authors.length > 0 &&
          html`<ul class="ou-board-editor-authors">${editor.authors.map(
            (author) =>
              html`<li key=${author.key} data-author=${author.name} title=${author.task || ''}><span class="ou-board-mark" aria-hidden="true">${agentMark(author)}</span> ${author.name} <span class="ou-local-muted">${author.beat && author.state === 'running' ? `${author.beat.n}/${author.beat.of} ${author.beat.step}` : stateNote(author)}</span></li>`,
          )}</ul>`
        }
      </li>`,
  )}</ul></section>`;
}
