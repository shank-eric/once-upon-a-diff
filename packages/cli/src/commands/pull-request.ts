/*
 * pr-draft: a session hands over the title and body for a local story's PR, for the page's Create pull request
 * button (core/src/records/stories/pull-request.ts). It only saves them: the reviewer pushes and opens the PR from the page.
 */
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { readMeta } from '@once-upon-a-diff/core/records/stories/meta';
import { DRAFT_FILE } from '@once-upon-a-diff/core/records/stories/pull-request';
import { out } from '../output.ts';
import { bodyText, given } from '../options.ts';
import type { PrDraft } from '@once-upon-a-diff/contracts/types';
import type { Config } from '@once-upon-a-diff/core/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

const USAGE =
  'usage: once-upon pr-draft --story ID --title T (--body-file F | --body TEXT) [--base BRANCH]';
const MAX_TITLE = 256;
const MAX_BODY = 65536; // GitHub's own limit on a PR body

function prDraft(home: string, _cfg: Config, opts: CliOpts) {
  const id = given(opts.story);
  const title = given(opts.title)?.trim();
  if (!id || !title) {
    throw new Error(USAGE);
  }
  const store = new StoryStore({ home });
  const dir = store.dirOf(id);
  if (!dir) {
    throw new Error(`no story ${id} (once-upon list shows them)`);
  }
  if (readMeta(dir).kind !== 'local') {
    throw new Error(`${id} is a PR story: it already has its pull request`);
  }
  const text = bodyText(opts);
  if (text === null) {
    throw new Error(USAGE);
  }
  const body = text.trim();
  if (title.length > MAX_TITLE) {
    throw new Error(`the title is ${title.length} characters; keep it under ${MAX_TITLE}`);
  }
  if (body.length > MAX_BODY) {
    throw new Error(`the body is ${body.length} characters; GitHub takes at most ${MAX_BODY}`);
  }
  const draft: PrDraft = { title, body, base: given(opts.base), at: new Date().toISOString() };
  store.writeState(id, DRAFT_FILE, draft);
  out(
    `Saved the PR title and body for ${id}. The story page's Create pull request button uses them; the reviewer pushes and opens the PR from there.`,
  );
}

export const pullRequestCommands: Command[] = [
  {
    name: 'pr-draft',
    usage: [
      '  once-upon pr-draft --story ID --title T (--body-file F | --body TEXT) [--base BRANCH]',
      "                                                                 hand over a local story's PR title and body for the page's",
      '                                                                 Create pull request button (--body-file - reads stdin)',
    ],
    run: prDraft,
  },
];
