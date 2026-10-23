/*
 * Build requests from the terminal: list the pending ones and claim one as
 * it's built (builds), and finish one (done).
 */
import { formatTime, readerOf } from '../../config/settings.ts';
import { Builds, updateOf } from '../../inbox/builds.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

function builds(home: string, cfg: Config, opts: CliOpts) {
  const requests = new Builds(home);
  if (opts.start) {
    // wait already claimed it; on a long build this keeps the claim fresh, so it isn't handed out again
    const build = requests.claim(String(opts.start), (opts.consumer as string | undefined) || null);
    if (!build) {
      throw new Error(`no pending build request ${opts.start}`);
    }
    return out(
      `${build.id} building (${build.number ? `${build.repo}#${build.number}` : build.story})`,
    );
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
    const update = build.mode ? `\n\t${updateOf(build, readerOf(home))}` : '';
    const what = build.number ? `${build.repo}#${build.number}` : `story ${build.story}`;
    out(
      `${build.id}\t${requests.stateOf(build)}\t${what}\t${formatTime(build.requested_at)}\t${build.url || build.story_dir || ''}${update}`,
    );
  }
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
