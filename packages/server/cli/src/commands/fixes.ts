/*
 * What a Claude session tells the panel while it fixes notes: which files it's changing (working, which the panel
 * shows as "Being changed by <session>"), and how a fix request ended (fixed). See state/src/queues/requests/fixes.ts and
 * state/src/queues/requests/working.ts.
 */
import { readMeta, storyRepo } from '@once-upon-a-diff/stories/meta';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import {
  checkFixReport,
  readFixes,
  reportFix,
} from '@once-upon-a-diff/state/queues/requests/fixes';
import {
  Listening,
  answeringOf,
  ownSession,
} from '@once-upon-a-diff/core/features/listeners/service';
import { recordFix, type RecordedFix } from '@once-upon-a-diff/core/features/runs/service';
import { carryApproval } from '@once-upon-a-diff/core/features/review/carry-approval';
import { clearMark, parseFiles, setMark } from '@once-upon-a-diff/state/queues/requests/working';
import { storyIdOf } from './inbox.ts';
import { out } from '../output.ts';
import { given } from '../options.ts';
import { plural, shortSha } from '@once-upon-a-diff/terms/text';
import type { FixRequest } from '@once-upon-a-diff/state/queues/requests/fixes';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const WORKING_USAGE =
  'usage: once-upon working (--story ID | --request F) [--files P[:A-B],... | --done [SHA]] [--consumer NAME]';
const FIXED_USAGE =
  'usage: once-upon fixed --request F (--sha SHA [--notes N1,N2] | --failed) [--note TEXT] [--consumer NAME] [--sid SID8]';

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

/**
 * Every fix request ends as a run on the branch's card: the fix `--sha` is recorded as a done fixer run, unless a run already
 * accounts for it (core/features/runs/record-fix.ts). Returns what to say about it, and the run's id for the request.
 */
async function recordedRun(
  home: string,
  request: FixRequest,
  sha: string,
  noteCount: number,
  consumer: string,
  sid: string | null,
): Promise<{ run: string | null; said: string }> {
  const dir = new StoryStore({ home }).dirOf(request.story);
  const repo = request.repo ?? (dir ? storyRepo(readMeta(dir)) : null);
  if (!repo || !request.branch) {
    return {
      run: null,
      said: ' No run recorded: the request names no repo or branch, so the board cannot tie the fix to a card.',
    };
  }
  const found: RecordedFix = await recordFix(
    home,
    {
      repo,
      branch: request.branch,
      sha,
      checkout: request.checkout,
      since: request.claimed_at ?? request.requested_at,
      task: `fix request ${request.id}: ${plural(noteCount, 'note')}`,
      session: ownSession(),
      sid,
      by: consumer,
    },
    { warn: (line) => process.stderr.write(line + '\n') },
  );
  if (found.covered) {
    return { run: found.run, said: ` Covered by run ${found.run ?? 'already on the card'}.` };
  }
  const carried = found.finished ? carryApproval(home, found.finished) : null;
  return {
    run: found.run,
    said:
      ` Recorded as a fixer run on ${found.card}${found.madeCard ? ` (no open card on ${request.branch}: made it)` : ''}` +
      (carried
        ? `; approval carried ${shortSha(carried.from)} -> ${shortSha(carried.to)}${carried.via ? ` (${carried.via})` : ''}.`
        : '.'),
  };
}

async function fixed(home: string, cfg: Config, opts: CliOpts) {
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
  // the report is checked first (a request taken back, one already reported, a --notes id it lacks), so a refused report records no
  // run and carries no approval; then the run is recorded, and a refusal there (a sha that is not at or behind HEAD) leaves the
  // request pending, not reported with no run
  const sha = given(opts.sha);
  checkFixReport(request, { sha, fixed: noteIds, failed: !!opts.failed });
  const recorded =
    sha && !opts.failed
      ? await recordedRun(
          home,
          request,
          sha,
          noteIds?.length ?? request.notes.length,
          consumer,
          given(opts.sid),
        )
      : null;
  const done = reportFix(home, store, id, {
    sha: given(opts.sha),
    run: recorded?.run,
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
      : `${id}: ${plural(fixedIds.length, 'note')} fixed in ${done.sha}${left ? `, ${left} back in the drafts` : ''}.${recorded?.said ?? ''} The panel shows it within a few seconds.`,
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
      '  once-upon fixed   --request F (--sha SHA [--notes N1,N2] | --failed) [--note TEXT] [--consumer NAME] [--sid SID8]',
      '                                                                 report a fix request: the notes fixed in SHA (all unless --notes),',
      '                                                                 or --failed; the rest go back to the drafts with --note as why',
      "                                                                 --sha also records the fix as a done fixer run on the branch's card (unless a run covers it) and carries an approval",
      '                                                                 --sid names the session to record the run under when CLAUDE_CODE_SESSION_ID is not set',
    ],
    run: fixed,
  },
];
