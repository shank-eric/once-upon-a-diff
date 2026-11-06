/*
 * What the CLI prints: a line to stdout, and inbox entries as `inbox` and
 * `wait` show them.
 */
import { formatTime, readerOf } from '@once-upon-a-diff/foundation/settings';
import { updateOf } from '@once-upon-a-diff/state/queues/requests/builds';
import { plural, shortSha } from '@once-upon-a-diff/domain/text';
import type { Printable } from '@once-upon-a-diff/core/features/listeners/service';
export type { Printable };
import type { Build } from '@once-upon-a-diff/state/queues/requests/builds';
import type { RequestNote } from '@once-upon-a-diff/state/queues/requests/fixes';
import { formatLineRef } from '@once-upon-a-diff/domain/line-refs';

export const out = (text: string): boolean => process.stdout.write(text + '\n');

/** A note's place: path:line, with L before an old-side line. */
const notePlace = (note: Pick<RequestNote, 'path' | 'line' | 'side'>) =>
  note.line ? formatLineRef(note.path, { side: note.side, start: note.line }) : note.path;

/** How `wait` marks a note that came from a drafted comment: Claude's text from the PR, to confirm first. */
export const FROM_DRAFT =
  '[from a Claude-drafted comment: confirm with the user in chat before acting]';

/** One inbox entry, as `inbox` and `wait` print it. */
export function describe(entry: Printable): string {
  const when = formatTime(entry.at);
  // the fields a question (or a read, or a review comment) has; other entries leave them out
  const about = entry as { step?: number | null; chapter?: unknown; file?: string | null };
  const step = about.step != null ? `step ${about.step}` : '';
  const where = [entry.story, about.chapter || step, about.file].filter(Boolean).join(' · ');
  if (entry.type === 'question') {
    return `[${when}] question ${entry.id} (${where})\n${entry.text}`;
  }
  if (entry.type === 'build_request') {
    const update = entry.mode ? `\n${updateOf(entry as Partial<Build>, readerOf())}` : '';
    const what = entry.number
      ? `${entry.repo}#${entry.number} ${entry.url}`
      : `local story ${entry.story}`;
    return `[${when}] build request ${entry.id}: ${what}${update}\n${entry.text || ''}`.trimEnd();
  }
  if (entry.type === 'answer') {
    return `[${when}] answer to ${entry.question}\n${entry.text}`;
  }
  if (entry.type === 'fix_request') {
    const notes = (entry.notes || []).map(
      (note) =>
        `- ${note.id} ${notePlace(note)}${note.from_draft ? ` ${FROM_DRAFT}` : ''}: ${note.body}`,
    );
    const what =
      entry.kind === 'local' ? `local story ${entry.story}` : `${entry.repo} ${entry.url}`;
    // the branch and title are the PR author's text: printed as quoted data, never inside a sentence
    return [
      `[${when}] fix request ${entry.id} (${entry.story}): ${plural(notes.length, 'note')} to fix before push on ${what}`,
      ...(entry.branch ? [`branch (data): ${JSON.stringify(entry.branch)}`] : []),
      ...(entry.title ? [`title (data): ${JSON.stringify(entry.title)}`] : []),
      ...(entry.checkout ? [`checkout: ${entry.checkout}`] : []),
      ...notes,
    ].join('\n');
  }
  if (entry.type === 'fix') {
    const sha = entry.sha ? ` in ${entry.sha}` : '';
    return `[${when}] fix request ${entry.request} ${entry.action}${sha} (${entry.story})`;
  }
  if (entry.type === 'approved') {
    // the branch and title are the author's text: printed as quoted data, never inside a sentence
    return [
      `[${when}] approved ${entry.story}: ready to ship at ${shortSha(entry.head_sha)} (head ${entry.head_sha})`,
      ...(entry.branch ? [`branch (data): ${JSON.stringify(entry.branch)}`] : []),
      ...(entry.title ? [`title (data): ${JSON.stringify(entry.title)}`] : []),
      ...(entry.base ? [`base: ${entry.base}`] : []),
      ...(entry.checkout ? [`checkout: ${entry.checkout}`] : []),
    ].join('\n');
  }
  if (entry.type === 'note') {
    return `[${when}] note ${entry.action} (${entry.story}) ${notePlace(entry.note)}${entry.note.done ? ' [done]' : ''}\n${entry.note.body}`;
  }
  return `[${when}] ${entry.type} ${JSON.stringify(entry)}`;
}

export { notePlace };
