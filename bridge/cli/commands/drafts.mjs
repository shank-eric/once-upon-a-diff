/*
 * Drafted comments and notes from the terminal: add a comment drafted in Q&A
 * to a chapter (comment), list each draft's state (drafts), and a local
 * story's fix-before-push notes (notes).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StoryStore } from '../../stories/store.mjs';
import { readMeta } from '../../stories/meta.mjs';
import { addComment } from '../../stories/comments.mjs';
import { Inbox } from '../../inbox/inbox.mjs';
import { stateKeyOf, readMarks, draftStatus, githubComments } from '../../github/drafts.mjs';
import { out, notePlace } from '../output.mjs';

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
      'usage: diff-story comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)',
    );
  }
  const dir = storeFor(home).dirOf(opts.story);
  if (!dir) {
    throw new Error(`no story ${opts.story} (see: diff-story list)`);
  }
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    meta = {};
  }
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
    throw new Error('usage: diff-story drafts --story ID [--json]');
  }
  const store = storeFor(home);
  const dir = store.dirOf(opts.story);
  if (!dir) {
    throw new Error(`no story ${opts.story}`);
  }
  const meta = readMeta(dir);
  const data = store.load(opts.story);
  let github = null;
  if (meta.kind === 'github') {
    try {
      github = await githubComments(meta.repo, meta.number);
    } catch (e) {
      process.stderr.write(`gh: ${e.message}\n`);
    }
  }
  const rows = draftStatus(data.chapters, readMarks(home, stateKeyOf(opts.story, meta)), github);
  if (opts.json) {
    return out(JSON.stringify(rows, null, 2));
  }
  for (const row of rows) {
    const draft = data.chapters[row.chapter - 1].comments[row.index];
    out(
      `ch ${row.chapter} #${row.index + 1}  ${stateOf(row)}${row.source === 'manual' ? ' (marked)' : ''}  ${draft.path}${draft.line ? `:${draft.line}` : ''}  ${draft.body.replace(/\s+/g, ' ').slice(0, 70)}${row.url ? `  ${row.url}` : ''}`,
    );
  }
}

function notes(home, cfg, opts) {
  if (!opts.story) {
    throw new Error('usage: diff-story notes --story ID');
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
    out(`- [${note.done ? 'x' : ' '}] ${notePlace(note)}: ${note.body.replace(/\n/g, ' ')}`);
  }
}

export const draftCommands = [
  {
    name: 'comment',
    usage: [
      '  diff-story comment --story ID --chapter N [--path P --line L] (--body-file F | --body T)',
      "                                                                 add a drafted comment to a chapter's Draft comments (never posted)",
    ],
    run: comment,
  },
  {
    name: 'drafts',
    usage: [
      '  diff-story drafts  --story ID [--json]                         each drafted comment: draft, posted, in your pending review, or dismissed',
    ],
    run: drafts,
  },
  {
    name: 'notes',
    usage: [
      '  diff-story notes   --story ID [--json]                         fix-before-push notes for a local story',
    ],
    run: notes,
  },
];
