/*
 * A PR story's id keeps the case GitHub's page URL spells the repo with (EverFi-everfi-frontend-6943), so a rebuild of a PR is
 * the same story. On a case-insensitive disk a second spelling would be a second id on one folder. The 22 live PR stories of
 * ~/.once-upon are all mixed-case, and every other story fixture here is lower-case, so this one is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmp, githubStory, runCli } from './helpers.ts';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { storyIdForPr } from '@once-upon-a-diff/terms/ids';
import { resolveStory } from '@once-upon-a-diff/core/features/listeners/story-ref';

test('publishing a mixed-case PR twice is one story, one id, and the build settles on it', async () => {
  const home = tmp('home');
  const src = tmp('scratch');
  githubStory(src);
  const prJson = path.join(src, 'pr.json');
  writeFileSync(
    prJson,
    JSON.stringify({
      ...JSON.parse(readFileSync(prJson, 'utf8')),
      url: 'https://github.com/EverFi/Widgets/pull/7',
    }),
  );
  const builds = new Builds(home);
  builds.request({ repo: 'EverFi/Widgets', number: 7 });

  const first = await runCli(home, ['publish', '--dir', src]);
  assert.equal(first.code, 0, first.stderr);
  const again = await runCli(home, ['publish', '--dir', src]);
  assert.equal(again.code, 0, again.stderr);

  const id = storyIdForPr('EverFi/Widgets', 7);
  assert.equal(id, 'EverFi-Widgets-7');
  const store = new StoryStore({ home });
  assert.deepEqual(
    store.list().map((story) => story.id),
    [id],
  );
  assert.equal(store.find('everfi/widgets', 7)!.id, id);
  assert.equal(builds.get('EverFi/Widgets', 7)!.story, id);
  // a --story naming the PR in any case finds that story
  assert.equal(
    resolveStory(home, 'everfi/widgets#7', () => null),
    id,
  );
});

test('a --story naming a PR with no story yet gives the id publish will give it', () => {
  const home = tmp('home');
  assert.equal(
    resolveStory(home, 'EverFi/CourseVersionReporter#51', () => null),
    'EverFi-CourseVersionReporter-51',
  );
});
