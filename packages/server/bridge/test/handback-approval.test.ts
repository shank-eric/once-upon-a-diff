import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { claimAt, git, localRepo, runCli, tmp, writeJson } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { readApproval } from '@once-upon-a-diff/stories/approval';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';

// `handback` ends a run the way `agent finish` does: a fixer's commit on an approved story's card keeps the approval.
const SID = 'abcd1234';

test('a fixer’s handback carries the approved story to the commit it made', async () => {
  const home = tmp('home');
  writeJson(path.join(home, 'config.json'), { board_sessions_dir: tmp('sessions') });
  const { repo, base } = localRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const chapters = path.join(tmp('ch'), 'chapters.json');
  writeJson(chapters, {
    title: 'Two commits',
    chapters: [
      {
        refs: [],
        title: 'Chapter 1',
        narrative: 'Told.',
        files: ['one.txt', 'lib/two.js', 'gone.txt'],
      },
    ],
  });
  const { id } = createLocalStory({ home, repo, base, head: 'feature', chapters });
  const backlog = new BacklogStore(home);
  const item = backlog.add({ title: 'The work', repo: 'acme/widgets' });
  backlog.start(item.id, { branch: 'feature' });
  claimAt(backlog, item.id, 'ship-author', new Date().toISOString(), SID);
  const cli = (...args: string[]) => runCli(home, args);
  assert.equal((await cli('approve', id)).code, 0);
  const first = git(repo, 'rev-parse', 'HEAD');
  const started = await cli(
    'agent',
    'start',
    'fix-it',
    '--role',
    'fixer',
    '--card',
    item.id,
    '--task',
    't',
    '--sid',
    SID,
    '--cwd',
    repo,
  );
  assert.equal(started.code, 0, started.stderr);
  writeFileSync(path.join(repo, 'two.txt'), 'two\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'two');
  const second = git(repo, 'rev-parse', 'HEAD');
  const back = await cli('handback', 'fix-it', '--sid', SID);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /approval carried/);
  const carried = readApproval(new StoryStore({ home }), id);
  assert.equal(carried?.head_oid, second);
  assert.equal(carried?.carried?.from, first);
});
