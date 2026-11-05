/*
 * `once-upon approve ID [--undo]`: approve a local story from a session, for when you have said "approved" in
 * conversation. The same thing the story page's Approve button does (core/src/features/review/approve.ts), in-process: it approves
 * the story at its head as it is now, marks it reviewed, and appends the `approved` event a listening session hears.
 * --undo clears the approval.
 */
import { Inbox } from '@once-upon-a-diff/core/queues/requests/inbox';
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { readMeta, storyRepo } from '@once-upon-a-diff/core/records/stories/meta';
import { refreshLocal } from '@once-upon-a-diff/core/records/stories/local-diff';
import { approveStory, clearApproval } from '@once-upon-a-diff/core/features/review/approve';
import { localStory } from '@once-upon-a-diff/core/features/review/story-lists';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/core/foundation/settings';
import type { CliOpts, Command } from '../types.ts';
import type { LocalMeta } from '@once-upon-a-diff/core/records/stories/types';
import { shortSha } from '@once-upon-a-diff/domain/text';

const USAGE = 'usage: once-upon approve ID [--undo]';

function approve(home: string, cfg: Config, opts: CliOpts) {
  // `--undo ID` reads ID as the flag's value, so take it from there too
  const id = (opts._ || [])[0] ?? (typeof opts.undo === 'string' ? opts.undo : undefined);
  if (!id) {
    throw new Error(USAGE);
  }
  const stories = new StoryStore({ home });
  const story = localStory(stories, id);
  const dir = stories.dirOf(id);
  if (!story || !dir) {
    throw new Error(`no local story ${id} (once-upon list shows them)`);
  }
  if (opts.undo) {
    clearApproval(stories, id);
    return out(`${id} approval cleared: ${story.title}`);
  }
  const meta = refreshLocal(dir, readMeta(dir) as LocalMeta);
  if (!meta.head_oid) {
    throw new Error(`${id} has no head yet: open its page once, or rebuild it`);
  }
  const added = approveStory(stories, new Inbox(home), {
    id,
    ref: { story: id, kind: 'local', title: story.title, repo: storyRepo(meta) },
    branch: meta.branch || null,
    checkout: meta.repo_path || null,
    base: meta.base || null,
    headOid: meta.head_oid,
    baseOid: meta.base_oid || null,
  });
  return out(
    `${id} ${added ? 'approved' : 'already approved'} at ${shortSha(meta.head_oid)}: ${story.title}`,
  );
}

export const approveCommands: Command[] = [
  {
    name: 'approve',
    usage: [
      '  once-upon approve ID [--undo]                                                   approve a local story at its head (ready to ship; a listening session hears it), or --undo',
    ],
    run: approve,
  },
];
