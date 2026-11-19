/*
 * Build requests from the terminal: list the pending ones and claim one as
 * it's built (builds), and finish one (done).
 */
import { formatTime, readerOf } from '@once-upon-a-diff/foundation/settings';
import { Builds, buildText, updateOf } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readMeta } from '@once-upon-a-diff/stories/meta';
import { currentHead } from '@once-upon-a-diff/core/features/review/freshness';
import { isRebuild } from '@once-upon-a-diff/stories/rebuild';
import { parsePrRef } from '@once-upon-a-diff/terms/ids';
import { out } from '../output.ts';
import type { Build } from '@once-upon-a-diff/state/queues/requests/builds';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

/** The stored story for a PR and the PR's head, to tell an update (it moved) from a re-tell (it didn't). */
async function storyOf(home: string, pr: NonNullable<ReturnType<typeof parsePrRef>>) {
  const stories = new StoryStore({ home });
  const hit = stories.find(pr.repo, pr.number);
  const dir = hit ? stories.dirOf(hit.id) : null;
  const told = dir ? readMeta(dir).head_oid || null : null;
  // gh can't say where the story left off, so a re-tell
  const head = hit ? await currentHead(pr.repo, pr.number).catch(() => null) : null;
  return { story: hit ? { id: hit.id, dir, head_oid: told } : null, head };
}

/** `--begin`: an agent builds a story with no panel click: file the PR's request, already claimed, so the page shows Building. */
async function begin(home: string, requests: Builds, opts: CliOpts) {
  const pr = parsePrRef(String(opts.begin));
  if (!pr || typeof opts.consumer !== 'string') {
    throw new Error(
      'usage: once-upon builds --begin <owner/repo#N | PR url> --consumer <your name>',
    );
  }
  const build = requests.begin(pr.repo, pr.number, {
    consumer: opts.consumer,
    ...(await storyOf(home, pr)),
  });
  out(`${build.id} building (${build.repo}#${build.number})`);
  if (build.mode) {
    // not a plain Build story: what it asks, and the part of the skill that tells it
    const rebuild = isRebuild(build);
    out(
      `${rebuild ? 'Rebuild' : 'Update'} request, not a new story: ${buildText(build, readerOf(home))}`,
    );
    out(
      `Follow the skill's "${rebuild ? 'Rebuilding a story' : 'Updating a story'}" section for it.`,
    );
  }
}

/** `--start`: wait already claimed it; on a long build this keeps the claim fresh, so it isn't handed out again. */
function refreshClaim(requests: Builds, opts: CliOpts) {
  const build = requests.claim(String(opts.start), (opts.consumer as string | undefined) || null);
  if (!build) {
    throw new Error(`no pending build request ${opts.start}`);
  }
  return out(
    `${build.id} building (${build.number ? `${build.repo}#${build.number}` : build.story})`,
  );
}

/** One pending request, a line of the list (and the update it asks beneath it). */
function pendingLine(home: string, requests: Builds, build: Build): string {
  const update = build.mode ? `\n\t${updateOf(build, readerOf(home))}` : '';
  const what = build.number ? `${build.repo}#${build.number}` : `story ${build.story}`;
  return `${build.id}\t${requests.stateOf(build)}\t${what}\t${formatTime(build.requested_at)}\t${build.url || build.story_dir || ''}${update}`;
}

function listPending(home: string, requests: Builds, opts: CliOpts) {
  const pending = requests.pending();
  if (opts.json) {
    return out(
      JSON.stringify(
        pending.map((build) => requests.view(build)),
        null,
        2,
      ),
    );
  }
  if (!pending.length) {
    return out('No pending build requests.');
  }
  for (const build of pending) {
    out(pendingLine(home, requests, build));
  }
}

async function builds(home: string, cfg: Config, opts: CliOpts) {
  const requests = new Builds(home);
  if (opts.begin) {
    return begin(home, requests, opts);
  }
  if (opts.start) {
    return refreshClaim(requests, opts);
  }
  return listPending(home, requests, opts);
}

function done(home: string, cfg: Config, opts: CliOpts) {
  const id = (opts._ || [])[0] || (opts.id as string | undefined);
  if (!id) {
    throw new Error('usage: once-upon done <build id | owner/repo#N> [--failed] [--note TEXT]');
  }
  const build = new Builds(home).done(id, {
    failed: !!opts.failed,
    note: typeof opts.note === 'string' ? opts.note : null,
  });
  if (!build) {
    throw new Error(`no build request ${id}`);
  }
  out(
    `${build.id} ${build.status} (${build.number ? `${build.repo}#${build.number}` : build.story})`,
  );
}

export const buildCommands: Command[] = [
  {
    name: 'builds',
    usage: [
      '  once-upon builds  [--start ID] [--json]                       pending "Build story" requests, queued or building, and for an update where',
      "                                                                 the reviewer's reading stopped (since); --start refreshes a claim on a long build",
      "  once-upon builds  --begin <owner/repo#N | PR url> --consumer NAME  an agent builds the story itself: file the PR's request already claimed (the page shows Building); again refreshes it",
    ],
    run: builds,
  },
  {
    name: 'done',
    usage: [
      '  once-upon done    <build id | owner/repo#N> [--failed] [--note TEXT]   finish one (a story turning up finishes it too)',
    ],
    run: done,
  },
];
