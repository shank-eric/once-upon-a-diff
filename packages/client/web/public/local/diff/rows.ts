/*
 * The rows of one file's diff table, as data. The table draws from this list (table.ts) and the page's actions read it (an
 * editor opens on the row of a line number, a jump from the panel opens the fold that holds a line), so nothing reads rows
 * back off the DOM. The order is the table's: the file's hunks, with an open note form and then the notes under their line
 * (the notes of one line come out the last first, as they were put in the table one after the other, each straight under the
 * line), the notes whose line this diff doesn't draw under the first row, and a "⋯ N lines" row before each run of lines a
 * chapter doesn't tell (narrow.ts). No DOM here, so node can test it.
 */
import { splitRows, type SplitRow } from './split.ts';
import { claimsOf, narrowRows, type Claims, type NarrowRow } from './narrow.ts';
import { plural } from '/assets/terms/text.ts';
import type { DiffHunk, LocalFile, LocalNote } from '/assets/types.ts';
import type { Side } from '/assets/terms/line-refs.ts';
import type { EditorState } from '/assets/local/store.ts';

type Sign = ' ' | '-' | '+';

/** A row of the diff, before notes and folds. */
export type BaseRow =
  | { kind: 'hunk'; key: string; hunk: DiffHunk }
  /** a unified line: its numbers are null on the side it isn't on. `hunkIndex` and `i` say where its highlighted HTML is. */
  | {
      kind: 'line';
      key: string;
      hunkIndex: number;
      i: number;
      sign: Sign;
      oldNum: number | null;
      newNum: number | null;
      text: string;
    }
  | { kind: 'pair'; key: string; hunkIndex: number; row: SplitRow }
  | { kind: 'info'; key: string; text: string; hunkIndex?: number }
  | { kind: 'message'; key: string; text: string };

export type Row = BaseRow | NoteRow | EditorRow | FoldRow;
export interface NoteRow {
  kind: 'note';
  key: string;
  note: LocalNote;
  /** the note's line isn't in this diff */
  away: boolean;
}
export interface EditorRow {
  kind: 'editor';
  key: string;
  editor: EditorState;
}
export interface FoldRow {
  kind: 'fold';
  key: string;
  /** the fold's own key: its first row's */
  run: string;
  /** the keys of the rows it hides, what `opened` holds once it is opened */
  rows: string[];
  lines: number;
  steps: number[];
}
export type Shown = Row & { hidden: boolean; run?: string };

/** How many columns a row spans. */
export const columnCount = (split: boolean) => (split ? 4 : 3);

/** A file's rows before notes and folds, and where its line numbers are: `L12` and `R14` to the row that draws that number. */
export interface Base {
  rows: BaseRow[];
  anchors: Map<string, number>;
}

/** Kept for a file's hunks, which are the same array while only its Viewed marks change (a mark makes a new file). */
const bases = new WeakMap<object, { split: boolean; shape: string; base: Base }>();

/** The rows of a file's diff, and where its line numbers are. Kept for the hunks and split flag it was made for. */
export function baseRows(file: LocalFile, split: boolean): Base {
  const known = bases.get(file.hunks);
  const shape = `${file.binary}|${file.whitespace_only}|${file.kind}`;
  if (known && known.split === split && known.shape === shape) {
    return known.base;
  }
  const rows: BaseRow[] = [];
  const anchors = new Map<string, number>();
  const anchor = (side: Side, num: number | null | undefined) => {
    if (num != null && !anchors.has(`${side}${num}`)) {
      anchors.set(`${side}${num}`, rows.length);
    }
  };
  if (file.binary) {
    rows.push({ kind: 'message', key: 'm', text: 'Binary file' });
  } else if (file.whitespace_only) {
    rows.push({
      kind: 'message',
      key: 'm',
      text: 'Only whitespace changes, hidden. Turn off Hide whitespace to see them.',
    });
  } else if (!file.hunks.length) {
    rows.push({
      kind: 'message',
      key: 'm',
      text: file.kind === 'renamed' ? 'Renamed without changes' : 'No changed lines',
    });
  } else {
    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ kind: 'hunk', key: `h${hunkIndex}`, hunk });
      if (split) {
        splitRows(hunk).forEach((row, pairIndex) => {
          if (row.info) {
            rows.push({
              kind: 'info',
              key: `p${hunkIndex}:${pairIndex}`,
              text: row.info,
              hunkIndex,
            });
            return;
          }
          anchor('L', row.left?.num);
          anchor('R', row.right?.num);
          rows.push({ kind: 'pair', key: `p${hunkIndex}:${pairIndex}`, hunkIndex, row });
        });
        return;
      }
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      hunk.lines.forEach((line, i) => {
        const sign = line[0];
        const key = `l${hunkIndex}:${i}`;
        if (sign === ' ') {
          anchor('L', oldLine);
          anchor('R', newLine);
          rows.push({
            kind: 'line',
            key,
            hunkIndex,
            i,
            sign,
            oldNum: oldLine++,
            newNum: newLine++,
            text: line.slice(1),
          });
        } else if (sign === '-') {
          anchor('L', oldLine);
          rows.push({
            kind: 'line',
            key,
            hunkIndex,
            i,
            sign,
            oldNum: oldLine++,
            newNum: null,
            text: line.slice(1),
          });
        } else if (sign === '+') {
          anchor('R', newLine);
          rows.push({
            kind: 'line',
            key,
            hunkIndex,
            i,
            sign,
            oldNum: null,
            newNum: newLine++,
            text: line.slice(1),
          });
        } else {
          rows.push({ kind: 'info', key, text: line.slice(1), hunkIndex });
        }
      });
    });
  }
  const base = { rows, anchors };
  bases.set(file.hunks, { split, shape, base });
  return base;
}

/** The key of the row that draws a line number (an editor opens on it), or null when this diff doesn't draw it. */
export function rowKeyFor(
  file: LocalFile,
  split: boolean,
  side: Side,
  line: number,
): string | null {
  const { rows, anchors } = baseRows(file, split);
  const pos = anchors.get(`${side}${line}`);
  return pos === undefined ? null : rows[pos].key;
}

/** One row as narrowRows reads it. */
function modelOf(row: Row): NarrowRow {
  switch (row.kind) {
    case 'hunk':
      return { type: 'hunk' };
    case 'note':
    case 'editor':
      return { type: 'note' };
    case 'line':
      return { type: 'line', L: row.oldNum, R: row.newNum, add: row.sign === '+' };
    case 'pair':
      return {
        type: 'line',
        L: row.row.left ? row.row.left.num : null,
        R: row.row.right ? row.row.right.num : null,
        add: row.row.right?.kind === 'add',
      };
    default:
      return { type: 'info' };
  }
}

export interface RowsInput {
  file: LocalFile;
  split: boolean;
  /** this file's notes */
  notes: readonly LocalNote[];
  /** this file's open note forms */
  editors: readonly EditorState[];
  claims: Claims;
  step: { n: number; all: boolean } | null;
  /** the keys of the rows of this file's folds the reviewer opened */
  opened: Readonly<Record<string, true>> | undefined;
  /** "chapter 2": how a step is named in a fold's text, drawn by the table */
  stepName?: (step: number) => string;
}

const chaptersOf = new WeakMap<object, Claims>();
/** claimsOf for a story's chapters, kept for the chapters it was made from. */
export function claimsFor(chapters: Parameters<typeof claimsOf>[0]): Claims {
  if (!chapters) {
    return claimsOf(chapters);
  }
  let claims = chaptersOf.get(chapters);
  if (!claims) {
    claims = claimsOf(chapters);
    chaptersOf.set(chapters, claims);
  }
  return claims;
}

/** Every row of a file's table, in order, each with whether the step's narrowing hides it. */
export function rowsFor(input: RowsInput): Shown[] {
  const { file, split, notes, editors, claims, step, opened } = input;
  const { rows: base, anchors } = baseRows(file, split);
  // what goes under each base row: its open form first, then its notes, last first
  const under = new Map<number, Row[]>();
  const put = (pos: number, row: Row) => {
    const list = under.get(pos);
    if (list) {
      list.push(row);
    } else {
      under.set(pos, [row]);
    }
  };
  for (const editor of editors) {
    const pos = base.findIndex((row) => row.key === editor.row);
    if (pos >= 0) {
      put(pos, { kind: 'editor', key: `e:${editor.key}`, editor });
    }
  }
  const noteRows: [number, NoteRow][] = [];
  for (const note of notes) {
    const cell = note.line ? anchors.get(`${note.side}${note.line}`) : undefined;
    noteRows.push([
      cell ?? 0,
      { kind: 'note', key: `n${note.id}`, note, away: !!note.line && cell === undefined },
    ]);
  }
  // each note went in straight under its row, so the last of a row's notes is the first drawn
  for (const [pos, row] of noteRows.reverse()) {
    put(pos, row);
  }
  const rows: Row[] = [];
  base.forEach((row, pos) => {
    rows.push(row, ...(under.get(pos) ?? []));
  });
  const shown: Shown[] = rows.map((row) => ({ ...row, hidden: false }));
  if (!step || step.all || !step.n) {
    return shown;
  }
  const { hidden, runs } = narrowRows(rows.map(modelOf), claims, file.rel, step.n);
  hidden.forEach((out, i) => {
    shown[i].hidden = out;
  });
  const result: Shown[] = [];
  let pos = 0;
  for (const run of runs) {
    for (; pos < run.from; pos++) {
      result.push(shown[pos]);
    }
    const runKey = rows[run.from].key;
    // an opened fold holds each of its rows' keys, so a note or form that splits it leaves both halves open, and a fold
    // that has any of them open is open (taking a note away can join an opened fold to a closed one)
    const keys = rows.slice(run.from, run.to + 1).map((row) => row.key);
    const open = !!opened && keys.some((key) => opened[key]);
    let lines = 0;
    for (let i = run.from; i <= run.to; i++) {
      shown[i].run = runKey;
      shown[i].hidden = !open;
      if (rows[i].kind === 'line' || rows[i].kind === 'pair') {
        lines++;
      }
    }
    if (!open) {
      result.push({
        kind: 'fold',
        key: `f:${runKey}`,
        run: runKey,
        rows: keys,
        lines,
        steps: run.steps,
        hidden: false,
      });
    }
  }
  for (; pos < shown.length; pos++) {
    result.push(shown[pos]);
  }
  return result;
}

/** What a fold row says: "⋯ 3 lines told in chapter 2". */
export function foldText(fold: FoldRow, stepName: (step: number) => string): string {
  const who = fold.steps.length
    ? `told in ${fold.steps.map(stepName).join(', ')}`
    : 'from other chapters';
  return `⋯ ${plural(fold.lines, 'line')} ${who}`;
}
