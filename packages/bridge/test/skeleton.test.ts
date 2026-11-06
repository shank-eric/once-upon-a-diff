import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmp, writeJson, githubStory, startBridge } from './helpers.ts';
import { noteSkeleton, skeletonKeys, unwrittenCount } from '@once-upon-a-diff/stories/skeleton';
import type { Plan } from '@once-upon-a-diff/stories/chapters';
import type { StoryData } from '@once-upon-a-diff/contracts/types';

const plan = (dir: string): Plan =>
  JSON.parse(readFileSync(path.join(dir, 'chapters.json'), 'utf8'));

test('a story published with no text is unwritten and a skeleton; its text landing clears unwritten, not skeleton', async () => {
  const home = tmp('home');
  const dir = path.join(home, 'acme-widgets-7');
  githubStory(dir);
  const skeleton = plan(dir);
  assert.equal(unwrittenCount(dir), skeleton.chapters!.length, 'no chapter has text');
  noteSkeleton(dir, skeleton);
  assert.equal(skeletonKeys(dir).size, skeleton.chapters!.length);

  const bridge = await startBridge({ home });
  try {
    const before = (await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7')).body;
    const told = before.chapters.filter((chapter) => !chapter.auto);
    assert.ok(told.every((chapter) => chapter.unwritten && chapter.skeleton));
    assert.ok(
      before.chapters.filter((chapter) => chapter.auto).every((chapter) => !chapter.unwritten),
      'the leftover chapter has its own text',
    );

    skeleton.chapters![0].narrative = '### Chapter 1: Start\n\nTold.';
    writeJson(path.join(dir, 'chapters.json'), skeleton);
    noteSkeleton(dir, skeleton); // a later publish: the first chapter stays recorded
    const after = (await bridge.call<StoryData>('GET', '/api/stories/acme-widgets-7')).body;
    assert.equal(after.chapters[0].unwritten, undefined, 'its text landed');
    assert.equal(after.chapters[0].skeleton, true, 'but it was first published without it');
    assert.equal(after.chapters[1].unwritten, true);
    assert.equal(unwrittenCount(dir), skeleton.chapters!.length - 1);
  } finally {
    await bridge.close();
  }
});

test('a story with no skeleton.json and every chapter told has nothing unwritten or skeleton', () => {
  const dir = tmp('plain');
  writeJson(path.join(dir, 'chapters.json'), {
    chapters: [{ title: 'Chapter 1: A', narrative: 'Text.', files: ['a.js'] }],
  });
  assert.equal(unwrittenCount(dir), 0);
  noteSkeleton(dir, plan(dir));
  assert.equal(skeletonKeys(dir).size, 0);
});
