/*
 * The review inbox: `once-upon review` prints (and opens) the inbox page's link, with its key.
 */
import { execFile } from 'node:child_process';
import { openArgv } from '../../config/settings.ts';
import { REPO_RE } from '../../config/repos.ts';
import { inboxPageUrl } from '../../server/page-key.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

/** `once-upon review [--repo owner/name] [--no-open]`: the review inbox page's link. */
function review(home: string, cfg: Config, opts: CliOpts) {
  const repo = opts.repo ? String(opts.repo) : null;
  if (repo && !REPO_RE.test(repo)) {
    throw new Error('--repo is owner/name');
  }
  const url = inboxPageUrl(Number(opts.port || cfg.port), cfg.token, repo);
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
      '  once-upon review  [--repo OWNER/NAME] [--no-open]             the review inbox page: what waits for your review',
    ],
    run: review,
  },
];
