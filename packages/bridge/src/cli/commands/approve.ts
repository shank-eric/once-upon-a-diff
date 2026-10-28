/*
 * `once-upon approve ID [--undo]`: approve a local story from a session, for when you have said "approved" in
 * conversation. The same thing the story page's Approve button does (review-inbox/approve.ts), in-process: it approves
 * the story at its head as it is now, marks it reviewed, and appends the `approved` event a listening session hears.
 * --undo clears the approval.
 */
import { Inbox } from '../../inbox/inbox.ts';
import { StoryStore } from '../../stories/store.ts';
import { readMeta } from '../../stories/meta.ts';
import { refreshLocal } from '../../stories/local-diff.ts';
import { storyRepo } from '../../config/repos.ts';
import { approveStory, clearApproval } from '../../review-inbox/approve.ts';
import { localStory } from '../../review-inbox/stories.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command, LocalMeta } from '../../types.ts';

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
    `${id} ${added ? 'approved' : 'already approved'} at ${meta.head_oid.slice(0, 7)}: ${story.title}`,
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
