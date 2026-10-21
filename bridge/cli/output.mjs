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
    const update = entry.mode === 'update' ? `\n${updateOf(entry, readerOf())}` : '';
    return `[${when}] build request ${entry.id}: ${entry.repo}#${entry.number} ${entry.url}${update}\n${entry.text || ''}`.trimEnd();
  }
  if (entry.type === 'build_done') {
    return `[${when}] build ${entry.build} ${entry.status} (${entry.repo}#${entry.number})${entry.story ? ` story ${entry.story}` : ''}${entry.note ? `: ${entry.note}` : ''}`;
  }
  if (entry.type === 'answer') {
    return `[${when}] answer to ${entry.question}\n${entry.text}`;
  }
  if (entry.type === 'note') {
    return `[${when}] note ${entry.action} (${entry.story}) ${notePlace(entry.note)}${entry.note.done ? ' [done]' : ''}\n${entry.note.body}`;
  }
  if (entry.type === 'position') {
    return `[${when}] position (${where})`;
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
