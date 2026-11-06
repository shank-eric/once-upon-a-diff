/*
 * The files: one section each, with the same DOM shapes as GitHub's /changes page (a region with id diff-<sha256(path)>, a Viewed
 * toggle with aria-pressed), so the story panel runs on it unchanged. A file's table is kept while nothing it draws changed, so
 * a fold, a note on another file or a dialog doesn't draw the others again. The panel marks these nodes itself (hidden,
 * data-ou-hidden, data-ou-hid, data-ou-flash); a file is keyed by its path and Preact never sets those, so its marks stay.
 */
import { html, useMemo, useRef } from '/assets/preact.mjs';
import { Chip } from '/assets/ui-kit/components/chip.ts';
import { Disclosure } from '/assets/ui-kit/components/disclosure.ts';
import { isFolded, toggleFold, toggleViewed } from '/assets/local/actions.ts';
import { usage } from '/assets/local/page.ts';
import { rowsFor, type RowsInput } from './rows.ts';
import { DiffTable } from './table.ts';
import type { Highlights } from './highlights.ts';
import type { EditorState, LocalState } from '/assets/local/store.ts';
import type { LocalFile, LocalNote } from '/assets/types.ts';
import type { Claims } from './narrow.ts';

/** `next`, or the array it was before when it holds the same items: a prop a memo can compare. */
function useStable<T>(next: readonly T[]): readonly T[] {
  const kept = useRef(next);
  if (kept.current.length !== next.length || next.some((item, i) => item !== kept.current[i])) {
    kept.current = next;
  }
  return kept.current;
}

function kindOf(file: LocalFile) {
  if (file.kind === 'renamed' && file.renamed_from) {
    return `renamed from ${file.renamed_from}`;
  }
  return file.kind === 'modified' ? '' : file.kind;
}

interface FileProps {
  file: LocalFile;
  folded: boolean;
  split: boolean;
  hideWhitespace: boolean;
  highlights: Highlights;
  notes: readonly LocalNote[];
  editors: readonly EditorState[];
  claims: Claims;
  step: RowsInput['step'];
  opened: RowsInput['opened'];
  stepName: (step: number) => string;
}

/** What the table draws of a file: the same object while only its Viewed marks change (a mark makes a new file), so its rows and table stay. */
function useDrawn(file: LocalFile): LocalFile {
  const kept = useRef(file);
  const same = (one: LocalFile, other: LocalFile) =>
    one.hunks === other.hunks &&
    one.rel === other.rel &&
    one.sha === other.sha &&
    one.kind === other.kind &&
    one.binary === other.binary &&
    one.whitespace_only === other.whitespace_only &&
    one.renamed_from === other.renamed_from;
  if (!same(kept.current, file)) {
    kept.current = file;
  }
  return kept.current;
}

function FileDiff(props: FileProps) {
  const { file, folded, split, hideWhitespace, highlights, claims, step, opened, stepName } = props;
  const drawn = useDrawn(file);
  const notes = useStable(props.notes);
  const editors = useStable(props.editors);
  const rows = useMemo(
    () => rowsFor({ file: drawn, split, notes, editors, claims, step, opened }),
    [drawn, split, notes, editors, claims, step, opened],
  );
  const table = useMemo(
    () =>
      html`<${DiffTable} file=${drawn} split=${split} rows=${rows} highlights=${highlights} stepName=${stepName} hideWhitespace=${hideWhitespace} />`,
    [drawn, split, rows, highlights, stepName, hideWhitespace],
  );
  const kind = kindOf(file);
  return html`<div class="ou-local-file-wrap"><section role="region" class=${folded ? 'ou-local-file ou-local-folded' : 'ou-local-file'} id=${`diff-${file.sha}`} data-path=${file.rel} aria-label=${file.rel}>
    <header class="ou-local-file-head">
      <${Disclosure} bare open=${!folded} class="ou-local-fold" label="Fold or unfold this file" onToggle=${() => {
        usage.count('local.fold.toggle');
        toggleFold(file.rel);
      }} />
      <code class="ou-local-path">${file.rel}</code>
      ${kind ? html`<${Chip} class="ou-local-kind">${kind}</${Chip}>` : null}
      ${file.whitespace_only ? html`<${Chip} class="ou-local-kind" title="Hide whitespace is on">whitespace only</${Chip}>` : null}
      <span class="ou-local-stat"><span class="ou-local-plus">+${file.stats.added}</span> <span class="ou-local-minus">−${file.stats.removed}</span></span>
      ${file.viewed_changed ? html`<span class="ou-local-changed" title="You marked this viewed, and its diff has changed since">changed since viewed</span>` : null}
      <button class="ou-local-viewed" type="button" aria-pressed=${file.viewed ? 'true' : 'false'} onClick=${() => toggleViewed(file.rel)}>Viewed</button>
    </header>
    <div class="ou-local-file-body">${table}</div>
  </section></div>`;
}

export function Files(props: {
  state: LocalState;
  highlights: Map<string, Highlights>;
  claims: Claims;
  stepName: (step: number) => string;
}) {
  const { state, highlights, claims, stepName } = props;
  const { local } = state.story!;
  const split = local.diff_view === 'split';
  return html`<main class="ou-local-files">${local.files.map(
    (file) =>
      html`<${FileDiff} key=${file.rel} file=${file} folded=${isFolded(state, file)} split=${split} hideWhitespace=${local.hide_whitespace} highlights=${highlights.get(file.rel) ?? null} notes=${local.notes.filter((note) => note.path === file.rel)} editors=${state.editors.filter((editor) => editor.rel === file.rel)} claims=${claims} step=${state.step} opened=${state.opened[file.rel]} stepName=${stepName} />`,
  )}</main>`;
}
