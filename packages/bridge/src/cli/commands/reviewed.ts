/*
 * `once-upon reviewed ID [--undo]`: mark a local story reviewed (or unmark it) from a session, for when you have said
 * "approved". It writes the story's reviewed.json in-process, the same file the board card's Mark
 * reviewed writes, so nothing goes over HTTP. A PR story is marked by reviewing it on GitHub.
 */
import { StoryStore } from '../../stories/store.ts';
import { localStory, markStoryReviewed } from '../../story-lists/stories.ts';
import { out } from '../output.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command } from '../../types.ts';

const USAGE = 'usage: once-upon reviewed ID [--undo]';

function reviewed(home: string, cfg: Config, opts: CliOpts) {
  // `--undo ID` reads ID as the flag's value, so take it from there too
  const id = (opts._ || [])[0] ?? (typeof opts.undo === 'string' ? opts.undo : undefined);
  if (!id) {
    throw new Error(USAGE);
  }
  const stories = new StoryStore({ home });
  const story = localStory(stories, id);
  if (!story) {
    throw new Error(`no local story ${id} (once-upon list shows them)`);
  }
  const undo = !!opts.undo;
  markStoryReviewed(stories, id, !undo);
  return out(`${id} ${undo ? 'marked not reviewed' : 'marked reviewed'}: ${story.title}`);
}

export const reviewedCommands: Command[] = [
  {
    name: 'reviewed',
    usage: [
      '  once-upon reviewed ID [--undo]                                                  mark a local story reviewed (it leaves Ready for your review), or --undo',
    ],
    run: reviewed,
  },
];
