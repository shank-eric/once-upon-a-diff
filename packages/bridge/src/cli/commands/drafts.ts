// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Drafted comments and notes from the terminal: add a comment drafted in Q&A
 * to a chapter (comment), list each draft's state (drafts), and a story's
 * fix-before-push notes (notes).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StoryStore } from '../../stories/store.ts';
import { readMeta } from '../../stories/meta.ts';
import { addComment } from '../../stories/comments.ts';
import { Inbox } from '../../inbox/inbox.ts';
import { draftsOf } from '../../github/drafts.ts';
import { out, notePlace } from '../output.ts';
import { readJson } from '../../util/json-file.ts';

const storeFor = (home) => new StoryStore({ home });

function bodyOf(opts) {
  if (opts['body-file']) {
    return readFileSync(opts['body-file'], 'utf8');
  }
  return typeof opts.body === 'string' ? opts.body : '';
}

function comment(home, cfg, opts) {
  const body = bodyOf(opts);
  if (!opts.story || !opts.chapter || !body.trim()) {
    throw new Error(
      'usage: once-upon comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)',
    );
  }
  const dir = storeFor(home).dirOf(opts.story);
  if (!dir) {
    throw new Error(`no story ${opts.story} (see: once-upon list)`);
  }
  const meta = readJson(path.join(dir, 'meta.json'), {});
  const result = addComment(dir, meta, {
    chapter: opts.chapter,
    path: typeof opts.path === 'string' ? opts.path : '',
    line: opts.line,
    body,
  });
  if (result.added) {
    new Inbox(home).append({
      type: 'comment',
      story: opts.story,
      chapter: result.chapter,
      comment: result.comment,
    });
  }
  out(
    `${result.added ? 'Added to' : 'Already in'} chapter ${result.chapter}'s draft comments (${result.files.join(', ')}). The panel shows it within a few seconds.`,
  );
}

function stateOf(row) {
  if (row.dismissed) {
    return 'dismissed';
  }
  return row.status === 'draft' && row.added ? 'added to your review' : row.status;
}

async function drafts(home, cfg, opts) {
  if (!opts.story) {
    throw new Error('usage: once-upon drafts --story ID [--json]');
  }
  const store = storeFor(home);
  const dir = store.dirOf(opts.story);
  if (!dir) {
    throw new Error(`no story ${opts.story}`);
  }
  const { chapters, rows, error } = await draftsOf(home, store, opts.story, readMeta(dir));
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
function noteSuffix(note) {
  if (note.fixed) {
    return `  [fixed in ${note.fixed.sha}]`;
  }
  if (note.sent) {
    return `  [sent to ${note.sent.to || 'the next session'}]`;
  }
  return note.returned ? `  [back: ${note.returned.why}]` : '';
}

function notes(home, cfg, opts) {
  if (!opts.story) {
    throw new Error('usage: once-upon notes --story ID');
  }
  const store = storeFor(home);
  const list = store.readState(opts.story, 'notes.json', []);
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

export const draftCommands = [
  {
    name: 'comment',
    usage: [
      '  once-upon comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)',
      "                                                                 add a drafted comment to a chapter's Draft comments (never posted)",
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
