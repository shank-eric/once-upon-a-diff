/**
 * What a turn's prompt and Claude's last message were, read from the session's Claude Code transcript (a JSONL file,
 * <projects dir>/<folder>/<session id>.jsonl). The capture hook doesn't carry either: it spools only tree ids, and the
 * bridge reads the transcript when it makes the turn (spool.ts).
 *
 * The lines used, from real transcripts:
 *   {"type":"user","origin":{"kind":"human"},"timestamp":"…","message":{"content":"text" | [{"type":"text","text":"…"}, {"type":"tool_result",…}]}}
 *   {"type":"assistant","timestamp":"…","message":{"id":"msg_…","content":[{"type":"text","text":"…"} | {"type":"tool_use"…}]}}
 * An assistant message arrives as one line per content block, all with the same message id. A user line's `origin.kind`
 * says who it came from: "human" for what you typed, "task-notification" for a finished background task (its text is
 * `<task-notification>…`), and older Claude Code versions have no origin at all. A prompt you stopped with Esc leaves a
 * user line whose text is "[Request interrupted by user]".
 *
 * A turn is near the end of its transcript, so the file is read from its tail backward, only as far back as the turn
 * starts, and a 250 MB session costs no more than a short one.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * How long before a prompt record's time the transcript's own line for it may be stamped. The hook stamps its record
 * after its snapshot, which can take a while in a big checkout, and the prompt's line is written before the hook runs.
 */
export const PROMPT_LEAD_MS = 120000;
/**
 * How long after a prompt record's time its transcript line may be stamped: the record's time is cut to the second, and
 * Claude Code writes the user line first and runs the hook about 0.3 s later (measured in real transcripts).
 */
export const PROMPT_SKEW_MS = 1500;
/** How long after a stop record's time the last assistant line may be stamped (the record's time is cut to the second). */
const STOP_SLACK_MS = 2000;
const MAX_PROMPT = 8000;
const MAX_SUMMARY = 20000;
/** How much of the file one backward read takes. */
const CHUNK_BYTES = 1024 * 1024;
/** A line longer than this (a huge tool result) is skipped, not held in memory. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** One line of the transcript that matters: a real prompt, an interrupt marker or a stretch of Claude's text. */
export interface TranscriptEntry {
  kind: 'prompt' | 'interrupt' | 'assistant';
  /** ms since the epoch */
  at: number;
  text: string;
  /** the assistant message the text belongs to */
  message?: string;
}

/** The text of a user line's content: a string, or the text blocks joined (a tool result has none). */
function userText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/**
 * Whether a user line is something you typed, and not Claude Code's own bookkeeping. A line with an `origin` is a prompt
 * only when it came from a human: a finished background task arrives as a user line too (origin "task-notification").
 * Without an origin (older versions, slash commands) the text decides.
 */
function isTyped(origin: unknown, text: string): boolean {
  if (!text) {
    return false;
  }
  const kind =
    origin && typeof origin === 'object' ? (origin as { kind?: unknown }).kind : undefined;
  if (kind !== undefined) {
    return kind === 'human';
  }
  return !HARNESS_LINES.some((start) => text.startsWith(start));
}

/**
 * What user lines with no origin start with when Claude Code wrote them, not you: output of local commands and the
 * `<command-name>` line of one (/mcp, /exit: a skill or prompt command you ran has an origin), `!` shell lines,
 * notices, a compaction's summary.
 */
const HARNESS_LINES = [
  '<local-command',
  '<command-name>',
  '<system-reminder',
  '<task-notification',
  '<bash-input',
  '<bash-stdout',
  '<bash-stderr',
  '<ide_',
  'This session is being continued from a previous conversation',
];

/** The entry a transcript line makes, or null (and the line's time, which says how far back the read has got). */
function parseLine(line: Buffer): { at: number; entry: TranscriptEntry | null } | null {
  const isUser = line.includes('"type":"user"');
  if (!isUser && !line.includes('"type":"assistant"')) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(line.toString('utf8'));
  } catch {
    return null; // a line cut short
  }
  const time = Date.parse(parsed.timestamp);
  if (Number.isNaN(time)) {
    return null;
  }
  if (parsed.isSidechain) {
    return { at: time, entry: null };
  }
  if (parsed.type === 'user' && !parsed.isMeta) {
    const text = userText(parsed.message?.content).trim();
    if (text.startsWith('[Request interrupted')) {
      return { at: time, entry: { kind: 'interrupt', at: time, text } };
    }
    return isTyped(parsed.origin, text)
      ? { at: time, entry: { kind: 'prompt', at: time, text: text.slice(0, MAX_PROMPT) } }
      : { at: time, entry: null };
  }
  if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    const text = parsed.message.content
      .filter(
        (block: { type?: string; text?: unknown }) =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block: { text: string }) => block.text)
      .join('\n')
      .trim();
    return {
      at: time,
      entry: text
        ? {
            kind: 'assistant',
            at: time,
            text: text.slice(0, MAX_SUMMARY),
            message: String(parsed.message.id || ''),
          }
        : null,
    };
  }
  return { at: time, entry: null };
}

/**
 * One session's transcript, read from its end backward as far as a caller needs. The entries come back in file order.
 * Lines added to the file since the last call are picked up too, so one object serves a whole pass of the spool.
 */
export class Transcript {
  /** bytes read from the file so far, which the tests use to show a read stays near the tail */
  bytesRead = 0;
  private entries: TranscriptEntry[] = [];
  private started = false;
  /** the bytes before this offset haven't been read */
  private frontier = 0;
  /** the offset after the last whole line seen, where the next forward read starts */
  private end = 0;
  /** the head of a line that began before the frontier, with no newline yet */
  private carry: Buffer = Buffer.alloc(0);
  /** a line too long to keep: its head, which ends the next chunk earlier, is cut off */
  private cutTail = false;
  /** the time of the earliest line read, which says whether the read has reached far enough back */
  private reached = Infinity;

  private readonly file: string;
  private readonly chunk: number;

  private constructor(file: string, chunk: number) {
    this.file = file;
    this.chunk = chunk;
  }

  /**
   * The session's transcript, or null when the path isn't one: its file name is `<session>.jsonl` (which keeps a forged
   * spool line from making the bridge read some other file) and it is a file.
   */
  static open(file: string, session: string, chunk = CHUNK_BYTES): Transcript | null {
    if (!file || !path.isAbsolute(file) || path.basename(file) !== `${session}.jsonl`) {
      return null;
    }
    try {
      return statSync(file).isFile() ? new Transcript(file, chunk) : null;
    } catch {
      return null;
    }
  }

  /** The entries from `since` (ms since the epoch) to the end of the transcript, and perhaps some older ones. */
  entriesSince(since: number): TranscriptEntry[] {
    const descriptor = openSync(this.file, 'r');
    try {
      const size = fstatSync(descriptor).size;
      if (!this.started || size < this.end) {
        this.begin(descriptor, size);
      } else if (size > this.end) {
        this.readForward(descriptor, size);
      }
      while (this.frontier > 0 && this.reached > since) {
        this.readBackward(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
    return this.entries;
  }

  private slice(descriptor: number, from: number, stop: number): Buffer {
    const buffer = Buffer.alloc(stop - from);
    let got = 0;
    while (got < buffer.length) {
      const count = readSync(descriptor, buffer, got, buffer.length - got, from + got);
      if (count <= 0) {
        break;
      }
      got += count;
    }
    this.bytesRead += got;
    return got === buffer.length ? buffer : buffer.subarray(0, got);
  }

  /** Starts from the end of the file: finds its last whole line (a half-written last line waits). */
  private begin(descriptor: number, size: number): void {
    this.started = true;
    this.entries = [];
    this.carry = Buffer.alloc(0);
    this.cutTail = false;
    this.reached = Infinity;
    let cursor = size;
    this.end = 0;
    while (cursor > 0) {
      const from = Math.max(0, cursor - this.chunk);
      const newline = this.slice(descriptor, from, cursor).lastIndexOf(10);
      if (newline >= 0) {
        this.end = from + newline + 1;
        break;
      }
      cursor = from;
    }
    this.frontier = this.end;
  }

  /** What was appended since the last call, up to its last whole line. */
  private readForward(descriptor: number, size: number): void {
    let from = this.end;
    while (from < size) {
      const limit = Math.min(size, from + MAX_LINE_BYTES);
      const data = this.slice(descriptor, from, limit);
      const newline = data.lastIndexOf(10);
      if (newline < 0) {
        if (limit - from < MAX_LINE_BYTES) {
          return; // a line still being written
        }
        from = limit; // not a line anyone wrote
        this.end = from;
        continue;
      }
      for (const line of this.lines(data.subarray(0, newline))) {
        const made = parseLine(line);
        if (made?.entry) {
          this.entries.push(made.entry);
        }
      }
      from += newline + 1;
      this.end = from;
    }
  }

  private lines(data: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let cursor = 0;
    for (;;) {
      const newline = data.indexOf(10, cursor);
      out.push(data.subarray(cursor, newline < 0 ? data.length : newline));
      if (newline < 0) {
        return out;
      }
      cursor = newline + 1;
    }
  }

  /** Reads the chunk before the frontier and puts its lines in front of the entries. */
  private readBackward(descriptor: number): void {
    const from = Math.max(0, this.frontier - this.chunk);
    let data = this.slice(descriptor, from, this.frontier);
    this.frontier = from;
    if (this.cutTail) {
      // the head of a line already skipped as too long
      const newline = data.lastIndexOf(10);
      if (newline < 0) {
        return;
      }
      data = data.subarray(0, newline + 1);
      this.cutTail = false;
    } else if (this.carry.length) {
      data = Buffer.concat([data, this.carry]);
    }
    this.carry = Buffer.alloc(0);
    let body = data;
    if (from > 0) {
      const newline = data.indexOf(10);
      if (newline < 0) {
        // no line start in this chunk: the line is longer than a chunk
        if (data.length > MAX_LINE_BYTES) {
          this.cutTail = true;
        } else {
          this.carry = data;
        }
        return;
      }
      this.carry = data.subarray(0, newline);
      body = data.subarray(newline + 1);
    }
    const found: TranscriptEntry[] = [];
    let first = true;
    for (const line of this.lines(body)) {
      const made = parseLine(line);
      if (!made) {
        continue;
      }
      if (first) {
        this.reached = Math.min(this.reached, made.at);
        first = false;
      }
      if (made.entry) {
        found.push(made.entry);
      }
    }
    this.entries = found.concat(this.entries);
  }
}

/** What a turn between two spool records said, taken from the transcript's entries. */
export interface TurnText {
  prompt: string | null;
  summary: string | null;
  /** the transcript shows an Esc between the turn's start and its end */
  stopped: boolean;
}

/** How the turn's two records came about. */
export interface TurnShape {
  /** the start record is the turn's own prompt (default). When it's the session's previous Stop, the prompt comes after it. */
  fromPrompt?: boolean;
  /** the turn was stopped with Esc: it ends at the next prompt, so nothing from that prompt's turn is its message */
  interrupted?: boolean;
}

/**
 * The turn's prompt and Claude's last message.
 *
 * The prompt is the latest real prompt at or before the start record's time (PROMPT_SKEW_MS after it, for the record's
 * time being cut to the second; PROMPT_LEAD_MS before it at the most), so an earlier turn's prompt or a finished
 * background task's notification never takes its place. When the start record is the session's previous Stop (no prompt
 * hook), it is the first real prompt after that Stop.
 *
 * Claude's message is the text of the last assistant message after the prompt and up to the turn's end, and never past
 * the next prompt's line: a turn that was stopped ends at the next prompt, whose first words aren't its message.
 */
export function textOfTurn(
  entries: TranscriptEntry[],
  startAt: number,
  endAt: number,
  shape: TurnShape = {},
): TurnText {
  const fromPrompt = shape.fromPrompt !== false;
  const prompts = entries.filter((entry) => entry.kind === 'prompt');
  let prompt: TranscriptEntry | undefined;
  if (fromPrompt) {
    prompt = prompts
      .filter(
        (entry) => entry.at <= startAt + PROMPT_SKEW_MS && entry.at >= startAt - PROMPT_LEAD_MS,
      )
      .pop();
  } else {
    prompt = prompts.find((entry) => entry.at >= startAt - PROMPT_SKEW_MS && entry.at <= endAt);
  }
  const since = prompt ? prompt.at : startAt - PROMPT_SKEW_MS;
  const next = prompts.find((entry) => entry.at > (prompt ? prompt.at : startAt + PROMPT_SKEW_MS));
  // a stopped turn ends at the next prompt's line, which is exact (without that line, its end record's time is all there
  // is), or at the Esc marker before it
  const stoppedLimit = next ? Infinity : endAt;
  const limit = shape.interrupted ? stoppedLimit : endAt + STOP_SLACK_MS;
  const esc = shape.interrupted
    ? entries.find(
        (entry) => entry.kind === 'interrupt' && entry.at >= since && (!next || entry.at < next.at),
      )
    : undefined;
  const within = (entry: TranscriptEntry) =>
    entry.at >= since &&
    entry.at <= limit &&
    (!next || entry.at < next.at) &&
    (!esc || entry.at <= esc.at);
  const spoken = entries.filter((entry) => entry.kind === 'assistant' && within(entry));
  const lastMessage = spoken.length ? spoken[spoken.length - 1].message : undefined;
  const summary = spoken
    .filter((entry) => entry.message === lastMessage)
    .map((entry) => entry.text)
    .join('\n\n');
  return {
    prompt: prompt ? prompt.text : null,
    summary: summary ? summary.slice(0, MAX_SUMMARY) : null,
    stopped: entries.some((entry) => entry.kind === 'interrupt' && within(entry)),
  };
}
