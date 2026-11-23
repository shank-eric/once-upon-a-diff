/**
 * The one answer to "how many slots is an editor using": the authors it controls that are working (running, at the plan
 * check, or fixing), by the session their run was launched from (recorded on the run), else by their sid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { AgentRegistry } from '../src/records/agents/registry.ts';
import { DEFAULT_SLOTS, slotsInUse } from '../src/queues/backlog/slots.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60000);
const EDITOR_SID = 'abcdef01';
const EDITOR_SESSION = `${EDITOR_SID}-1111-4222-8333-444444444444`;

function world() {
  const home = tmp('slots');
  const registry = new AgentRegistry(home);
  registry.start({
    name: 'editor-one',
    sid: EDITOR_SID,
    session: EDITOR_SESSION,
    kind: 'editor',
    task: 'queue',
    slots: 3,
    at: ago(600),
  });
  const author = (name: string, sid = EDITOR_SID, minutes = 60) =>
    registry.start({ name, sid, kind: 'author', task: name, at: ago(minutes) });
  const answer = () => {
    const agents = registry.agents();
    const editor = agents.find((one) => one.name === 'editor-one');
    return slotsInUse(editor as NonNullable<typeof editor>, agents, NOW.getTime());
  };
  return { registry, author, answer };
}

test('running, plan and fixing authors hold a slot; waiting, review and finished ones, critics and helpers do not', () => {
  const { registry, author, answer } = world();
  author('a-running');
  author('b-plan');
  registry.state('b-plan', { state: 'plan', at: ago(50) });
  author('c-fixing');
  registry.state('c-fixing', { state: 'fixing', findings: 2, at: ago(50) });
  author('d-waiting');
  registry.state('d-waiting', { state: 'waiting', at: ago(50) });
  author('e-review');
  registry.state('e-review', { state: 'review', at: ago(50) });
  author('f-done');
  registry.finish('f-done', { at: ago(40) });
  registry.start({ name: 'g-critic', sid: EDITOR_SID, kind: 'critic', task: 'x', at: ago(30) });
  registry.start({ name: 'h-helper', sid: EDITOR_SID, kind: 'helper', task: 'x', at: ago(30) });
  const found = answer();
  assert.equal(found.slots, 3);
  assert.equal(found.in_use, 3);
  assert.equal(found.free, 0);
  assert.deepEqual(found.authors.map((one) => one.name).sort(), [
    'a-running',
    'b-plan',
    'c-fixing',
    'd-waiting',
    'e-review',
  ]);
});

test('an author silent for a day is dead and holds nothing, a beat is a sign of life; another editor session’s author is not this editor’s', () => {
  const { registry, author, answer } = world();
  author('ou-silent', EDITOR_SID, 30 * 60);
  author('ou-beating', EDITOR_SID, 31 * 60);
  registry.beat('ou-beating', { n: 2, of: 6, step: 'read', at: ago(20 * 60) });
  author('ou-other', '22222222');
  author('ou-live');
  const found = answer();
  assert.deepEqual(found.authors.map((one) => one.name).sort(), ['ou-beating', 'ou-live']);
  assert.equal(found.free, 1);
});

test('an author launched from another session is the editor’s when its run records the editor’s session', () => {
  const { registry, author, answer } = world();
  // dispatch records the full session it launched the run from; no claim row says it
  registry.start({
    name: 'ou-launched',
    sid: '22222222',
    session: EDITOR_SESSION,
    kind: 'author',
    task: 'x',
    at: ago(60),
  });
  // a run launched from another session (not an editor's) with its own sid is nobody's here
  registry.start({
    name: 'ou-elsewhere',
    sid: '33333333',
    session: '99999999-1111-4222-8333-444444444444',
    kind: 'author',
    task: 'x',
    at: ago(60),
  });
  author('ou-by-sid');
  assert.deepEqual(
    answer()
      .authors.map((one) => one.name)
      .sort(),
    ['ou-by-sid', 'ou-launched'],
  );
});

test('one author fills one editor’s pool: the session its run was launched from, else its sid', () => {
  const { registry, author } = world();
  const second = '22222222-1111-4222-8333-444444444444';
  registry.start({
    name: 'editor-two',
    sid: '22222222',
    session: second,
    kind: 'editor',
    task: 'queue',
    slots: 2,
    at: ago(600),
  });
  const count = (name: string) => {
    const agents = registry.agents();
    const found = agents.find((one) => one.name === name);
    return slotsInUse(found as NonNullable<typeof found>, agents, NOW.getTime()).authors.map(
      (one) => one.name,
    );
  };
  // the first editor's sid, but launched from the second editor's session: the session wins
  registry.start({
    name: 'ou-shared',
    sid: EDITOR_SID,
    session: second,
    kind: 'author',
    task: 'x',
    at: ago(60),
  });
  // the first editor's sid, launched from a session that is no editor: the sid's editor
  registry.start({
    name: 'ou-main',
    sid: EDITOR_SID,
    session: '99999999-1111-4222-8333-444444444444',
    kind: 'author',
    task: 'x',
    at: ago(60),
  });
  author('ou-plain');
  assert.deepEqual(count('editor-one').sort(), ['ou-main', 'ou-plain']);
  assert.deepEqual(count('editor-two'), ['ou-shared']);
});

test('an editor registered with no slots has the default', () => {
  assert.equal(DEFAULT_SLOTS, 3);
});
