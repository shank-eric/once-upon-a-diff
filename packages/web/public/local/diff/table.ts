/*
 * One file's diff table, drawn from its rows (rows.ts) with the same DOM shapes as GitHub's /changes page (line cells with
 * data-line-anchor), so the story panel runs on it unchanged. Unified or split, with the lines highlighted when highlight.js has
 * loaded. A line number opens the note form under its line: one listener on the table, not one on each of thousands of cells.
 */
import { html } from '/assets/preact.mjs';
import { openEditor, openRun } from '/assets/local/actions.ts';
import { usage } from '/assets/local/page.ts';
import { columnCount, foldText, type FoldRow, type Shown } from './rows.ts';
import { EditorRowView, NoteRowView } from './notes.ts';
import type { Highlights } from './highlights.ts';
import type { SplitHalf } from './split.ts';
import type { DiffHunk, LocalFile } from '/assets/types.ts';
import type { Side } from '/assets/domain/line-refs.ts';

const SIGN = { ctx: ' ', del: '-', add: '+' };

const hunkHeader = (hunk: DiffHunk) =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header || ''}`;

const numberCell = (file: LocalFile, side: Side, number: number, extra = '') =>
  html`<td class="ou-local-num${extra}" data-line-anchor="diff-${file.sha}${side}${number}" data-side=${side} data-line=${number} title="Add a fix-before-push note">${number}</td>`;

/**
 * A line's code cell: the sign, then the code. `highlighted` is the line's HTML from highlight.js (highlights.ts), which escapes the
 * text, and it is the only HTML this component takes: a line with none is drawn from its own text, which Preact escapes.
 */
function codeCell(
  className: string,
  sign: string,
  text: string,
  highlighted: string | null | undefined,
) {
  if (highlighted != null) {
    const content = `<span class="ou-local-sign">${sign}</span>${highlighted}`;
    return html`<td class=${className} dangerouslySetInnerHTML=${{ __html: content }}></td>`;
  }
  return html`<td class=${className}><span class="ou-local-sign">${sign}</span>${text}</td>`;
}

const lineOf = (highlights: Highlights, hunkIndex: number, i: number) =>
  highlights && highlights[hunkIndex] ? highlights[hunkIndex][i] : null;

function FoldRowView(props: {
  row: FoldRow;
  rel: string;
  split: boolean;
  stepName: (step: number) => string;
}) {
  const { row, rel } = props;
  return html`<tr class="ou-local-narrow"><td colspan=${columnCount(props.split)}>${foldText(row, props.stepName)}<button type="button" data-narrow-open onClick=${() => openRun(rel, row.rows)}>Show</button></td></tr>`;
}

function rowView(
  row: Shown,
  file: LocalFile,
  split: boolean,
  highlights: Highlights,
  stepName: (step: number) => string,
  hideWhitespace: boolean,
) {
  const out = row.hidden ? ' ou-local-out' : '';
  switch (row.kind) {
    case 'hunk':
      return split
        ? html`<tr key=${row.key} class="ou-local-hunk${out}"><td class="ou-local-num"></td><td class="ou-local-code" colspan="3">${hunkHeader(row.hunk)}</td></tr>`
        : html`<tr key=${row.key} class="ou-local-hunk${out}"><td class="ou-local-num"></td><td class="ou-local-num"></td><td class="ou-local-code">${hunkHeader(row.hunk)}</td></tr>`;
    case 'message':
      return html`<tr key=${row.key} class="ou-local-info"><td colspan=${columnCount(split)}>${row.text}</td></tr>`;
    case 'info':
      return split
        ? html`<tr key=${row.key} class="ou-local-info${out}"><td class="ou-local-num"></td><td class="ou-local-code" colspan="3">${row.text}</td></tr>`
        : html`<tr key=${row.key} class="ou-local-info${out}"><td class="ou-local-num"></td><td class="ou-local-num"></td><td class="ou-local-code">${row.text}</td></tr>`;
    case 'line': {
      const code = (sign: string) =>
        codeCell('ou-local-code', sign, row.text, lineOf(highlights, row.hunkIndex, row.i));
      if (row.sign === ' ') {
        return html`<tr key=${row.key} class="ou-local-line ou-local-ctx${out}">${numberCell(file, 'L', row.oldNum as number)}${numberCell(file, 'R', row.newNum as number)}${code(' ')}</tr>`;
      }
      if (row.sign === '-') {
        return html`<tr key=${row.key} class="ou-local-line ou-local-del${out}">${numberCell(file, 'L', row.oldNum as number)}<td class="ou-local-num"></td>${code('-')}</tr>`;
      }
      return html`<tr key=${row.key} class="ou-local-line ou-local-add${out}"><td class="ou-local-num"></td>${numberCell(file, 'R', row.newNum as number)}${code('+')}</tr>`;
    }
    case 'pair': {
      const half = (side: Side, cell: SplitHalf | null | undefined, right: boolean) => {
        const rightNumber = right ? ' ou-local-rnum' : '';
        if (!cell) {
          return html`<td class="ou-local-num ou-local-n-empty${rightNumber}"></td><td class="ou-local-code ou-local-c-empty"></td>`;
        }
        return [
          numberCell(file, side, cell.num, ` ou-local-n-${cell.kind}${rightNumber}`),
          codeCell(
            `ou-local-code ou-local-c-${cell.kind}`,
            SIGN[cell.kind],
            cell.text,
            lineOf(highlights, row.hunkIndex, cell.i),
          ),
        ];
      };
      return html`<tr key=${row.key} class="ou-local-line ou-local-pair${out}">${half('L', row.row.left, false)}${half('R', row.row.right, true)}</tr>`;
    }
    case 'note':
      return html`<${NoteRowView} key=${row.key} row=${row} split=${split} hideWhitespace=${hideWhitespace} />`;
    case 'editor':
      return html`<${EditorRowView} key=${row.key} row=${row} split=${split} />`;
    case 'fold':
      return html`<${FoldRowView} key=${row.key} row=${row} rel=${file.rel} split=${split} stepName=${stepName} />`;
  }
}

export function DiffTable(props: {
  file: LocalFile;
  split: boolean;
  rows: Shown[];
  highlights: Highlights;
  stepName: (step: number) => string;
  hideWhitespace: boolean;
}) {
  const { file, split, rows, highlights, stepName, hideWhitespace } = props;
  const click = (event: Event) => {
    const cell = (event.target as Element).closest?.('td.ou-local-num[data-line-anchor]');
    if (cell) {
      usage.count('local.line.open');
      openEditor(
        file.rel,
        cell.getAttribute('data-side') as Side,
        Number(cell.getAttribute('data-line')),
      );
    }
  };
  const columns = split
    ? html`<col class="ou-local-col-num" /><col /><col class="ou-local-col-num" /><col />`
    : html`<col class="ou-local-col-num" /><col class="ou-local-col-num" /><col />`;
  return html`<table class=${split ? 'ou-local-diff ou-local-split' : 'ou-local-diff'} onClick=${click}><colgroup>${columns}</colgroup><tbody>${rows.map((row) => rowView(row, file, split, highlights, stepName, hideWhitespace))}</tbody></table>`;
}
