/*
 * `once-upon repo settings [REPO] [--json]`: what config.json's `repos` block says about a repo (skips_review, stories, deploy,
 * keep_branches). The board reads the same values through `repoSettings`; the editor runs this to learn them. It reads the
 * file only (ADR-15). With no REPO it is the repo of the current checkout.
 */
import { repoOfCheckout } from '@once-upon-a-diff/foundation/repos';
import { readSettings, repoSettings } from '@once-upon-a-diff/foundation/settings';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE = 'usage: once-upon repo settings [owner/name | name] [--json]';

const yesNo = (value: boolean | undefined, unset: string): string => {
  if (value === undefined) {
    return unset;
  }
  return value ? 'yes' : 'no';
};

function repo(home: string, _cfg: Config, opts: CliOpts) {
  const [verb, named] = opts._ || [];
  if (verb !== 'settings') {
    throw new Error(USAGE);
  }
  const name = named || repoOfCheckout(process.cwd());
  if (!name) {
    throw new Error(`no repo given and this folder is not a GitHub checkout\n${USAGE}`);
  }
  const found = repoSettings(readSettings(home), name);
  if (opts.json) {
    return out(
      JSON.stringify({
        repo: name,
        skips_review: !!found.skips_review,
        stories: found.stories ?? null,
        deploy: found.deploy ?? null,
        keep_branches: !!found.keep_branches,
      }),
    );
  }
  return out(
    [
      `Repo: ${name}`,
      `Skips review: ${yesNo(found.skips_review ?? false, 'no')} (finished work is ${found.skips_review ? 'Ready to ship' : 'Ready for your review'})`,
      `Stories: ${yesNo(found.stories, 'not set (the repo profile decides)')}`,
      `Deploy: ${found.deploy ?? 'not set (the repo profile decides)'}${found.deploy === 'pr' ? ' (ship through a pull request, no deploy command)' : ''}`,
      `Keeps branches: ${yesNo(found.keep_branches ?? false, 'no')}`,
    ].join('\n'),
  );
}

export const repoCommands: Command[] = [
  {
    name: 'repo',
    subs: ['settings'],
    usage: [
      "  once-upon repo settings [owner/name | name] [--json]                             the per-repo settings in config.json (skips_review, stories, deploy, keep_branches); no repo: this checkout's",
    ],
    run: repo,
  },
];
