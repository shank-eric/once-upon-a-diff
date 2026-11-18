/*
 * What `once-upon doctor --fix` keeps of inbox.jsonl: the chapter reads and positions older versions logged (and the
 * build_request and build_done lines before them), once they are older than the cutoff, go. Questions, answers, notes, fixes,
 * approvals and comments are the conversation and stay. A consumer's cursor is a byte offset into this file, so the plan also
 * says where an old offset lands in the new file. Pure: doctor reads, writes and moves the cursors (adapters' `replaceLog`).
 */

const DROPPED = new Set(['read', 'position', 'build_request', 'build_done']);

/** Whether the line is one of the dropped types and older than the cutoff (ms). A line with no readable time stays. */
function expired(line: string, cutoff: number): boolean {
  try {
    const value = JSON.parse(line) as { type?: unknown; at?: unknown };
    return (
      typeof value.type === 'string' &&
      DROPPED.has(value.type) &&
      typeof value.at === 'string' &&
      Date.parse(value.at) < cutoff
    );
  } catch {
    return false;
  }
}

/**
 * The whole lines of the file's text with the expired ones left out, and `remap`: a byte offset in the old text (a cursor,
 * always at the start of a line) to the same place in the new one. An offset past the text, where lines were appended while it
 * was being rewritten, keeps its distance from the end.
 */
export function compactInboxText(
  whole: string,
  cutoff: number,
): { text: string; removed: number; remap: (offset: number) => number } {
  const lines = whole.split('\n');
  lines.pop(); // the text ends with a newline: whole lines only
  const kept: string[] = [];
  // for each old line start, the new offset there
  const starts: { old: number; fresh: number }[] = [];
  let old = 0;
  let fresh = 0;
  let removed = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    starts.push({ old, fresh });
    if (expired(line, cutoff)) {
      removed++;
    } else {
      kept.push(line + '\n');
      fresh += size;
    }
    old += size;
  }
  const remap = (offset: number): number => {
    if (offset >= old) {
      return fresh + (offset - old);
    }
    let found = starts.length ? starts[0] : { old: 0, fresh: 0 };
    for (const start of starts) {
      if (start.old > offset) {
        break;
      }
      found = start;
    }
    return found.fresh;
  };
  return { text: kept.join(''), removed, remap };
}
