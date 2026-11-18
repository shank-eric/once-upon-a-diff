import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderBrief, agentCall, type BriefFacts } from '../src/features/runs/briefs.ts';

const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  shape: 'author',
  name: 'feat-x',
  sid: 'abcdef01',
  card: 'bl_abc123',
  title: 'A card',
  note: 'The note.\nTwo lines.',
  checkout: '/work/widgets',
  worktree: '/work/widgets-worktrees/feat-x',
  notes: '/work/widgets-worktrees/feat-x.notes.md',
  branch: 'feat/x',
  base: 'main',
  check: 'the tests pass',
  task: 'Build $it & "quote" `tick`.',
  ...over,
});

test('the author brief carries every slot: card, paths, check before task, note verbatim, beat, heavy, handback and stuck lines', () => {
  const text = renderBrief(facts());
  for (const phrase of [
    'You are feat-x, an author. Card bl_abc123: A card.',
    'Checkout: /work/widgets (read its AGENTS.md first).',
    'git worktree add -b feat/x /work/widgets-worktrees/feat-x main',
    'Notes file: /work/widgets-worktrees/feat-x.notes.md',
    'Success check (work until it passes): the tests pass',
    'Task: Build $it & "quote" `tick`.',
    'The note.\nTwo lines.',
    'Beats (M=6): 1 read, 2 plan, 3 code, 4 tests, 5 green, 6 done',
    'fnm exec --using=24 once-upon beat feat-x <N>/6 <step> "<few words>"',
    'plain `once-upon beat`',
    'ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy feat-x <command>',
    'plain `once-upon heavy',
    'run_in_background',
    'once-upon handback feat-x --sid abcdef01 --outcome "<one line>"',
    '--state waiting --outcome',
  ]) {
    assert.ok(text.includes(phrase), `the brief has: ${phrase}`);
  }
  assert.ok(text.indexOf('Success check') < text.indexOf('Task:'), 'the check comes first');
});

test('an absent note leaves the section out; an absent task leaves the line out', () => {
  const text = renderBrief(facts({ note: null, task: undefined }));
  assert.doesNotMatch(text, /Card note/);
  assert.doesNotMatch(text, /^Task:/m);
});

test('the plan brief posts beat 2 of 2, writes no code and hands back with --plan', () => {
  const text = renderBrief(facts({ shape: 'plan', check: undefined }));
  assert.match(text, /Beats \(M=2\): 1 read, 2 plan/);
  assert.match(text, /write no code/i);
  assert.match(text, /handback feat-x --sid abcdef01 --plan/);
  assert.doesNotMatch(text, /Success check/);
});

test('the critic brief names the diff, the findings file and the findings count', () => {
  const text = renderBrief(
    facts({ shape: 'critic', name: 'review-feat-x', out: '/r/x.md', check: undefined }),
  );
  assert.match(
    text,
    /git diff main\.\.\.HEAD/,
    'the branch’s own change, not main’s newer commits reversed',
  );
  assert.doesNotMatch(text, /main\.\.HEAD/);
  assert.match(text, /Write findings \(file:line, failure, confidence\) to \/r\/x\.md/);
  assert.match(text, /handback review-feat-x --sid abcdef01 --findings <N> --outcome/);
  assert.match(text, /Beats \(M=3\): 1 read, 2 review, 3 done/);
});

test('extra text is appended last, and the Agent call line is one line', () => {
  const text = renderBrief(facts({ extra: 'Relay line.' }));
  assert.ok(text.trimEnd().endsWith('Relay line.'));
  const call = agentCall({
    subagentType: 'once-upon-author',
    name: 'feat-x',
    model: 'sonnet',
    effort: 'high',
    description: 'feat-x: author for bl_abc123',
  });
  assert.equal(
    call,
    'AGENT-CALL subagent_type=once-upon-author name=feat-x model=sonnet effort=high run_in_background=true description="feat-x: author for bl_abc123"',
  );
});

test('no brief names a person or a personal path', () => {
  for (const shape of [
    'author',
    'plan',
    'build',
    'fixer',
    'critic',
    'storyteller',
    'helper',
    'writer',
    'finisher',
  ] as const) {
    const text = renderBrief(
      facts({
        shape,
        out: '/r/x.md',
        findingsFrom: '/f.md',
        dir: '/d',
        key: 'k',
        story: 's',
        fromNotes: '/n.md',
      }),
    );
    assert.doesNotMatch(text, /Eric|ClariFi|OneDrive|\.larmor|Larmor|shank-eric/, shape);
  }
});

test('every standing rule is in the agent’s own body or in its printed brief', () => {
  const root = path.resolve(import.meta.dirname, '../../../..');
  const body = (name: string) => readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8');
  assert.deepEqual(readdirSync(path.join(root, 'agents')).sort(), [
    'once-upon-author.md',
    'once-upon-critic.md',
    'once-upon-helper.md',
    'once-upon-storyteller.md',
  ]);
  // phrase -> where it must be found, for each shape: the type's body (B) and its brief (P)
  const rules: Array<[string, string, RegExp, 'B' | 'P']> = [
    ['once-upon-author', 'author', /AGENTS\.md first/, 'B'],
    ['once-upon-author', 'author', /line ranges/, 'B'],
    ['once-upon-author', 'author', /git stash/, 'B'],
    ['once-upon-author', 'author', /timeout 30/, 'B'],
    ['once-upon-author', 'author', /100 tool calls/, 'B'],
    ['once-upon-author', 'author', /--state waiting/, 'B'],
    ['once-upon-author', 'author', /heavy/i, 'B'],
    ['once-upon-author', 'author', /handback/, 'B'],
    ['once-upon-author', 'author', /beat/, 'B'],
    ['once-upon-author', 'author', /Node 24/, 'P'],
    ['once-upon-author', 'author', /once-upon heavy feat-x/, 'P'],
    ['once-upon-author', 'author', /once-upon handback feat-x/, 'P'],
    ['once-upon-critic', 'critic', /line ranges/, 'B'],
    ['once-upon-critic', 'critic', /handback/, 'B'],
    ['once-upon-critic', 'critic', /beat/, 'B'],
    ['once-upon-helper', 'helper', /handback/, 'B'],
    ['once-upon-helper', 'helper', /beat/, 'B'],
    ['once-upon-helper', 'helper', /--state waiting/, 'B'],
    ['once-upon-helper', 'helper', /line ranges/, 'B'],
    ['once-upon-helper', 'helper', /heavy/i, 'B'],
    ['once-upon-storyteller', 'storyteller', /handback/, 'B'],
    ['once-upon-storyteller', 'storyteller', /--state review/, 'B'],
    ['once-upon-storyteller', 'storyteller', /beat/, 'B'],
  ];
  for (const [type, shape, pattern, where] of rules) {
    const text = where === 'B' ? body(type) : renderBrief(facts({ shape: shape as 'author' }));
    assert.match(text, pattern, `${type} ${where}: ${pattern}`);
  }
  for (const type of [
    'once-upon-author',
    'once-upon-critic',
    'once-upon-helper',
    'once-upon-storyteller',
  ]) {
    assert.match(body(type), /git stash/, `${type}: never git stash`);
    assert.match(body(type), /timeout 30/, `${type}: probes under a timeout`);
  }
});

test('a helper brief carries the heavy lock line', () => {
  const text = renderBrief(facts({ shape: 'helper', name: 'check-feat-x', check: undefined }));
  assert.match(
    text,
    /ONCE_UPON_PATH="\$PATH" fnm exec --using=24 once-upon heavy check-feat-x <command>/,
  );
});

test('a fan-out storyteller parks at the skeleton in state plan with a fanout outcome; a plain one parks in review', () => {
  const fan = renderBrief(facts({ shape: 'storyteller', name: 'story-x', fanOut: true }));
  assert.match(
    fan,
    /handback story-x --sid abcdef01 --state plan --outcome "fanout <story id>: skeleton up/,
  );
  assert.match(
    fan,
    /--state review --outcome "<story id>"/,
    'the finisher’s parking is still review',
  );
  const plain = renderBrief(facts({ shape: 'storyteller', name: 'story-x' }));
  assert.doesNotMatch(plain, /--state plan/);
  assert.match(plain, /--state review --outcome "<story id>"/);
});

test('a storyteller or finisher brief names pr-draft only when the repo ships by PR; a fan-out skeleton never does', () => {
  for (const shape of ['storyteller', 'finisher'] as const) {
    assert.match(
      renderBrief(facts({ shape, name: 'story-x', prDraft: true })),
      /once-upon pr-draft/,
    );
    assert.doesNotMatch(renderBrief(facts({ shape, name: 'story-x', prDraft: false })), /pr-draft/);
    assert.doesNotMatch(renderBrief(facts({ shape, name: 'story-x' })), /pr-draft/);
  }
  const skeleton = renderBrief(
    facts({ shape: 'storyteller', name: 'story-x', fanOut: true, prDraft: true }),
  );
  assert.doesNotMatch(skeleton, /pr-draft/);
  assert.doesNotMatch(
    renderBrief(facts({ shape: 'author', name: 'a', prDraft: true })),
    /pr-draft/,
  );
});

test('rules for a general-purpose launch come before the extra text, labelled', () => {
  const text = renderBrief(
    facts({ rules: 'Never `git stash`.', extra: 'Forward results.', name: 'feat-x' }),
  );
  assert.match(text, /Standing rules[^\n]*:\nNever `git stash`\.\nForward results\.\n$/);
});
