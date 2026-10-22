/*
 * Build requests from the terminal: list the pending ones and claim one as
 * it's built (builds), and finish one (done).
 */
import { formatTime, readerOf } from '../../config/settings.mjs';
import { Builds, updateOf } from '../../inbox/builds.mjs';
import { out } from '../output.mjs';

function builds(home, cfg, opts) {
  const requests = new Builds(home);
  if (opts.start) {
    // wait already claimed it; on a long build this keeps the claim fresh, so it isn't handed out again
    const build = requests.claim(String(opts.start), opts.consumer || null);
    if (!build) {
      throw new Error(`no pending build request ${opts.start}`);
    }
    return out(`${build.id} building (${build.repo}#${build.number})`);
  }
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
    const update = build.mode === 'update' ? `\n\t${updateOf(build, readerOf(home))}` : '';
    out(
      `${build.id}\t${requests.stateOf(build)}\t${build.repo}#${build.number}\t${formatTime(build.requested_at)}\t${build.url}${update}`,
    );
  }
}

function done(home, cfg, opts) {
  const id = (opts._ || [])[0] || opts.id;
  if (!id) {
    throw new Error('usage: pr-story done <build id | owner/repo#N> [--failed] [--note TEXT]');
  }
  const build = new Builds(home).done(id, {
    failed: !!opts.failed,
    note: typeof opts.note === 'string' ? opts.note : null,
  });
  if (!build) {
    throw new Error(`no build request ${id}`);
  }
  out(`${build.id} ${build.status} (${build.repo}#${build.number})`);
}

export const buildCommands = [
  {
    name: 'builds',
    usage: [
      '  pr-story builds  [--start ID] [--json]                       pending "Build story" requests, queued or building, and for an update where',
      "                                                                 the reviewer's reading stopped (since); --start refreshes a claim on a long build",
    ],
    run: builds,
  },
  {
    name: 'done',
    usage: [
      '  pr-story done    <build id | owner/repo#N> [--failed] [--note TEXT]   finish one (a story turning up finishes it too)',
    ],
    run: done,
  },
];
