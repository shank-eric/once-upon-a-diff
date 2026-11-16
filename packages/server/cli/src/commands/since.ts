/*
 * A local story that moved: `since` says what changed since the reviewer read it (what a "Since you read it" chapter is
 * told from), and `update` asks for that chapter, as the panel's Update does, or for a whole new story with --retell.
 * Both read and write the shared files in-process, never the bridge.
 */
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { localUpdateStart, sinceReport } from '@once-upon-a-diff/core/features/review/since';
import { shortSha } from '@once-upon-a-diff/terms/text';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

/** The story, its folder and its chapters, for --story ID; throws when it isn't a local story. */
function localStory(home: string, opts: CliOpts) {
  const id = String(opts.story || '');
  const store = new StoryStore({ home });
  const dir = id ? store.dirOf(id) : null;
  const data = dir ? store.load(id) : null;
  if (!dir || !data || data.kind !== 'local') {
    throw new Error(`no local story ${id || '(say --story ID)'}: once-upon list shows them`);
  }
  return { id, dir, chapters: data.chapters };
}

function since(home: string, _cfg: Config, opts: CliOpts) {
  const { id, dir, chapters } = localStory(home, opts);
  const report = sinceReport(home, dir, id, chapters);
  if (opts.json) {
    return out(JSON.stringify(report, null, 2));
  }
  out(
    `${id}: since ${shortSha(report.since_sha)} (${report.source === 'read' ? 'where the reviewer stopped reading' : 'the commits the story was told over'}), head ${shortSha(report.head)}`,
  );
  if (!report.readable) {
    return out(
      "git can't read those commits any more: re-tell the story (once-upon update --story ID --retell)",
    );
  }
  const amended = report.ancestor
    ? ''
    : ', and the branch was amended or rebased (the since commit is not behind the head)';
  const moved = report.base_moved
    ? `moved ${shortSha(report.since_base)} -> ${shortSha(report.base)}`
    : 'did not move';
  out(`${report.commits} commit${report.commits === 1 ? '' : 's'}${amended}; the base ${moved}`);
  out(
    report.changed_files.length
      ? `Changed files:\n${report.changed_files.map((file) => `  ${file}`).join('\n')}`
      : 'No file of the story changed.',
  );
  out(`See it with: ${report.command}`);
  out(
    `The chapter: key since-${report.since_sha.slice(0, 7)}-${report.head.slice(0, 7)}, since {from: ${report.since_sha}, to: ${report.head}, commits: ${report.commits}}`,
  );
}

function update(home: string, _cfg: Config, opts: CliOpts) {
  const { id, dir, chapters } = localStory(home, opts);
  const builds = new Builds(home);
  const { meta, since: start } = localUpdateStart(home, dir, id, chapters);
  const told = chapters.filter((chapter) => !chapter.auto);
  const build = opts.retell
    ? builds.requestRebuild({
        story: id,
        meta,
        mode: 'rebuild',
        chapters: told.length,
        story_dir: dir,
      })
    : builds.requestStoryUpdate({ story: id, meta, since: start, story_dir: dir });
  out(`${build.id} ${build.mode} for ${id} (once-upon wait --story ${id} hands it over)`);
}

export const sinceCommands: Command[] = [
  {
    name: 'since',
    usage: [
      '  once-upon since   --story ID [--json]                          what changed in a local story since the reviewer read it (or since it was told):',
      '                                                                 the commits, the files and the git command for a "Since you read it" chapter',
    ],
    run: since,
  },
  {
    name: 'update',
    usage: [
      '  once-upon update  --story ID [--retell]                        ask for a local story to be updated (a "Since you read it" chapter, the others kept),',
      '                                                                 or re-told from scratch with --retell; a fix round on a story the reviewer read is an update',
    ],
    run: update,
  },
];
