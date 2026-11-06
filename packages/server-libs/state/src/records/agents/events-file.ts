/*
 * The events in <home>/agents.jsonl, read once and then only as far as the file has grown. The file is append-only and
 * read whole on every board poll and every CLI call, and it only grows, so each process keeps the events it has parsed and
 * parses just the bytes appended since. It starts over when the file is gone, is shorter than what was read, is a different
 * file (its inode changed), or begins differently than it did (a file emptied and refilled past its old length). An edit by
 * hand further in that keeps the size, the inode and the first bytes is not noticed until the file is replaced or shortened.
 * A last line with no newline yet (a half-written append) is parsed for this read and taken again when it is finished.
 */
import { logState, readLogFrom, readLogHead } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { parseAgentEvents, type AgentEvent } from './events.ts';

/** How much of the start of the file says it is still the file that was read. */
const FINGERPRINT_BYTES = 256;

interface Read {
  ino: number;
  /** the bytes parsed: the end of the last line that has its newline */
  consumed: number;
  /** the first bytes of the file (at most FINGERPRINT_BYTES, and no more than were parsed) when it was read */
  head: Buffer;
  events: AgentEvent[];
}
const reads = new Map<string, Read>();

const sameStart = (file: string, known: Read): boolean =>
  readLogHead(file, known.head.length).equals(known.head);

/** The events in the file, oldest first (none when there is no file). A fresh array each call, over events kept from the last. */
export function agentEventsIn(file: string): AgentEvent[] {
  const state = logState(file);
  if (!state) {
    reads.delete(file);
    return [];
  }
  let known = reads.get(file);
  if (!known || known.ino !== state.ino || state.size < known.consumed || !sameStart(file, known)) {
    known = { ino: state.ino, consumed: 0, head: Buffer.alloc(0), events: [] };
    reads.set(file, known);
  }
  if (state.size === known.consumed) {
    return known.events.slice();
  }
  const bytes = readLogFrom(file, known.consumed);
  const end = bytes.lastIndexOf(0x0a) + 1;
  for (const event of parseAgentEvents(bytes.subarray(0, end).toString('utf8'))) {
    known.events.push(event);
  }
  known.consumed += end;
  if (known.head.length < Math.min(FINGERPRINT_BYTES, known.consumed)) {
    known.head = readLogHead(file, Math.min(FINGERPRINT_BYTES, known.consumed));
  }
  const tail = bytes.subarray(end).toString('utf8');
  return tail ? [...known.events, ...parseAgentEvents(tail)] : known.events.slice();
}
