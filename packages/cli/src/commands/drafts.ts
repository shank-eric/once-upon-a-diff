/*
 * Drafted comments and notes from the terminal: add a comment drafted in Q&A
 * to a chapter (comment), list each draft's state (drafts), and a story's
 * fix-before-push notes (notes).
 */
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { readMeta, readStoredMeta } from '@once-upon-a-diff/core/records/stories/meta';
import { addComment } from '@once-upon-a-diff/core/records/stories/comments';
import { Inbox } from '@once-upon-a-diff/core/queues/requests/inbox';
import { draftsOf } from '@once-upon-a-diff/core/features/review/drafts';
import { out, notePlace } from '../output.ts';
import { bodyText } from '../options.ts';

import type { DraftRow, LocalNote } from '@once-upon-a-diff/contracts/types';
import type { Config } from '@once-upon-a-diff/core/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const storeFor = (home: string) => new StoryStore({ home });

function comment(home: string, cfg: Config, opts: CliOpts) {
  const body = bodyText(opts) ?? '';
  if (!opts.story || !opts.chapter || !body.trim()) {
    throw new Error(
      'usage: once-upon comment --story ID --chapter N [--path P --line L] (--body-file F | --body T) (--body-file - reads stdin)',
    );
  }
  const dir = storeFor(home).dirOf(opts.story as string);
  if (!dir) {
    throw new Error(`no story ${opts.story} (see: once-upon list)`);
  }
  const meta = readStoredMeta(dir);
  const result = addComment(dir, meta, {
    chapter: opts.chapter,
    path: typeof opts.path === 'string' ? opts.path : '',
    line: opts.line,
    body,
  });
  if (result.added) {
    new Inbox(home).append({
      type: 'comment',
      story: opts.story as string,
      chapter: result.chapter,
      comment: result.comment,
    });
  }
  out(
    `${result.added ? 'Added to' : 'Already in'} chapter ${result.chapter}'s draft comments (${result.files.join(', ')}). The panel shows it within a few seconds.`,
  );
}

function stateOf(row: DraftRow): string {
  if (row.dismissed) {
    return 'dismissed';
  }
  return row.status === 'draft' && row.added ? 'added to your review' : row.status;
}

async function drafts(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.story) {
    throw new Error('usage: once-upon drafts --story ID [--json]');
  }
  const store = storeFor(home);
  const dir = store.dirOf(opts.story as string);
  if (!dir) {
    throw new Error(`no story ${opts.story}`);
  }
  const { chapters, rows, error } = await draftsOf(
    home,
    store,
    opts.story as string,
    readMeta(dir),
  );
  if (error) {
    process.stderr.write(`${error}\n`);
  }
  if (opts.json) {
    return out(JSON.stringify(rows, null, 2));
  }
  for (const row of rows) {
    const draft = chapters[row.chapter - 1].comments[row.index];
    out(
      `ch ${row.chapter} #${row.index + 1}  ${stateOf(row)}  ${draft.path}${draft.line ? `:${draft.line}` : ''}  ${draft.body.replace(/\s+/g, ' ').slice(0, 70)}${row.url ? `  ${row.url}` : ''}`,
    );
  }
}

/** Where a note has got: sent to a session, fixed in a commit, or back from one. */
function noteSuffix(note: LocalNote): string {
  if (note.fixed) {
    return `  [fixed in ${note.fixed.sha}]`;
  }
  if (note.sent) {
    return `  [sent to ${note.sent.to || 'the next session'}]`;
  }
  return note.returned ? `  [back: ${note.returned.why}]` : '';
}

function notes(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.story) {
    throw new Error('usage: once-upon notes --story ID');
  }
  const store = storeFor(home);
  const list = store.readState<LocalNote[]>(opts.story as string, 'notes.json', []) as LocalNote[];
  if (opts.json) {
    return out(JSON.stringify(list, null, 2));
  }
  if (!list.length) {
    return out('No fix-before-push notes.');
  }
  for (const note of list) {
    out(
      `- [${note.done ? 'x' : ' '}] ${notePlace(note)}: ${note.body.replace(/\n/g, ' ')}${noteSuffix(note)}  (${note.id})`,
    );
  }
}

export const draftCommands: Command[] = [
  {
    name: 'comment',
    usage: [
      '  once-upon comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)',
      "                                                                 add a drafted comment to a chapter's Draft comments (never posted); --body-file - reads stdin",
    ],
    run: comment,
  },
  {
    name: 'drafts',
    usage: [
      '  once-upon drafts  --story ID [--json]                         each drafted comment: draft, posted, in your pending review, or dismissed',
    ],
    run: drafts,
  },
  {
    name: 'notes',
    usage: [
      '  once-upon notes   --story ID [--json]                         fix-before-push notes: draft, sent to a session, or fixed',
    ],
    run: notes,
  },
];
