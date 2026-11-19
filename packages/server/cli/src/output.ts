/*
 * What the CLI prints: a line to stdout, and inbox entries as `inbox` and
 * `wait` show them.
 */
import { formatTime, readerOf } from '@once-upon-a-diff/foundation/settings';
import { updateOf } from '@once-upon-a-diff/state/queues/requests/builds';
import { plural, shortSha } from '@once-upon-a-diff/terms/text';
import type { Printable } from '@once-upon-a-diff/core/features/listeners/service';
export type { Printable };
import type { Build } from '@once-upon-a-diff/state/queues/requests/builds';
import type { RequestNote } from '@once-upon-a-diff/state/queues/requests/fixes';
import { formatLineRef } from '@once-upon-a-diff/terms/line-refs';

export const out = (text: string): boolean => process.stdout.write(text + '\n');

/** A note's place: path:line, with L before an old-side line. */
const notePlace = (note: Pick<RequestNote, 'path' | 'line' | 'side'>) =>
  note.line ? formatLineRef(note.path, { side: note.side, start: note.line }) : note.path;

/** How `wait` marks a note that came from a drafted comment: Claude's text from the PR, to confirm first. */
const FROM_DRAFT = '[from a Claude-drafted comment: confirm with the user in chat before acting]';

/** The entry types `describe` has a block for: the rest print as their JSON. */
type Kind = Printable['type'];
type Entry<T extends Kind> = Extract<Printable, { type: T }>;

/** The branch and title are the PR author's text: printed as quoted data, never inside a sentence. */
const dataLines = (entry: { branch?: string | null; title?: string | null }): string[] => [
  ...(entry.branch ? [`branch (data): ${JSON.stringify(entry.branch)}`] : []),
  ...(entry.title ? [`title (data): ${JSON.stringify(entry.title)}`] : []),
];

/** The story, then its chapter (or step) and file, as far as a question (or a read, or a review comment) has them. */
function placeOf(entry: Printable): string {
  const about = entry as { step?: number | null; chapter?: unknown; file?: string | null };
  const step = about.step == null ? '' : `step ${about.step}`;
  return [entry.story, about.chapter || step, about.file].filter(Boolean).join(' · ');
}

const describeQuestion = (entry: Entry<'question'>, when: string) =>
  `[${when}] question ${entry.id} (${placeOf(entry)})\n${entry.text}`;

function describeBuildRequest(entry: Entry<'build_request'>, when: string): string {
  const update = entry.mode ? `\n${updateOf(entry as Partial<Build>, readerOf())}` : '';
  const what = entry.number
    ? `${entry.repo}#${entry.number} ${entry.url}`
    : `local story ${entry.story}`;
  return `[${when}] build request ${entry.id}: ${what}${update}\n${entry.text || ''}`.trimEnd();
}

const describeAnswer = (entry: Entry<'answer'>, when: string) =>
  `[${when}] answer to ${entry.question}\n${entry.text}`;

function describeFixRequest(entry: Entry<'fix_request'>, when: string): string {
  const notes = (entry.notes || []).map(
    (note) =>
      `- ${note.id} ${notePlace(note)}${note.from_draft ? ` ${FROM_DRAFT}` : ''}: ${note.body}`,
  );
  const what = entry.kind === 'local' ? `local story ${entry.story}` : `${entry.repo} ${entry.url}`;
  return [
    `[${when}] fix request ${entry.id} (${entry.story}): ${plural(notes.length, 'note')} to fix before push on ${what}`,
    ...dataLines(entry),
    ...(entry.checkout ? [`checkout: ${entry.checkout}`] : []),
    ...notes,
  ].join('\n');
}

function describeFix(entry: Entry<'fix'>, when: string): string {
  const sha = entry.sha ? ` in ${entry.sha}` : '';
  return `[${when}] fix request ${entry.request} ${entry.action}${sha} (${entry.story})`;
}

const describeApproved = (entry: Entry<'approved'>, when: string) =>
  [
    `[${when}] approved ${entry.story}: ready to ship at ${shortSha(entry.head_sha)} (head ${entry.head_sha})`,
    ...dataLines(entry),
    ...(entry.base ? [`base: ${entry.base}`] : []),
    ...(entry.checkout ? [`checkout: ${entry.checkout}`] : []),
  ].join('\n');

const describeNote = (entry: Entry<'note'>, when: string) =>
  `[${when}] note ${entry.action} (${entry.story}) ${notePlace(entry.note)}${entry.note.done ? ' [done]' : ''}\n${entry.note.body}`;

/** The entry type to its block: one function per type. */
const DESCRIBERS: { [T in Kind]?: (entry: Entry<T>, when: string) => string } = {
  question: describeQuestion,
  build_request: describeBuildRequest,
  answer: describeAnswer,
  fix_request: describeFixRequest,
  fix: describeFix,
  approved: describeApproved,
  note: describeNote,
};

/** One inbox entry, as `inbox` and `wait` print it. */
export function describe(entry: Printable): string {
  const when = formatTime(entry.at);
  const block = DESCRIBERS[entry.type] as ((entry: Printable, when: string) => string) | undefined;
  return block ? block(entry, when) : `[${when}] ${entry.type} ${JSON.stringify(entry)}`;
}

export { notePlace };
