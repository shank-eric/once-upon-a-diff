/*
 * Split view for the local page: a hunk's lines as side-by-side rows, old on
 * the left and new on the right, the way GitHub's split diff pairs them. A
 * run of removed lines followed by a run of added lines is paired line by
 * line, and the longer run's extra lines get an empty cell on the other side.
 *
 * No DOM here, so node can test it.
 */

/**
 * @param {{oldStart: number, newStart: number, lines: string[]}} hunk
 * @returns {Array<{left: {num: number, text: string, kind: 'ctx'|'del'}|null, right: {num: number, text: string, kind: 'ctx'|'add'}|null}
 *   | {info: string}>}
 */
export function splitRows(hunk) {
  const rows = [];
  let o = hunk.oldStart;
  let n = hunk.newStart;
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] || null, right: adds[i] || null });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '-') {
      if (adds.length) flush(); // a removal after additions starts a new pairing
      dels.push({ num: o++, text, kind: 'del' });
    } else if (sign === '+') {
      adds.push({ num: n++, text, kind: 'add' });
    } else if (sign === ' ') {
      flush();
      rows.push({ left: { num: o++, text, kind: 'ctx' }, right: { num: n++, text, kind: 'ctx' } });
    } else {
      flush();
      rows.push({ info: line });
    }
  }
  flush();
  return rows;
}
