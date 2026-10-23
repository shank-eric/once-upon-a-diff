/*
 * What the CLI prints: a line to stdout, and inbox entries as `inbox` and
 * `wait` show them.
 */
import { formatTime, readerOf } from '../config/settings.ts';
import { sameRepo } from '../config/repos.ts';
import { updateOf } from '../inbox/builds.ts';
import { plural } from '@once-upon-a-diff/shared/util/text';
import type { InboxEntry } from '../inbox/inbox.ts';
import type { Build, BuildRequestEntry } from '../inbox/builds.ts';
import type { RequestNote } from '../inbox/fixes.ts';
import type { CliOpts } from '../types.ts';

/** A fix request as `wait` hands it over (fixesToHand). */
type FixRequestEntry = ReturnType<typeof import('../inbox/fixes.ts').fixesToHand>[number];
/** What `inbox` and `wait` print: an inbox line, or a request handed over. */
export type Printable = InboxEntry | BuildRequestEntry | FixRequestEntry;

export const out = (text: string): boolean => process.stdout.write(text + '\n');

/** A note's place: path:line, with L before an old-side line. */
const notePlace = (note: Pick<RequestNote, 'path' | 'line' | 'side'>) =>
  `${note.path}${note.line ? `:${note.side === 'L' ? 'L' : ''}${note.line}` : ''}`;

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
  if (entry.type === 'note') {
    return `[${when}] note ${entry.action} (${entry.story}) ${notePlace(entry.note)}${entry.note.done ? ' [done]' : ''}\n${entry.note.body}`;
  }
  return `[${when}] ${entry.type} ${JSON.stringify(entry)}`;
}

/** The entries a --type, --story or --repo flag asks for. */
export function filterEntries<
  E extends { type: string; story?: string | null; repo?: string | null },
>(entries: E[], opts: CliOpts): E[] {
  const types = opts.type ? String(opts.type).split(',') : null;
  return entries.filter(
    (entry) =>
      (!types || types.includes(entry.type)) &&
      (!opts.story || entry.story === opts.story) &&
      (!opts.repo || sameRepo(entry.repo, opts.repo)),
  );
}

export { notePlace };
