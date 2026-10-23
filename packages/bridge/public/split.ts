/*
 * Split view for the local page: a hunk's lines as side-by-side rows, old on
 * the left and new on the right, the way GitHub's split diff pairs them. A
 * run of removed lines followed by a run of added lines is paired line by
 * line, and the longer run's extra lines get an empty cell on the other side.
 *
 * No DOM here, so node can test it.
 */

/** One side of a split row: its line number, text and kind, and i, its index in hunk.lines (for its highlighted HTML). */
export interface SplitHalf {
  num: number;
  text: string;
  kind: 'ctx' | 'del' | 'add';
  i: number;
}

/** A pair of halves (either may be null), or an info line. */
export interface SplitRow {
  left?: SplitHalf | null;
  right?: SplitHalf | null;
  info?: string;
}

export function splitRows(hunk: {
  oldStart: number;
  newStart: number;
  lines: string[];
}): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let dels: SplitHalf[] = [];
  let adds: SplitHalf[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] || null, right: adds[i] || null });
    }
    dels = [];
    adds = [];
  };
  hunk.lines.forEach((line, i) => {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '-') {
      if (adds.length) {
        flush();
      } // a removal after additions starts a new pairing
      dels.push({ num: oldLine++, text, kind: 'del', i });
    } else if (sign === '+') {
      adds.push({ num: newLine++, text, kind: 'add', i });
    } else if (sign === ' ') {
      flush();
      rows.push({
        left: { num: oldLine++, text, kind: 'ctx', i },
        right: { num: newLine++, text, kind: 'ctx', i },
      });
    } else {
      flush();
      rows.push({ info: line });
    }
  });
  flush();
  return rows;
}
