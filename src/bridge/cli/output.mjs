/*
 * What the CLI prints: a line to stdout, and inbox entries as `inbox` and
 * `wait` show them.
 */
import { formatTime, readerOf } from '../config/settings.mjs';
import { sameRepo } from '../config/repos.mjs';
import { updateOf } from '../inbox/builds.mjs';

export const out = (text) => process.stdout.write(text + '\n');

/** A note's place: path:line, with L before an old-side line. */
const notePlace = (note) =>
  `${note.path}${note.line ? `:${note.side === 'L' ? 'L' : ''}${note.line}` : ''}`;

/** One inbox entry, as `inbox` and `wait` print it. */
export function describe(entry) {
  const when = formatTime(entry.at);
  const step = entry.step != null ? `step ${entry.step}` : '';
  const where = [entry.story, entry.chapter || step, entry.file].filter(Boolean).join(' · ');
  if (entry.type === 'question') {
    return `[${when}] question ${entry.id} (${where})\n${entry.text}`;
  }
  if (entry.type === 'build_request') {
    const update = entry.mode ? `\n${updateOf(entry, readerOf())}` : '';
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
      (note) => `- ${note.id} ${notePlace(note)}: ${note.body}`,
    );
    const what =
      entry.kind === 'local' ? `local story ${entry.story}` : `${entry.repo} ${entry.url}`;
    return [
      `[${when}] fix request ${entry.id} (${entry.story}): ${notes.length} note${notes.length === 1 ? '' : 's'} to fix before push on ${what}`,
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
export function filterEntries(entries, opts) {
  const types = opts.type ? String(opts.type).split(',') : null;
  return entries.filter(
    (entry) =>
      (!types || types.includes(entry.type)) &&
      (!opts.story || entry.story === opts.story) &&
      (!opts.repo || sameRepo(entry.repo, opts.repo)),
  );
}

export { notePlace };
