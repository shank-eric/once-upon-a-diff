import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, localRepo, runCli, tmp } from './helpers.ts';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { StoryStore } from '@once-upon-a-diff/stories/store';

test('a local story records the branch --head names, not the checkout’s', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'stack/2', tip);
  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const branchOf = (head: string, id?: string) => {
    const made = createLocalStory({ home, repo, base, head, id });
    return {
      id: made.id,
      branch: JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8')).branch,
    };
  };
  const byName = branchOf('stack/2');
  assert.equal(byName.branch, 'stack/2', 'the branch Create pull request will push');
  assert.match(byName.id, /stack-2$/);
  assert.equal(branchOf('refs/heads/feature').branch, 'feature');
  assert.equal(branchOf('HEAD').branch, 'elsewhere');
});

test('a sha records the one local branch whose tip it is', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const meta = (head: string, id: string) => {
    const made = createLocalStory({ home, repo, base, head, id });
    return JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8'));
  };
  assert.equal(meta(tip, 'by-sha').branch, 'feature', 'the only branch at that commit');
  assert.equal(meta(tip.slice(0, 9), 'by-short').branch, 'feature', 'a short sha too');
  assert.equal(meta(tip.slice(0, 5), 'by-tiny').branch, 'feature', 'any abbreviation');
  git(repo, 'tag', 'v1', tip);
  assert.equal(meta('v1', 'by-tag').branch, 'feature', 'a tag at the tip');
  assert.equal(
    meta(git(repo, 'rev-parse', 'feature~1'), 'mid').branch,
    null,
    'no branch at a commit mid-branch',
  );
  assert.equal(meta(base, 'at-base').branch, 'elsewhere');
});

test('a sha two branches share takes the checkout’s branch when HEAD is there, else none', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'stack/2', tip);
  const made = createLocalStory({ home, repo, base, head: tip, id: 'on-head' });
  assert.equal(
    JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8')).branch,
    'feature',
  );
  assert.deepEqual(made.ambiguous, []);

  git(repo, 'switch', '-q', '-c', 'elsewhere', base);
  const tied = createLocalStory({ home, repo, base, head: tip, id: 'tied' });
  assert.equal(JSON.parse(readFileSync(path.join(tied.dir, 'meta.json'), 'utf8')).branch, null);
  assert.deepEqual(tied.ambiguous, ['feature', 'stack/2']);

  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--head',
    tip,
    '--id',
    'tied-cli',
    '--no-serve',
    '--no-open',
  ]);
  assert.match(cli.stderr, /is the tip of feature, stack\/2, so the story has no branch/);
});

test('a sha keeps its own default story id, so it never takes over the branch’s story', () => {
  const home = tmp('home');
  const { repo, base } = localRepo(); // on feature
  const tip = git(repo, 'rev-parse', 'HEAD');
  const byHead = createLocalStory({ home, repo, base });
  const bySha = createLocalStory({ home, repo, base, head: tip });
  assert.match(byHead.id, /-feature$/);
  assert.match(bySha.id, new RegExp(`-${tip.slice(0, 9)}$`));
  assert.notEqual(bySha.id, byHead.id);
  const metaOf = (made: { dir: string }) =>
    JSON.parse(readFileSync(path.join(made.dir, 'meta.json'), 'utf8'));
  assert.equal(metaOf(bySha).branch, 'feature', 'but it still records the branch for the buttons');
  assert.equal(metaOf(byHead).head, 'HEAD', 'and the branch’s story still follows HEAD');
});

test('telling a story again with no chapters handed in fails on a corrupt chapters.json instead of serving an empty plan', () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const made = createLocalStory({ home, repo, base });
  const chaptersFile = path.join(made.dir, 'chapters.json');
  assert.ok(JSON.parse(readFileSync(chaptersFile, 'utf8')).chapters.length > 0);
  writeFileSync(chaptersFile, '{not json');
  assert.throws(() => createLocalStory({ home, repo, base, id: made.id }), SyntaxError);
  assert.equal(
    readFileSync(chaptersFile, 'utf8'),
    '{not json',
    'the corrupt file is left for a person to see',
  );
});

test('once-upon local with --chapters prints the story checks without changing the exit status', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('chapters'), 'chapters.json');
  writeFileSync(
    chapters,
    JSON.stringify({
      title: 'Two files',
      refs: [],
      overview: 'Told badly: a narrative with no heading.',
      chapters: [
        {
          title: 'The change',
          key: 'change',
          summary: 'one and two.',
          narrative: 'No heading and no closing line.',
          files: ['one.txt', 'lib/two.js', 'gone.txt'],
          refs: [],
        },
      ],
    }),
  );
  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--id',
    'checked',
    '--no-serve',
    '--no-open',
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stderr, /Story checks: 1 fail, \d+ warns/);
  assert.match(cli.stderr, /^fail shape chapter 1: /m);
});

test('once-upon local --chapters still publishes and exits 0 when the findings cannot be computed', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('chapters'), 'chapters.json');
  writeFileSync(
    chapters,
    JSON.stringify({
      title: 'Two files',
      refs: [],
      overview: 'A headline that is a list, not a sentence.',
      chapters: [
        {
          title: 'The change',
          key: 'change',
          headline: ['a', 'b'],
          summary: 'one and two.',
          narrative: '### Chapter 1: The change\n\nThe words.',
          files: ['one.txt', 'lib/two.js', 'gone.txt'],
          refs: [],
        },
      ],
    }),
  );
  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--id',
    'unreadable',
    '--no-serve',
    '--no-open',
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stderr, /^findings: could not be computed: .+$/m);
  assert.doesNotMatch(cli.stderr, /\n\s+at /);
});

test('once-upon local --chapters expands hunk ids and notes how long it took next to the chapters file', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('chapters'), 'chapters.json');
  writeFileSync(
    chapters,
    JSON.stringify({
      chapters: [
        {
          title: 'The change',
          key: 'change',
          headline: 'It changed.',
          summary: 'one and two.',
          narrative: '### Chapter 1: The change\n\nThe words.',
          files: ['one.txt', 'lib/two.js', 'gone.txt'],
          hunks: ['h1', 'h2', 'h3'],
        },
      ],
    }),
  );
  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--id',
    'hunked',
    '--no-serve',
    '--no-open',
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  const written = JSON.parse(readFileSync(chapters, 'utf8'));
  assert.deepEqual(
    written.chapters[0].refs.map((ref: { id: string }) => ref.id),
    ['h1', 'h2', 'h3'],
  );
  const lines = readFileSync(path.join(path.dirname(chapters), 'timings.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].command, 'local');
  assert.equal(lines[0].expanded, 3);
  assert.equal(typeof lines[0].ms, 'number');
});

test('once-upon local --chapters marks a refused telling failed in the timings next to the chapters file', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('chapters-refused'), 'chapters.json');
  writeFileSync(
    chapters,
    JSON.stringify({
      chapters: [{ title: 'The change', files: ['one.txt'], hunks: ['h99'] }],
    }),
  );
  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--no-serve',
    '--no-open',
  ]);
  assert.notEqual(cli.code, 0);
  const lines = readFileSync(path.join(path.dirname(chapters), 'timings.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].command, 'local');
  assert.equal(lines[0].failed, true);
  assert.equal(typeof lines[0].ms, 'number');
});

test('once-upon local --chapters refuses a ref on lines in no hunk, and publishes nothing', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  const chapters = path.join(tmp('chapters-offpage'), 'chapters.json');
  writeFileSync(
    chapters,
    JSON.stringify({
      refs: [],
      chapters: [
        {
          title: 'The change',
          key: 'change',
          narrative: '### Chapter 1: The change\n\nIt [lands somewhere](ref:far).',
          files: ['one.txt'],
          refs: [{ id: 'far', path: 'one.txt', side: 'R', start: 900, end: 910 }],
        },
      ],
    }),
  );
  const cli = await runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--id',
    'offpage',
    '--no-serve',
    '--no-open',
  ]);
  assert.notEqual(cli.code, 0);
  assert.match(
    cli.stderr,
    /chapter 1: ref "far" \(one\.txt:900-910\) is on lines that are in no hunk/,
  );
  assert.equal(new StoryStore({ home }).dirOf('offpage'), null, 'nothing was published');
});

test('once-upon local --chapters refused a second time leaves anchors.json byte for byte as it was', async () => {
  const home = tmp('home');
  const world = localRepo();
  const good = { refs: [], chapters: [told(['one.txt', 'lib/two.js', 'gone.txt'])] };
  const first = await tellLocal(home, world, good, 'anch');
  assert.equal(first.code, 0, first.stderr);
  const dir = new StoryStore({ home }).dirOf('anch') as string;
  const file = path.join(dir, 'anchors.json');
  const before = readFileSync(file, 'utf8');
  const refused = await tellLocal(home, world, { refs: [], chapters: [told(['one.txt'])] }, 'anch');
  assert.notEqual(refused.code, 0);
  assert.equal(readFileSync(file, 'utf8'), before);
});

/** Runs `once-upon local --chapters` over `repo` with `plan`, as a story named `id`. */
async function tellLocal(
  home: string,
  { repo, base }: { repo: string; base: string },
  plan: unknown,
  id: string,
  ...more: string[]
) {
  const chapters = path.join(tmp(`chapters-${id}`), 'chapters.json');
  writeFileSync(chapters, JSON.stringify(plan));
  return runCli(home, [
    'local',
    '--repo',
    repo,
    '--base',
    base,
    '--chapters',
    chapters,
    '--id',
    id,
    '--no-serve',
    '--no-open',
    ...more,
  ]);
}

const told = (files: unknown[], key = 'change') => ({
  key,
  title: 'The change',
  summary: 'What changed.',
  narrative: '### Chapter 1: The change\n\nIt changed.',
  files,
  refs: [],
});

test('once-upon local --chapters refuses a file in no chapter, as the build does, and --allow-missing lets it through', async () => {
  const home = tmp('home');
  const world = localRepo();
  const plan = { refs: [], chapters: [told(['one.txt', 'lib/two.js'])] };
  const refused = await tellLocal(home, world, plan, 'unplaced');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /file placement:\n {2}- 1 files are in no chapter: gone\.txt/);
  assert.equal(new StoryStore({ home }).dirOf('unplaced'), null, 'nothing was published');
  const allowed = await tellLocal(home, world, plan, 'unplaced', '--allow-missing');
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stderr, /1 files aren't in a chapter/);
});

test('once-upon local --chapters refuses a chapter naming a file the diff does not have', async () => {
  const home = tmp('home');
  const cli = await tellLocal(
    home,
    localRepo(),
    { refs: [], chapters: [told(['one.txt', 'lib/two.js', 'gone.txt', 'nope.txt'])] },
    'misplaced',
  );
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /chapter 1 names nope\.txt, which is not in the diff/);
  assert.equal(new StoryStore({ home }).dirOf('misplaced'), null);
});

test('once-upon local --chapters refuses a file left partial in the last chapter that lists it', async () => {
  const home = tmp('home');
  const world = localRepo();
  const plan = {
    refs: [],
    chapters: [told([{ rel: 'one.txt', partial: true }, 'lib/two.js', 'gone.txt'])],
  };
  const cli = await tellLocal(home, world, plan, 'partial');
  assert.notEqual(cli.code, 0);
  assert.match(
    cli.stderr,
    /one\.txt is partial in chapter 1, the last chapter that lists it, so no chapter finishes it/,
  );
  assert.equal(new StoryStore({ home }).dirOf('partial'), null);
  plan.chapters.push(told(['one.txt'], 'finish'));
  const finished = await tellLocal(home, world, plan, 'partial');
  assert.equal(finished.code, 0, finished.stderr);
});

test('once-upon local --chapters refuses a big file whose hunk no chapter points at, and --allow-uncovered publishes it anyway', async () => {
  const home = tmp('home');
  const { repo, base } = localRepo();
  writeFileSync(
    path.join(repo, 'big.txt'),
    Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join(''),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'add big');
  const plan = { refs: [], chapters: [told(['one.txt', 'lib/two.js', 'gone.txt', 'big.txt'])] };
  const refused = await tellLocal(home, { repo, base }, plan, 'uncovered');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /hunks not covered: 1 in 1 files/);
  assert.match(refused.stderr, /big\.txt/);
  assert.equal(new StoryStore({ home }).dirOf('uncovered'), null);
  const whole = {
    refs: [],
    chapters: [told(['one.txt', 'lib/two.js', 'gone.txt', { rel: 'big.txt', whole: true }])],
  };
  const told_ = await tellLocal(home, { repo, base }, whole, 'uncovered');
  assert.equal(told_.code, 0, told_.stderr);
  const allowed = await tellLocal(
    home,
    { repo, base },
    plan,
    'uncovered-anyway',
    '--allow-uncovered',
  );
  assert.equal(allowed.code, 0, allowed.stderr);
});
