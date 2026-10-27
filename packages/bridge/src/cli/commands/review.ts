/*
 * The review inbox: `once-upon review` prints (and opens) the inbox page's link, with its key, and says how many
 * turns wait. The turns come from the capture hook (skills/once-upon/bin/capture-turn.sh) through its spool, which the bridge reads.
 */
import { execFile } from 'node:child_process';
import { openArgv } from '../../config/settings.ts';
import { pageOrigin } from '../../server/address.ts';
import { REPO_RE } from '../../config/repos.ts';
import { inboxPageUrl } from '../../server/page-key.ts';
import { TurnStore } from '../../capture/turns.ts';
import { plural } from '@once-upon-a-diff/shared/util/text';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

/** `once-upon review [--repo owner/name] [--local] [--no-open]`: the review inbox page's link, on the proxy's name (`--local`: 127.0.0.1). */
async function review(home: string, cfg: Config, opts: CliOpts) {
  const repo = opts.repo ? String(opts.repo) : null;
  if (repo && !REPO_RE.test(repo)) {
    throw new Error('--repo is owner/name');
  }
  const waiting = new TurnStore(home).all({ repo }).filter((turn) => !turn.reviewed_at).length;
  const url = inboxPageUrl(
    Number(opts.port || cfg.port),
    cfg.token,
    repo,
    null,
    await pageOrigin(home, Number(opts.port || cfg.port), !!opts.local),
  );
  process.stderr.write(`${plural(waiting, 'turn')} to review${repo ? ` in ${repo}` : ''}\n`);
  out(url);
  if (!opts['no-open']) {
    const [cmd, ...args] = openArgv(url, home);
    execFile(cmd, args, () => {});
  }
}

export const reviewCommands: Command[] = [
  {
    name: 'review',
    usage: [
      '  once-upon review  [--repo OWNER/NAME] [--local] [--no-open]   the review inbox page: the turns the capture hook recorded, to review one by one',
    ],
    run: review,
  },
];
