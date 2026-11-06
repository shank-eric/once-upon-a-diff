/*
 * What a Claude session tells the panel while it fixes notes: which files it's changing (working, which the panel
 * shows as "Being changed by <session>"), and how a fix request ended (fixed). See core/src/queues/requests/fixes.ts and
 * core/src/queues/requests/working.ts.
 */
import { readMeta, storyRepo } from '@once-upon-a-diff/core/records/stories/meta';
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { Inbox } from '@once-upon-a-diff/core/queues/requests/inbox';
import { readFixes, reportFix } from '@once-upon-a-diff/core/queues/requests/fixes';
import { Listening, answeringOf } from '@once-upon-a-diff/core/features/listeners/service';
import { clearMark, parseFiles, setMark } from '@once-upon-a-diff/core/queues/requests/working';
import { storyIdOf } from './inbox.ts';
import { out } from '../output.ts';
import { given } from '../options.ts';
import { plural } from '@once-upon-a-diff/domain/text';
import type { FixRequest } from '@once-upon-a-diff/core/queues/requests/fixes';
import type { Config } from '@once-upon-a-diff/core/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const WORKING_USAGE =
  'usage: once-upon working (--story ID | --request F) [--files P[:A-B],... | --done [SHA]] [--consumer NAME]';
const FIXED_USAGE =
  'usage: once-upon fixed --request F (--sha SHA [--notes N1,N2] | --failed) [--note TEXT] [--consumer NAME]';

/**
 * Who the panel says is at work: --consumer, else the wait the request was handed to, else the session that
 * answers the story now.
 */
function consumerFor(
  home: string,
  opts: CliOpts,
  story: string,
  request: FixRequest | null,
): string {
  if (given(opts.consumer)) {
    return given(opts.consumer) as string;
  }
  if (request && request.claimed_by) {
    return request.claimed_by;
  }
  const dir = new StoryStore({ home }).dirOf(story);
  const repo = dir ? storyRepo(readMeta(dir)) : null;
  const live = new Listening(home).live();
  const goTo = answeringOf(live, { repo, story });
  return goTo ? goTo.consumer : 'a Claude session';
}

function requestOf(home: string, id: string): FixRequest {
  const request = readFixes(home)[id];
  if (!request) {
    throw new Error(`no fix request ${id}`);
  }
  return request;
}

function working(home: string, cfg: Config, opts: CliOpts) {
  const request = given(opts.request) ? requestOf(home, given(opts.request) as string) : null;
  const story = given(opts.story)
    ? storyIdOf(home, opts.story as string)
    : request && request.story;
  if (!story) {
    throw new Error(WORKING_USAGE);
  }
  if (!new StoryStore({ home }).dirOf(story)) {
    throw new Error(`no story ${story} (see: once-upon list)`);
  }
  const consumer = consumerFor(home, opts, story, request);
  if (opts.done) {
    const cleared = clearMark(home, story, consumer, { sha: given(opts.done) });
    out(
      cleared
        ? `Cleared: ${cleared.consumer} is done changing ${story}${given(opts.done) ? ` (${given(opts.done)})` : ''}.`
        : `No "being changed" mark on ${story} to clear.`,
    );
    return;
  }
  const files = given(opts.files) ? parseFiles(opts.files) : null;
  const mark = setMark(home, story, consumer, { files, request: request && request.id });
  new Listening(home).touchHandling(consumer); // a long change keeps its listener live
  out(
    `${files ? 'Marked' : 'Still marked'}: ${mark.files.map((file) => file.path).join(', ')} on ${story}, being changed by ${consumer}. ` +
      'Run it again on a long change, and clear it with --done <sha>.',
  );
}

function fixed(home: string, cfg: Config, opts: CliOpts) {
  const id = given(opts.request);
  if (!id || (!given(opts.sha) && !opts.failed)) {
    throw new Error(FIXED_USAGE);
  }
  const request = requestOf(home, id);
  const consumer = consumerFor(home, opts, request.story, request);
  const store = new StoryStore({ home });
  const noteIds = given(opts.notes)
    ? (given(opts.notes) as string)
        .split(',')
        .map((note) => note.trim())
        .filter(Boolean)
    : null;
  const done = reportFix(home, store, id, {
    sha: given(opts.sha),
    fixed: noteIds,
    failed: !!opts.failed,
    why: given(opts.note),
    by: consumer,
    inbox: new Inbox(home),
  });
  clearMark(home, request.story, consumer, { sha: given(opts.sha) });
  const fixedIds = done.fixed as string[]; // a report sets it
  const left = request.notes.length - fixedIds.length;
  out(
    opts.failed
      ? `${id}: not fixed. Its ${request.notes.length} note${request.notes.length === 1 ? ' is' : 's are'} back in the reviewer's drafts.`
      : `${id}: ${plural(fixedIds.length, 'note')} fixed in ${done.sha}${left ? `, ${left} back in the drafts` : ''}. The panel shows it within a few seconds.`,
  );
}

export const fixCommands: Command[] = [
  {
    name: 'working',
    usage: [
      '  once-upon working (--story ID | --request F) [--files P[:A-B],... | --done [SHA]] [--consumer NAME]',
      '                                                                 tell the panel which files this session is changing ("Being changed by");',
      '                                                                 again with no --files to keep the mark fresh, --done to clear it',
    ],
    run: working,
  },
  {
    name: 'fixed',
    usage: [
      '  once-upon fixed   --request F (--sha SHA [--notes N1,N2] | --failed) [--note TEXT] [--consumer NAME]',
      '                                                                 report a fix request: the notes fixed in SHA (all unless --notes),',
      '                                                                 or --failed; the rest go back to the drafts with --note as why',
    ],
    run: fixed,
  },
];
